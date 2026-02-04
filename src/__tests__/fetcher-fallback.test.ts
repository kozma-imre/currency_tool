import axios from 'axios';
import * as firestore from '../firestore';
import { fetchAndStoreRates } from '../fetcher';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.spyOn(firestore, 'writeLatest').mockImplementation(async () => {});
jest.spyOn(firestore, 'writeSnapshot').mockImplementation(async () => {});
jest.spyOn(firestore, 'writeMonitoringLog').mockImplementation(async () => {});


describe('fetcher fallback behavior', () => {
  beforeEach(() => jest.resetAllMocks());

  it('uses Binance fallback when CoinGecko fails', async () => {
    let called = 0;
    mockedAxios.get.mockImplementation((url: any, opts?: any) => {
      if (typeof url === 'string' && url.includes('coingecko')) {
        called++;
        return Promise.reject(new Error('coingecko down'));
      }
      if (typeof url === 'string' && url.includes('api.binance.com')) {
        // return a per-symbol response for BTCUSDT
        return Promise.resolve({ data: { price: '60000' }, headers: {} });
      }
      if (typeof url === 'string' && url.includes('exchangerate.host')) {
        return Promise.resolve({ data: { base: 'EUR', date: '2026-02-04', rates: { USD: 1.08 } } });
      }
      return Promise.reject(new Error('unknown url'));
    });

    const payload = await fetchAndStoreRates();
    expect(payload.provider).toBe('binance');
    expect(payload).toHaveProperty('rates');
    expect(payload.rates.BTC!.usd).toBe(60000);
    expect(firestore.writeSnapshot).toHaveBeenCalled();
    expect(firestore.writeMonitoringLog).toHaveBeenCalled();
  });
});
