import axios from 'axios';
import { initFirestore, writeLatest } from './firestore';
import type { RatesResult } from './types';

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price';
const ECB_URL = 'https://api.exchangerate.host/latest';

const COINGECKO_MAP: Record<string, string> = { bitcoin: 'BTC', ethereum: 'ETH' };

async function fetchCrypto(cryptoIds: string[], vsCurrencies: string[]) {
  const params = {
    ids: cryptoIds.join(','),
    vs_currencies: vsCurrencies.join(','),
  };
  const res = await axios.get(COINGECKO_URL, { params, timeout: 10000 });
  return res.data;
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

  const crypto = await retry(() => fetchCrypto(['bitcoin', 'ethereum'], ['usd', 'eur']), 2);
  const fiat = await retry(fetchFiat, 2);

  const rates: RatesResult = {};
  for (const [id, vals] of Object.entries(crypto)) {
    const symbol = COINGECKO_MAP[id] ?? id.toUpperCase();
    rates[symbol] = vals as any;
  }

  const payload = {
    provider: 'coingecko',
    timestamp: new Date().toISOString(),
    rates,
    meta: { fetchedAt: new Date().toISOString(), fiatBase: fiat?.base ?? 'EUR' },
  };

  await writeLatest(payload);

  return payload;
}
