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

  it('retries on failure and succeeds', async () => {
    let first = true;
    mockedAxios.get.mockImplementation((url) => {
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
