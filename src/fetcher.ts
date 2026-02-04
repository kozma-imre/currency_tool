import axios from 'axios';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initFirestore, writeLatest, writeSnapshot, writeMonitoringLog } from './firestore';
import { sendTelegramAlert } from './notify/telegram';
import type { RatesResult } from './types';

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price';
const COINGECKO_LIST_URL = 'https://api.coingecko.com/api/v3/coins/list';
const COINGECKO_MARKETS_URL = 'https://api.coingecko.com/api/v3/coins/markets';
const ECB_URL = 'https://api.exchangerate.host/latest';
const BINANCE_URL = 'https://api.binance.com/api/v3/ticker/price';

const COINGECKO_COINS_CACHE_TTL = Number(process.env.COINGECKO_COINS_CACHE_TTL) || 24 * 60 * 60; // seconds
const COINGECKO_COINS_CACHE_FILE = path.join(os.tmpdir(), 'coingecko-coins.json');

const COINGECKO_MAX_IDS_PER_REQUEST = Number(process.env.COINGECKO_MAX_IDS_PER_REQUEST) || 50;
const COINGECKO_BATCH_DELAY_MS = Number(process.env.COINGECKO_BATCH_DELAY_MS) || 300;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchSupportedCoinIds(): Promise<Set<string>> {
  // During tests, skip cache to avoid inter-test file pollution and always hit the mocked endpoint
  if (process.env.NODE_ENV === 'test') {
    const res = await retry(() => axios.get(COINGECKO_LIST_URL, { timeout: 10000 }), 2);
    const data = res.data;
    return new Set((data || []).map((c: any) => c.id));
  }

  try {
    if (fs.existsSync(COINGECKO_COINS_CACHE_FILE)) {
      const raw = fs.readFileSync(COINGECKO_COINS_CACHE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.ts && (Date.now() - parsed.ts) < COINGECKO_COINS_CACHE_TTL * 1000) {
        return new Set((parsed.data || []).map((c: any) => c.id));
      }
    }
  } catch (e) {
    // ignore cache read errors
  }
  const res = await retry(() => axios.get(COINGECKO_LIST_URL, { timeout: 10000 }), 2);
  const data = res.data;
  try {
    fs.writeFileSync(COINGECKO_COINS_CACHE_FILE, JSON.stringify({ ts: Date.now(), data }), 'utf8');
  } catch (e) {
    // ignore cache write errors
  }
  return new Set((data || []).map((c: any) => c.id));
}

async function fetchTopCoinIds(n = 100): Promise<Set<string>> {
  // Fetch top-N coins by market cap using /coins/markets and cache per-n
  const cacheFile = path.join(os.tmpdir(), `coingecko-top-${n}.json`);
  const ttl = COINGECKO_COINS_CACHE_TTL;
  if (process.env.NODE_ENV === 'test') {
    const res = await retry(() => axios.get(COINGECKO_MARKETS_URL, { timeout: 10000, params: { vs_currency: 'usd', order: 'market_cap_desc', per_page: n, page: 1, sparkline: false } }), 2);
    const data = res.data;
    return new Set((data || []).map((c: any) => c.id));
  }

  try {
    if (fs.existsSync(cacheFile)) {
      const raw = fs.readFileSync(cacheFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.ts && (Date.now() - parsed.ts) < ttl * 1000) {
        return new Set((parsed.data || []).map((c: any) => c.id));
      }
    }
  } catch (e) {
    // ignore
  }

  const res = await retry(() => axios.get(COINGECKO_MARKETS_URL, { timeout: 10000, params: { vs_currency: 'usd', order: 'market_cap_desc', per_page: n, page: 1, sparkline: false } }), 2);
  const data = res.data;
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({ ts: Date.now(), data }), 'utf8');
  } catch (e) {
    // ignore
  }
  return new Set((data || []).map((c: any) => c.id));
}

const COINGECKO_MAP: Record<string, string> = { bitcoin: 'BTC', ethereum: 'ETH' };
const BINANCE_MAP: Record<string, string> = { BTCUSDT: 'BTC', ETHUSDT: 'ETH' };

function truncateRaw(obj: any, max = 2000) {
  try {
    const s = JSON.stringify(obj);
    return s.length > max ? s.slice(0, max) + '...[truncated]' : s;
  } catch (e) {
    return String(obj).slice(0, max);
  }
}

