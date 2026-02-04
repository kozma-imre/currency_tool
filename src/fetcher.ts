import axios from 'axios';
import * as crypto from 'crypto';
import { initFirestore, writeLatest, writeSnapshot, writeMonitoringLog } from './firestore';
import type { RatesResult } from './types';

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price';
const ECB_URL = 'https://api.exchangerate.host/latest';
const BINANCE_URL = 'https://api.binance.com/api/v3/ticker/price';

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
  const params = {
    ids: cryptoIds.join(','),
    vs_currencies: vsCurrencies.join(','),
  };
  const headers: Record<string, string> = {};
  if (process.env.COINGECKO_API_KEY) {
    // Use CoinGecko Pro API header if provided
    headers['X-CG-PRO-API-KEY'] = process.env.COINGECKO_API_KEY;
  }
  const config: any = { params, timeout: 10000 };
  if (Object.keys(headers).length) config.headers = headers;
  const res = await axios.get(COINGECKO_URL, config);
  return { provider: 'coingecko', data: res.data, headers: res.headers };
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
  const configuredIds = (process.env.CRYPTO_IDS ?? 'bitcoin,ethereum').split(',').map(s => s.trim()).filter(Boolean);
  const fiatCurrencies = (process.env.FIAT_CURRENCIES ?? 'usd,eur').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  // For CoinGecko we only request common fiat bases (usd, eur) to avoid unsupported fiats; ECB will be used to expand others
  const coinGeckoFiats = fiatCurrencies.filter(f => ['usd', 'eur'].includes(f));
  if (!coinGeckoFiats.length) {
    coinGeckoFiats.push('usd', 'eur'); // ensure at least USD/EUR
  }

  // Binance symbols: explicit override or derive from COINGECKO_MAP or uppercase ids
  const configuredSymbols = (process.env.CRYPTO_SYMBOLS && process.env.CRYPTO_SYMBOLS.split(',').map(s => s.trim()).filter(Boolean)) || configuredIds.map(id => COINGECKO_MAP[id] ?? id.toUpperCase());

  let provider = 'coingecko';
  let cryptoResult: any;
  try {
    cryptoResult = await retry(() => fetchCryptoFromCoingecko(configuredIds, coinGeckoFiats), 2);
  } catch (err) {
    console.warn('CoinGecko fetch failed, trying Binance fallback', err);
    try {
      cryptoResult = await retry(() => fetchCryptoFromBinance(configuredSymbols), 2);
      provider = 'binance';
    } catch (err2) {
      const durationMs = Date.now() - start;
      await writeMonitoringLog({ runId, provider: 'coingecko', operation: 'fetch', durationMs, status: 'error', error: String(err2), timestamp: new Date().toISOString() });
      throw err2;
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
