import axios from 'axios';
import crypto from 'crypto';
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
  const res = await axios.get(COINGECKO_URL, { params, timeout: 10000 });
  return { provider: 'coingecko', data: res.data, headers: res.headers };
}

async function fetchCryptoFromBinance(symbols: string[]) {
  // Binance returns per-symbol; fetch sequentially and build a structure similar to CoinGecko
  const out: Record<string, any> = {};
  for (const sym of symbols) {
    const pair = sym + 'USDT';
    const res = await axios.get(BINANCE_URL, { params: { symbol: pair }, timeout: 10000 });
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

  let provider = 'coingecko';
  let cryptoResult: any;
  try {
    cryptoResult = await retry(() => fetchCryptoFromCoingecko(['bitcoin', 'ethereum'], ['usd', 'eur']), 2);
  } catch (err) {
    console.warn('CoinGecko fetch failed, trying Binance fallback', err);
    try {
      cryptoResult = await retry(() => fetchCryptoFromBinance(['BTC', 'ETH']), 2);
      provider = 'binance';
    } catch (err2) {
      const durationMs = Date.now() - start;
      await writeMonitoringLog({ runId, provider: 'coingecko', operation: 'fetch', durationMs, status: 'error', error: String(err2), timestamp: new Date().toISOString() });
      throw err2;
    }
  }

  const fiat = await retry(fetchFiat, 2);

  const rates: RatesResult = {};
  // Normalize: if coinGecko-style (ids), map; if binance-style already mapped, use as-is
  if (cryptoResult.provider === 'coingecko') {
    for (const [id, vals] of Object.entries(cryptoResult.data)) {
      const symbol = COINGECKO_MAP[id] ?? id.toUpperCase();
      rates[symbol] = vals as any;
    }
  } else {
    for (const [symbol, vals] of Object.entries(cryptoResult.data)) {
      rates[symbol] = vals as any;
    }
  }

  const meta = {
    provider,
    fetchedAt: new Date().toISOString(),
    headers: cryptoResult.headers ?? {},
    rawResponse: truncateRaw(cryptoResult.data),
    fiatBase: fiat?.base ?? 'EUR',
  };

  const payload = {
    provider,
    timestamp: new Date().toISOString(),
    rates,
    meta,
  };

  const durationMs = Date.now() - start;
  await writeMonitoringLog({ runId, provider, operation: 'fetch_and_store', durationMs, status: 'ok', meta: { fetchedAt: meta.fetchedAt }, timestamp: new Date().toISOString() });

  await writeLatest(payload);
  await writeSnapshot(payload, new Date());

  return payload;
}