async function fetchCryptoFromCoingecko(cryptoIds: string[], vsCurrencies: string[]) {
  // Chunk ids into batches to avoid large single requests and rate-limits
  const headers: Record<string, string> = {};
  if (process.env.COINGECKO_API_KEY) {
    headers['X-CG-PRO-API-KEY'] = process.env.COINGECKO_API_KEY;
  }

  const out: Record<string, any> = {};
  const collectedHeaders: Record<string, any> = {};
  const batches: string[][] = [];
  for (let i = 0; i < cryptoIds.length; i += COINGECKO_MAX_IDS_PER_REQUEST) {
    batches.push(cryptoIds.slice(i, i + COINGECKO_MAX_IDS_PER_REQUEST));
  }

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    if (!batch) continue;
    const params = { ids: batch.join(','), vs_currencies: vsCurrencies.join(',') };
    const config: any = { params, timeout: 10000 };
    if (Object.keys(headers).length) config.headers = headers;

    // Use retry but also honor Retry-After header on 429
    try {
      await retry(async () => {
        try {
          const res = await axios.get(COINGECKO_URL, config);
          Object.assign(out, res.data || {});
          if (res && res.headers) Object.assign(collectedHeaders, res.headers);
          return res;
        } catch (err: any) {
          const status = err?.response?.status;
          const rh = err?.response?.headers?.['retry-after'];
          if (status === 429 && rh) {
            const waitSec = Number(rh) || 1;
            // Respect Retry-After before retrying
            await sleep(waitSec * 1000 + 250);
          }
          // rethrow so retry() wrapper can apply backoff
          throw err;
        }
      }, 2);
    } catch (err: any) {
      // If a batch fails even after retries, log and continue with partial results
      console.warn('CoinGecko batch failed for ids', batch, 'error:', err?.message || err);
    }

    // small delay between batches to avoid bursts
    if (bi < batches.length - 1) await sleep(COINGECKO_BATCH_DELAY_MS);
  }

  // determine missing ids
  const missing: string[] = cryptoIds.filter(id => !(id in out));
  return { provider: 'coingecko', data: out, headers: collectedHeaders, missing };
}

async function fetchCryptoFromBinance(symbols: string[]) {
  // Binance returns per-symbol; fetch sequentially and build a structure similar to CoinGecko
  const out: Record<string, any> = {};
  const binanceHeaders: Record<string, string> | undefined = process.env.BINANCE_KEY ? { 'X-MBX-APIKEY': process.env.BINANCE_KEY } : undefined;
  for (const sym of symbols) {
    const pair = sym + 'USDT';
    const config: any = { params: { symbol: pair }, timeout: 10000 };
    if (binanceHeaders) config.headers = binanceHeaders;
    const res = await axios.get(BINANCE_URL, config);
    const price = Number(res.data.price);
    const mapped = BINANCE_MAP[pair] ?? sym;
    out[mapped] = { usd: price, eur: undefined };
  }
  return { provider: 'binance', data: out, headers: {} };
}

async function fetchFiat() {
  const res = await axios.get(ECB_URL, { timeout: 10000 });
  return res.data; // { base, date, rates: { USD: 1.08, ... } }
}

