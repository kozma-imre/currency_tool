import axios from 'axios';
import * as fs from 'fs';
import { fetchAndStoreRates } from '../fetcher';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('../firestore', () => ({
  initFirestore: jest.fn(),
  writeLatest: jest.fn(),
  writeSnapshot: jest.fn(),
  writeMonitoringLog: jest.fn(),
}));

describe('fetcher config via env', () => {
  afterEach(() => {
    jest.resetAllMocks();
    delete process.env.CRYPTO_IDS;
    delete process.env.FIAT_CURRENCIES;
    delete process.env.CRYPTO_SYMBOLS;
  });

  it('passes configured ids and fiats to CoinGecko request', async () => {
    process.env.CRYPTO_IDS = 'bitcoin,litecoin';
    process.env.FIAT_CURRENCIES = 'usd';

    mockedAxios.get.mockImplementation((url, opts: any = {}) => {
      if (url === 'https://api.coingecko.com/api/v3/simple/price') {
        expect(opts.params.ids).toBe('bitcoin,litecoin');
        expect(opts.params.vs_currencies).toBe('usd');
        return Promise.resolve({ data: { bitcoin: { usd: 60000 }, litecoin: { usd: 100 } }, headers: {} });
      }
      if (url === 'https://api.exchangerate.host/latest') {
        return Promise.resolve({ data: { base: 'EUR', date: '2026-02-04', rates: { USD: 1.08 } } });
      }
      return Promise.reject(new Error('unexpected url'));
    });

    const payload = await fetchAndStoreRates();
    expect(payload.rates).toHaveProperty('BTC');
    expect(payload.rates).toHaveProperty('LITECOIN');
  });

  it('falls back to configured Binance symbols', async () => {
    process.env.CRYPTO_IDS = 'bitcoin';
    process.env.CRYPTO_SYMBOLS = 'BTC,LTC';

    mockedAxios.get.mockImplementation((url: any, opts: any = {}) => {
      if (url.includes('coingecko')) {
        return Promise.reject(new Error('coingecko down'));
      }
      if (url.includes('api.binance.com')) {
        // ensure it called for BTCUSDT and LTCUSDT
        expect(opts.params && (opts.params.symbol === 'BTCUSDT' || opts.params.symbol === 'LTCUSDT')).toBe(true);
        return Promise.resolve({ data: { price: '123' }, headers: {} });
      }
      if (url.includes('exchangerate.host')) {
        return Promise.resolve({ data: { base: 'EUR', date: '2026-02-04', rates: { USD: 1.08 } } });
      }
      return Promise.reject(new Error('unexpected url'));
    });

    const payload = await fetchAndStoreRates();
    expect(payload).toBeDefined();
  });
});
