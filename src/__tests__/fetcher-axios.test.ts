import axios from 'axios';
import { fetchAndStoreRates } from '../fetcher';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

import * as firestore from '../firestore';

jest.spyOn(firestore, 'writeLatest').mockImplementation(async () => {});
jest.spyOn(firestore, 'writeSnapshot').mockImplementation(async () => {});
jest.spyOn(firestore, 'writeMonitoringLog').mockImplementation(async () => {});

describe('fetcher with mocked axios', () => {
  beforeEach(() => jest.resetAllMocks());

  it('returns normalized payload when providers succeed', async () => {
    mockedAxios.get.mockImplementation((url) => {
      if (url === 'https://api.coingecko.com/api/v3/coins/list') {
        return Promise.resolve({ data: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }, { id: 'ethereum', symbol: 'eth', name: 'Ethereum' }] });
      }
      if (url === 'https://api.coingecko.com/api/v3/simple/price') {
        return Promise.resolve({ data: { bitcoin: { usd: 50000, eur: 46000 }, ethereum: { usd: 2000 } } });
      }
      if (url === 'https://api.exchangerate.host/latest') {
        return Promise.resolve({ data: { base: 'EUR', date: '2026-02-04', rates: { USD: 1.08 } } });
      }
      return Promise.reject(new Error('unknown url'));
    });

    const payload = await fetchAndStoreRates();

    expect(payload).toHaveProperty('provider', 'coingecko');
    expect(payload).toHaveProperty('rates');
    expect(payload.rates).toHaveProperty('BTC');
    expect(payload.rates.BTC).toHaveProperty('usd', 50000);
    expect(payload.meta).toHaveProperty('fiatBase', 'EUR');
    expect(firestore.writeSnapshot).toHaveBeenCalled();
  });

  it('expands additional fiat currencies using ECB when CoinGecko only returns USD/EUR', async () => {
    process.env.FIAT_CURRENCIES = 'usd,eur,ron,huf';
    mockedAxios.get.mockImplementation((url, config) => {
      if (url === 'https://api.coingecko.com/api/v3/coins/list') {
        return Promise.resolve({ data: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }, { id: 'ethereum', symbol: 'eth', name: 'Ethereum' }] });
      }
      if (url === 'https://api.coingecko.com/api/v3/simple/price') {
        // ensure CoinGecko only requested usd,eur
        expect(config?.params?.vs_currencies).toBe('usd,eur');
        return Promise.resolve({ data: { bitcoin: { usd: 50000, eur: 46000 }, ethereum: { usd: 2000, eur: 1800 } } });
      }
      if (url === 'https://api.exchangerate.host/latest') {
        return Promise.resolve({ data: { base: 'EUR', date: '2026-02-04', rates: { USD: 1.08, RON: 4.9, HUF: 400 } } });
      }
      return Promise.reject(new Error('unknown url'));
    });

    const payload = await fetchAndStoreRates();

    expect(payload).toHaveProperty('rates');
    expect(payload.rates).toHaveProperty('BTC');
    // original values
    expect(payload.rates.BTC).toHaveProperty('usd', 50000);
    expect(payload.rates.BTC).toHaveProperty('eur', 46000);
    // ensure BTC entry exists before checking derived values
    expect(payload.rates.BTC).toBeDefined();
    // derived values: ron = usd * (RON/USD) = 50000 * (4.9 / 1.08)
    const expectedRon = 50000 * (4.9 / 1.08);
    expect(payload.rates.BTC!.ron).toBeCloseTo(expectedRon, 4);
    const expectedHuf = 50000 * (400 / 1.08);
    expect(payload.rates.BTC!.huf).toBeCloseTo(expectedHuf, 4);

    // cleanup
    delete process.env.FIAT_CURRENCIES;
  });

  it('filters unsupported CRYPTO_IDS using CoinGecko coins list', async () => {
    process.env.CRYPTO_IDS = 'bitcoin,solana';
    mockedAxios.get.mockImplementation((url, config) => {
      if (url === 'https://api.coingecko.com/api/v3/coins/list') {
        return Promise.resolve({ data: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }] });
      }
      if (url === 'https://api.coingecko.com/api/v3/simple/price') {
        // ensure we only asked for the supported id
        expect(config?.params?.ids).toBe('bitcoin');
        return Promise.resolve({ data: { bitcoin: { usd: 50000 } } });
      }
      if (url === 'https://api.exchangerate.host/latest') {
        return Promise.resolve({ data: { base: 'EUR', date: '2026-02-04', rates: { USD: 1.08 } } });
      }
      return Promise.reject(new Error('unknown url'));
    });

    const payload = await fetchAndStoreRates();

    expect(payload).toHaveProperty('provider', 'coingecko');
    expect(payload.rates).toHaveProperty('BTC');
    expect(payload.rates).not.toHaveProperty('SOLANA');

    delete process.env.CRYPTO_IDS;
  });

  it('retries on failure and succeeds', async () => {
    let first = true;
    mockedAxios.get.mockImplementation((url) => {
      if (url === 'https://api.coingecko.com/api/v3/coins/list') {
        return Promise.resolve({ data: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }] });
      }
      if (url === 'https://api.coingecko.com/api/v3/simple/price') {
        if (first) {
          first = false;
          return Promise.reject(new Error('transient'));
        }
        return Promise.resolve({ data: { bitcoin: { usd: 50000, eur: 46000 } } });
      }
      if (url === 'https://api.exchangerate.host/latest') {
        return Promise.resolve({ data: { base: 'EUR', date: '2026-02-04', rates: { USD: 1.08 } } });
      }
      return Promise.reject(new Error('unknown url'));
    });

    const payload = await fetchAndStoreRates();
    expect(payload.rates.BTC!.usd).toBe(50000);
  });
});
