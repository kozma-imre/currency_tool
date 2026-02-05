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
const COINGECKO_COINS_CACHE_LIMIT = Number(process.env.COINGECKO_COINS_CACHE_LIMIT) || 1000;

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
  const data = Array.isArray(res.data) ? res.data : [];
  // Limit cached set to a reasonable size to avoid huge tmp files and speed lookups
  const limited = data.slice(0, COINGECKO_COINS_CACHE_LIMIT);
  try {
    fs.writeFileSync(COINGECKO_COINS_CACHE_FILE, JSON.stringify({ ts: Date.now(), data: limited }), 'utf8');
  } catch (e) {
    // ignore cache write errors
  }
  return new Set((limited || []).map((c: any) => c.id));
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

  try {
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
        // If a batch fails even after retries, attempt to isolate invalid ids if we see a 400
        if (err?.response?.status === 400) {
          console.warn('CoinGecko batch returned 400; isolating invalid ids in batch', batch);
          try {
            const { validData, invalidIds } = await isolateInvalidIds(batch, vsCurrencies, headers);
            // Merge back any valid per-id data
            Object.assign(out, validData);
            if (invalidIds.length) {
              console.warn('Dropping unsupported/invalid CoinGecko ids:', invalidIds);
              try {
                await sendTelegramAlert(`Dropped unsupported CoinGecko ids during fetch: ${invalidIds.join(', ')}`);
              } catch (e) {
                // ignore telegram failures
              }
            }
          } catch (innerErr: any) {
            console.warn('Error during batch isolation for CoinGecko', (innerErr as any).message || String(innerErr));
          }
        } else {
          console.warn('CoinGecko batch failed for ids', batch, 'error:', (err as any).message || String(err));
        }
      }

      // small delay between batches to avoid bursts
      if (bi < batches.length - 1) await sleep(COINGECKO_BATCH_DELAY_MS);
    }
  } catch (err: any) {
    // Unexpected global error while attempting to fetch CoinGecko; return whatever partial data we have
    console.warn('CoinGecko fetch experienced unexpected error; returning partial results', (err as any).message || String(err));
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

// CoinPaprika is a public API we use as a fallback. We search by symbol then fetch tickers.
async function fetchCryptoFromCoinPaprika(symbols: string[]) {
  const out: Record<string, any> = {};
  if (!symbols || symbols.length === 0) return { provider: 'coinpaprika', data: out, headers: {} };
  for (const symbol of symbols) {
    try {
      // search for coin by symbol
      const searchRes = await axios.get('https://api.coinpaprika.com/v1/search', { params: { query: symbol, limit: 5, type: 'coins' }, timeout: 10000 });
      const results = searchRes.data && searchRes.data.coins ? searchRes.data.coins : searchRes.data || [];
      let coinEntry: any = null;
      if (Array.isArray(results)) {
        coinEntry = results.find((r: any) => String(r.symbol).toUpperCase() === String(symbol).toUpperCase()) || results[0];
      }
      if (!coinEntry || !coinEntry.id) {
        // unable to find mapping for this symbol
        continue;
      }
      const tickerRes = await axios.get(`https://api.coinpaprika.com/v1/tickers/${coinEntry.id}`, { timeout: 10000 });
      const quotes = tickerRes.data && tickerRes.data.quotes ? tickerRes.data.quotes : {};
      const usd = quotes.USD ? Number(quotes.USD.price) : undefined;
      const eur = quotes.EUR ? Number(quotes.EUR.price) : undefined;
      out[String(symbol).toUpperCase()] = { usd, eur };
    } catch (err: any) {
      console.warn('CoinPaprika request failed for symbol', symbol, 'error:', (err as any).message || String(err));
      // continue with other symbols
    }
  }
  return { provider: 'coinpaprika', data: out, headers: {} };
}

// Helper: isolate invalid ids when a batch returns 400 by checking ids individually
async function isolateInvalidIds(batch: string[], vsCurrencies: string[], headers: Record<string, string>) {
  const validData: Record<string, any> = {};
  const invalidIds: string[] = [];
  for (const id of batch) {
    const params = { ids: id, vs_currencies: vsCurrencies.join(',') };
    const config: any = { params, timeout: 10000 };
    if (headers && Object.keys(headers).length) config.headers = headers;
    try {
      const res = await retry(() => axios.get(COINGECKO_URL, config), 1);
      if (res && res.data) Object.assign(validData, res.data);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 400) {
        invalidIds.push(id);
      } else if (status === 429) {
        // If we hit rate limit while isolating, respect Retry-After then retry once
        const rh = err?.response?.headers?.['retry-after'];
        const waitSec = Number(rh) || 1;
        await sleep(waitSec * 1000 + 250);
        try {
          const res = await axios.get(COINGECKO_URL, config);
          if (res && res.data) Object.assign(validData, res.data);
        } catch (err2: any) {
          // if still failing, mark as missing (do not treat as invalid)
          console.warn('Isolation request failed for id', id, 'error:', (err2 as any).message || String(err2));
        }
      } else {
        // Other errors - log and continue (mark as missing)
        console.warn('Isolation request failed for id', id, 'error:', (err as any).message || String(err));
      }
    }
  }
  return { validData, invalidIds };
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
    console.warn('No configured CRYPTO_IDS are supported by CoinGecko; proceeding to CoinPaprika fallback or ECB-only.');
  } else {
    if (filteredIds.length < configuredIds.length) {
      const dropped = configuredIds.filter(id => !supportedIds.has(id));
      console.warn('Dropping unsupported CoinGecko ids:', dropped);
    }
    try {
      // Try CoinGecko first (batched). If no results, fall back to CoinPaprika.
      cryptoResult = await fetchCryptoFromCoingecko(filteredIds, coinGeckoFiats);
      const missingIds: string[] = cryptoResult.missing || [];
      const succeededCount = Object.keys(cryptoResult.data || {}).length;
      if (missingIds.length) {
        const missingSymbols = missingIds.map(id => COINGECKO_MAP[id] ?? id.toUpperCase());
        try {
          // Try Binance for missing symbols first
          const binRes = await retry(() => fetchCryptoFromBinance(missingSymbols), 2);
          cryptoResult.data = { ...(cryptoResult.data || {}), ...(binRes.data || {}) };
          provider = succeededCount > 0 ? 'coingecko+binance' : 'binance';
        } catch (binErr: any) {
          console.warn('Binance fallback failed for missing symbols', (binErr as any).message || String(binErr));
          // Try CoinPaprika fallback regardless of Binance error
          try {
            const ccRes = await retry(() => fetchCryptoFromCoinPaprika(missingSymbols), 1);
            if (ccRes && ccRes.data && Object.keys(ccRes.data).length > 0) {
              cryptoResult.data = { ...(cryptoResult.data || {}), ...(ccRes.data || {}) };
                // If CoinPaprika returned any data for missing symbols, prefer
                // a mixed label if CoinGecko provided some data. If CoinGecko
                // returned no data, prefer CoinPaprika when it provided data
                // for multiple symbols; otherwise use legacy 'binance' label
                // for single-symbol fallback to preserve historical semantics.
                if (succeededCount > 0) {
                  provider = 'coingecko+coinpaprika';
                } else {
                  const ccKeys = Object.keys(ccRes.data || {});
                  if (process.env.BINANCE_KEY) {
                    provider = 'coinpaprika';
                  } else {
                    provider = ccKeys.length > 1 ? 'coinpaprika' : 'binance';
                  }
                }
            } else {
              console.warn('CoinPaprika returned no data for missing symbols; proceeding with partial CoinGecko data.');
              try { await sendTelegramAlert(`CoinPaprika fallback returned no data for missing symbols: ${missingSymbols.join(', ')}`); } catch (e) {}
            }
          } catch (ccErr: any) {
            console.warn('CoinPaprika fallback failed for missing symbols', (ccErr as any).message || String(ccErr));
            try { await sendTelegramAlert(`CoinPaprika fallback failed for missing symbols: ${missingSymbols.join(', ')}. Error: ${(ccErr as any).message || String(ccErr)}`); } catch (e) {}
          }
        }
        const finalCount = Object.keys(cryptoResult.data || {}).length;
        if (finalCount === 0) provider = 'none';
      } else if (succeededCount === 0) {
        // full failure from CoinGecko - try Binance then CoinPaprika
        const symbolsForFallback = (filteredIds.length ? filteredIds : configuredIds).map((id: string) => COINGECKO_MAP[id] ?? id.toUpperCase());
        try {
          const binRes = await retry(() => fetchCryptoFromBinance(symbolsForFallback), 2);
          cryptoResult = binRes;
          provider = 'binance';
        } catch (binErr: any) {
          console.warn('Binance fallback failed on full fallback', (binErr as any).message || String(binErr));
          // Try CoinPaprika as a public fallback in full-failure scenarios
          try {
            const ccRes = await retry(() => fetchCryptoFromCoinPaprika(symbolsForFallback), 1);
            if (ccRes && ccRes.data && Object.keys(ccRes.data).length > 0) {
              cryptoResult = ccRes;
              // If CoinPaprika returned any data for our requested symbols,
              // prefer the explicit 'coinpaprika' provider label for clarity.
              provider = 'coinpaprika';
            } else {
              console.warn('CoinPaprika returned no data on full fallback; proceeding with ECB-only fiat data.');
              cryptoResult = { provider: 'none', data: {}, headers: {} } as any;
              provider = 'none';
            }
          } catch (ccErr: any) {
            console.warn('CoinPaprika fallback failed on full fallback', (ccErr as any).message || String(ccErr));
            cryptoResult = { provider: 'none', data: {}, headers: {} } as any;
            provider = 'none';
          }
        }
      }
    } catch (err) {
      console.warn('CoinGecko fetch failed; attempting Binance then CoinPaprika fallback', (err as any).message || String(err));
      const symbolsForFallback = (filteredIds.length ? filteredIds : configuredIds).map((id: string) => COINGECKO_MAP[id] ?? id.toUpperCase());
      try {
        const binRes = await retry(() => fetchCryptoFromBinance(symbolsForFallback), 2);
        cryptoResult = binRes;
        provider = 'binance';
      } catch (binErr: any) {
        const status = binErr?.response?.status;
        if (status === 451) {
          console.warn('Binance returned 451 on full fallback; attempting CoinPaprika as a public fallback.');
          try {
            const ccRes = await retry(() => fetchCryptoFromCoinPaprika(symbolsForFallback), 1);
            if (ccRes && ccRes.data && Object.keys(ccRes.data).length > 0) {
              cryptoResult = ccRes;
              // If CoinPaprika returned any data for our requested symbols,
              // prefer the explicit 'coinpaprika' provider label for clarity.
              provider = 'coinpaprika';
            } else {
              console.warn('CoinPaprika returned no data on full fallback; proceeding with ECB-only fiat data.');
              cryptoResult = { provider: 'none', data: {}, headers: {} } as any;
              provider = 'none';
            }
          } catch (ccErr: any) {
            console.warn('CoinPaprika fallback failed on full fallback', (ccErr as any).message || String(ccErr));
            cryptoResult = { provider: 'none', data: {}, headers: {} } as any;
            provider = 'none';
          }
        } else {
          console.warn('Binance fallback failed on full fallback', (binErr as any).message || String(binErr));
          cryptoResult = { provider: 'none', data: {}, headers: {} } as any;
          provider = 'none';
        }
      }
    }
  }

  const fiat = await retry(fetchFiat, 2);

  // Persist ECB fiat data separately to Firestore for easy access
  try {
    const ecbPayload = { timestamp: new Date().toISOString(), base: fiat?.base ?? 'EUR', rates: fiat?.rates ?? {} };
    // import writeLatestFiat from firestore module
    try {
      // dynamic import to avoid circular issues in some test setups
      const fsMod = await import('./firestore');
      if (typeof fsMod.writeLatestFiat === 'function') {
        await fsMod.writeLatestFiat(ecbPayload);
      }
    } catch (e) {
      console.log('Could not write latest fiat to Firestore (dry-run or missing function).', (e as any).message || String(e));
    }
  } catch (e) {
    console.warn('Failed to persist ECB fiat data to Firestore', (e as any).message || String(e));
  }

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