async function retry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries) throw err;
      attempt++;
      const delay = Math.pow(2, attempt) * 100;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export async function fetchAndStoreRates() {
  await initFirestore();
  let runId: string;
  try {
    runId = (crypto as any).randomUUID ? (crypto as any).randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  } catch (e) {
    runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  const start = Date.now();

  // Read configured cryptos / fiats from env (defaults)
  const rawConfigured = (process.env.CRYPTO_IDS ?? 'bitcoin,ethereum').trim();
  const fiatCurrencies = (process.env.FIAT_CURRENCIES ?? 'usd,eur').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  // Support top-N via `CRYPTO_IDS=top:100` or env `CRYPTO_USE_TOP_N=100`
  let configuredIds: string[] = [];
  const topMatch = /^top:(\d+)$/i.exec(rawConfigured);
  const topEnvN = process.env.CRYPTO_USE_TOP_N ? Number(process.env.CRYPTO_USE_TOP_N) : undefined;
  if (topMatch || topEnvN) {
    const n = topMatch ? Number(topMatch[1]) : (topEnvN || 100);
    const topSet = await fetchTopCoinIds(n);
    configuredIds = Array.from(topSet);
  } else {
    configuredIds = rawConfigured.split(',').map(s => s.trim()).filter(Boolean);
  }
  // For CoinGecko we only request common fiat bases (usd, eur) to avoid unsupported fiats; ECB will be used to expand others
  const coinGeckoFiats = fiatCurrencies.filter(f => ['usd', 'eur'].includes(f));
  if (!coinGeckoFiats.length) {
    coinGeckoFiats.push('usd', 'eur'); // ensure at least USD/EUR
  }

  // Binance symbols: explicit override or derive from COINGECKO_MAP or uppercase ids
  const configuredSymbols = (process.env.CRYPTO_SYMBOLS && process.env.CRYPTO_SYMBOLS.split(',').map(s => s.trim()).filter(Boolean)) || configuredIds.map(id => COINGECKO_MAP[id] ?? id.toUpperCase());

  let provider = 'coingecko';
  let cryptoResult: any;

  // Validate configured CRYPTO_IDS against CoinGecko /coins/list
  const supportedIds = await fetchSupportedCoinIds();
  const filteredIds = configuredIds.filter(id => supportedIds.has(id));

  if (filteredIds.length === 0) {
    console.warn('No configured CRYPTO_IDS are supported by CoinGecko; skipping CoinGecko and using Binance fallback.');
    try {
      cryptoResult = await retry(() => fetchCryptoFromBinance(configuredSymbols), 2);
      provider = 'binance';
    } catch (err2) {
      const durationMs = Date.now() - start;
      await writeMonitoringLog({ runId, provider: 'coingecko', operation: 'fetch', durationMs, status: 'error', error: String(err2), timestamp: new Date().toISOString() });
      throw err2;
    }
  } else {
    if (filteredIds.length < configuredIds.length) {
      const dropped = configuredIds.filter(id => !supportedIds.has(id));
      console.warn('Dropping unsupported CoinGecko ids:', dropped);
    }
    try {
      // Use CoinGecko in batched mode; it will return partial data + `missing` ids if some batches failed
      cryptoResult = await fetchCryptoFromCoingecko(filteredIds, coinGeckoFiats);
      // If CoinGecko returned only partial results, attempt Binance fallback for missing symbols
      const missingIds: string[] = cryptoResult.missing || [];
      const succeededCount = Object.keys(cryptoResult.data || {}).length;
      if (succeededCount === 0 && missingIds.length) {
        // no data from CoinGecko, treat as full failure and fallback to Binance entirely
        try {
          cryptoResult = await retry(() => fetchCryptoFromBinance(configuredSymbols), 2);
          provider = 'binance';
        } catch (err2) {
          const durationMs = Date.now() - start;
          await writeMonitoringLog({ runId, provider: 'coingecko', operation: 'fetch', durationMs, status: 'error', error: String(err2), timestamp: new Date().toISOString() });
          throw err2;
        }
      } else if (missingIds.length) {
        const missingSymbols = missingIds.map(id => COINGECKO_MAP[id] ?? id.toUpperCase());
        try {
          const binRes = await retry(() => fetchCryptoFromBinance(missingSymbols), 2);
          // merge binance results in
          cryptoResult.data = { ...(cryptoResult.data || {}), ...(binRes.data || {}) };
          provider = 'coingecko+binance';
        } catch (err2: any) {
          // If Binance is geo-blocked (451), send alert and proceed with partial CoinGecko data
          const status = err2?.response?.status;
          if (status === 451) {
            console.warn('Binance returned 451 (restricted location). Proceeding with partial CoinGecko data.');
            try {
              await sendTelegramAlert(`Binance returned 451 (restricted location) while fetching fallback for missing symbols: ${missingSymbols.join(', ')}. Proceeding with partial CoinGecko data.`);
            } catch (e) {
              // ignore alert failures
            }
            // proceed using partial coinGecko data
          } else {
            const durationMs = Date.now() - start;
            await writeMonitoringLog({ runId, provider: 'coingecko', operation: 'fetch', durationMs, status: 'error', error: String(err2), timestamp: new Date().toISOString() });
            throw err2;
          }
        }
      }
    } catch (err) {
      console.warn('CoinGecko fetch failed entirely, trying Binance fallback', err);
      try {
        cryptoResult = await retry(() => fetchCryptoFromBinance(configuredSymbols), 2);
        provider = 'binance';
      } catch (err2) {
        const durationMs = Date.now() - start;
        await writeMonitoringLog({ runId, provider: 'coingecko', operation: 'fetch', durationMs, status: 'error', error: String(err2), timestamp: new Date().toISOString() });
        throw err2;
      }
    }
  }

  const fiat = await retry(fetchFiat, 2);

  const rates: RatesResult = {};
  // Normalize raw provider result into symbol -> { usd?, eur? }
  if (cryptoResult.provider === 'coingecko') {
    for (const [id, vals] of Object.entries(cryptoResult.data)) {
      const symbol = COINGECKO_MAP[id] ?? id.toUpperCase();
      rates[symbol] = vals as any; // e.g. { usd: 123, eur: 110 }
    }
  } else {
    for (const [symbol, vals] of Object.entries(cryptoResult.data)) {
      rates[symbol] = vals as any; // binance returns { usd: price, eur: undefined }
    }
  }

  // Expand rates to include all requested fiatCurrencies using ECB conversions if necessary
  const ecbRates: Record<string, number> = (fiat && fiat.rates) ? fiat.rates : {};
  const ecbBase = (fiat && fiat.base) ? fiat.base.toUpperCase() : 'EUR';

  function convertUsingEcb(value: number | undefined, from: string | undefined, to: string): number | undefined {
    if (value == null || !from) return undefined;
    const upperTo = to.toUpperCase();
    const upperFrom = from.toUpperCase();
    // If ECB base is same as 'from' or 'to', compute relative
    // ECB provides rates as: rate[X] = X per 1 EUR (if base EUR), so conversion factor from 'from' to 'to' is rate[to]/rate[from]
    const rateTo = ecbRates[upperTo];
    const rateFrom = ecbRates[upperFrom];
    if (rateTo == null || rateFrom == null) return undefined;
    return value * (rateTo / rateFrom);
  }

  // For each symbol, for each requested fiat, fill missing values by converting from usd or eur
  for (const [sym, vals] of Object.entries(rates)) {
    const target: Record<string, any> = {};
    // copy existing known lowercase keys
    const existingLower: Record<string, number> = {};
    for (const [k, v] of Object.entries(vals as any)) {
      existingLower[String(k).toLowerCase()] = v as number;
    }
    // Try to ensure usd and eur exist by using what is available
    for (const base of ['usd', 'eur']) {
      if (existingLower[base] == null) {
        // try to derive from the other if possible using ECB
        const other = base === 'usd' ? 'eur' : 'usd';
        if (existingLower[other] != null) {
          const conv = convertUsingEcb(existingLower[other], other, base);
          if (conv != null) existingLower[base] = conv;
        }
      }
    }
    // For every requested fiat currency, compute final value
    for (const fiatTarget of fiatCurrencies) {
      if (existingLower[fiatTarget] != null) {
        target[fiatTarget] = existingLower[fiatTarget];
        continue;
      }
      // Prefer converting from USD then EUR
      let computed: number | undefined = undefined;
      if (existingLower['usd'] != null) {
        computed = convertUsingEcb(existingLower['usd'], 'USD', fiatTarget);
      }
      if (computed == null && existingLower['eur'] != null) {
        computed = convertUsingEcb(existingLower['eur'], 'EUR', fiatTarget);
      }
      if (computed != null) target[fiatTarget] = Number(computed);
    }
    rates[sym] = target as any;
  }

  const headersObj = (cryptoResult.headers && typeof (cryptoResult.headers as any).toJSON === 'function')
    ? (cryptoResult.headers as any).toJSON()
    : JSON.parse(JSON.stringify(cryptoResult.headers ?? {}));

  // Whitelist headers we want to keep in the lightweight `latest` doc
  const HEADER_WHITELIST = ['etag', 'cache-control', 'date', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'];
  const filteredHeaders: Record<string, any> = {};
  for (const [k, v] of Object.entries(headersObj || {})) {
    const lk = String(k).toLowerCase();
    if (HEADER_WHITELIST.includes(lk)) {
      filteredHeaders[lk] = v;
    }
  }

  const fetchedAt = new Date().toISOString();

  // Minimal payload for `latest` — small and stable for clients
  const latestPayload = {
    provider,
    timestamp: fetchedAt,
    rates,
    meta: {
      fetchedAt,
      fiatBase: fiat?.base ?? 'EUR',
      headers: filteredHeaders,
    },
  };

  // Full snapshot with raw response and more verbose metadata for debugging/audit
  const snapshotPayload = {
    provider,
    timestamp: fetchedAt,
    rates,
    meta: {
      fetchedAt,
      fiatBase: fiat?.base ?? 'EUR',
      headers: headersObj,
      rawResponse: JSON.stringify(cryptoResult.data),
    },
  };

  const durationMs = Date.now() - start;
  await writeMonitoringLog({ runId, provider, operation: 'fetch_and_store', durationMs, status: 'ok', meta: { fetchedAt }, timestamp: new Date().toISOString() });

  await writeLatest(latestPayload);
  await writeSnapshot(snapshotPayload, new Date());

  return latestPayload;
}
