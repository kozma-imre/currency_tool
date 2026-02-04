import axios from 'axios';
import * as firestore from '../firestore';
import { fetchAndStoreRates } from '../fetcher';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.spyOn(firestore, 'writeLatest').mockImplementation(async () => {});
jest.spyOn(firestore, 'writeSnapshot').mockImplementation(async () => {});
jest.spyOn(firestore, 'writeMonitoringLog').mockImplementation(async () => {});

describe('provider API key behavior', () => {
  afterEach(() => {
    jest.resetAllMocks();
    delete process.env.COINGECKO_API_KEY;
    delete process.env.BINANCE_KEY;
    delete process.env.BINANCE_SECRET;
  });

  it('sends CoinGecko API key header when COINGECKO_API_KEY is set', async () => {
    process.env.COINGECKO_API_KEY = 'test-cg-key';

    mockedAxios.get.mockImplementation((url: any, opts?: any) => {
      if (typeof url === 'string' && url.includes('coingecko')) {
        expect(opts).toBeDefined();
        expect(opts.headers).toBeDefined();
        expect(opts.headers['X-CG-PRO-API-KEY']).toBe('test-cg-key');
        return Promise.resolve({ data: { bitcoin: { usd: 50000 }, ethereum: { usd: 2000 } }, headers: { 'x-test': 'ok' } });
      }
      if (typeof url === 'string' && url.includes('exchangerate.host')) {
        return Promise.resolve({ data: { base: 'EUR', date: '2026-02-04', rates: { USD: 1.08 } } });
      }
      return Promise.reject(new Error('unknown url'));
    });

    const payload = await fetchAndStoreRates();
    expect(payload.provider).toBe('coingecko');
    expect(payload.rates.BTC!.usd).toBe(50000);
  });

  it('sends Binance API key header on fallback when BINANCE_KEY is set', async () => {
    process.env.BINANCE_KEY = 'test-binance-key';

    mockedAxios.get.mockImplementation((url: any, opts?: any) => {
      if (typeof url === 'string' && url.includes('coingecko')) {
        return Promise.reject(new Error('coingecko down'));
      }
      if (typeof url === 'string' && url.includes('api.binance.com')) {
        expect(opts).toBeDefined();
        expect(opts.headers).toBeDefined();
        expect(opts.headers['X-MBX-APIKEY']).toBe('test-binance-key');
        return Promise.resolve({ data: { price: '60000' }, headers: {} });
      }
      if (typeof url === 'string' && url.includes('exchangerate.host')) {
        return Promise.resolve({ data: { base: 'EUR', date: '2026-02-04', rates: { USD: 1.08 } } });
      }
      return Promise.reject(new Error('unknown url'));
    });

    const payload = await fetchAndStoreRates();
    expect(payload.provider).toBe('binance');
    expect(payload.rates.BTC!.usd).toBe(60000);
  });
});
