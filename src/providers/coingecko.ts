import axios from 'axios';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sleep, retry } from '../utils';
import { sendTelegramAlert } from '../notify/telegram';
import { PROVIDER_COINGECKO } from '../constants';

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price';
const COINGECKO_LIST_URL = 'https://api.coingecko.com/api/v3/coins/list';
const COINGECKO_MARKETS_URL = 'https://api.coingecko.com/api/v3/coins/markets';

const COINGECKO_COINS_CACHE_TTL = Number(process.env.COINGECKO_COINS_CACHE_TTL) || 24 * 60 * 60; // seconds
const COINGECKO_COINS_CACHE_FILE = path.join(os.tmpdir(), 'coingecko-coins.json');
const COINGECKO_COINS_CACHE_LIMIT = Number(process.env.COINGECKO_COINS_CACHE_LIMIT) || 1000;

const COINGECKO_MAX_IDS_PER_REQUEST = Number(process.env.COINGECKO_MAX_IDS_PER_REQUEST) || 50;
const COINGECKO_BATCH_DELAY_MS = Number(process.env.COINGECKO_BATCH_DELAY_MS) || 300;

export async function fetchSupportedCoinIds(): Promise<Set<string>> {
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
  } catch (e) {}

  const res = await retry(() => axios.get(COINGECKO_LIST_URL, { timeout: 10000 }), 2);
  const data = Array.isArray(res.data) ? res.data : [];
  const limited = data.slice(0, COINGECKO_COINS_CACHE_LIMIT);
  try {
    fs.writeFileSync(COINGECKO_COINS_CACHE_FILE, JSON.stringify({ ts: Date.now(), data: limited }), 'utf8');
  } catch (e) {}
  return new Set((limited || []).map((c: any) => c.id));
}

export async function fetchTopCoinIds(n = 100): Promise<Set<string>> {
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
  } catch (e) {}

  const res = await retry(() => axios.get(COINGECKO_MARKETS_URL, { timeout: 10000, params: { vs_currency: 'usd', order: 'market_cap_desc', per_page: n, page: 1, sparkline: false } }), 2);
  const data = res.data;
  try { fs.writeFileSync(cacheFile, JSON.stringify({ ts: Date.now(), data }), 'utf8'); } catch (e) {}
  return new Set((data || []).map((c: any) => c.id));
}

export async function isolateInvalidIds(batch: string[], vsCurrencies: string[], headers: Record<string, string>) {
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
        const rh = err?.response?.headers?.['retry-after'];
        const waitSec = Number(rh) || 1;
        await sleep(waitSec * 1000 + 250);
        try {
          const res = await axios.get(COINGECKO_URL, config);
          if (res && res.data) Object.assign(validData, res.data);
        } catch (err2: any) {
          console.warn('Isolation request failed for id', id, 'error:', (err2 as any).message || String(err2));
        }
      } else {
        console.warn('Isolation request failed for id', id, 'error:', (err as any).message || String(err));
      }
    }
  }
  return { validData, invalidIds };
}

export async function fetchCryptoFromCoingecko(cryptoIds: string[], vsCurrencies: string[]) {
  const headers: Record<string, string> = {};
  if (process.env.COINGECKO_API_KEY) headers['X-CG-PRO-API-KEY'] = process.env.COINGECKO_API_KEY;

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
              await sleep(waitSec * 1000 + 250);
            }
            throw err;
          }
        }, 4);
      } catch (err: any) {
        const status = err?.response?.status;
        if (status === 400 || status === 429) {
          console.warn('CoinGecko batch returned', status, '; attempting per-id isolation for batch', batch);
          try {
            const { validData, invalidIds } = await isolateInvalidIds(batch, vsCurrencies, headers);
            const prevCount = Object.keys(out || {}).length;
            Object.assign(out, validData);
            const postCount = Object.keys(out || {}).length;
            const added = postCount - prevCount;
            if (invalidIds.length) {
              console.warn('Dropping unsupported/invalid CoinGecko ids:', invalidIds);
              try { await sendTelegramAlert(`Dropped unsupported CoinGecko ids during fetch: ${invalidIds.join(', ')}`); } catch (e) {}
            }
            if (added > 0 && invalidIds.length > 0) {
              try { await sendTelegramAlert(`CoinGecko returned partial results (recovered ${added} via per-id calls). Missing: ${invalidIds.join(', ')}`); } catch (e) {}
            }
          } catch (innerErr: any) {
            console.warn('Error during batch isolation for CoinGecko', (innerErr as any).message || String(innerErr));
          }
        } else {
          console.warn('CoinGecko batch failed for ids', batch, 'error:', (err as any).message || String(err));
        }
      }

      if (bi < batches.length - 1) await sleep(COINGECKO_BATCH_DELAY_MS);
    }
  } catch (err: any) {
    console.warn('CoinGecko fetch experienced unexpected error; returning partial results', (err as any).message || String(err));
  }

  const missing: string[] = cryptoIds.filter(id => !(id in out));
  return { provider: PROVIDER_COINGECKO, data: out, headers: collectedHeaders, missing };
}
