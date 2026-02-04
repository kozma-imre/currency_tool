import axios from 'axios';
import { fetchAndStoreRates } from '../fetcher';

jest.mock('../firestore', () => ({
  initFirestore: jest.fn(),
  writeLatest: jest.fn(),
  writeSnapshot: jest.fn(),
  writeMonitoringLog: jest.fn(),
}));

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

test('fetchAndStoreRates returns payload with provider and rates', async () => {
  mockedAxios.get.mockImplementation((url) => {
    if (url === 'https://api.coingecko.com/api/v3/simple/price') {
      return Promise.resolve({ data: { bitcoin: { usd: 60000 }, ethereum: { usd: 2000 } } });
    }
    if (url === 'https://api.exchangerate.host/latest') {
      return Promise.resolve({ data: { base: 'EUR', date: '2026-02-04', rates: { USD: 1.08 } } });
    }
    return Promise.reject(new Error('unknown url'));
  });

  const payload = await fetchAndStoreRates();
  expect(payload).toHaveProperty('provider', 'coingecko');
  expect(payload).toHaveProperty('rates');
  expect(payload.rates.BTC!.usd).toBe(60000);
});
