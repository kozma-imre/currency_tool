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
    if (url === 'https://api.coingecko.com/api/v3/coins/list') {
      return Promise.resolve({ data: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }, { id: 'ethereum', symbol: 'eth', name: 'Ethereum' }] });
    }
    if (url === 'https://api.coingecko.com/api/v3/simple/price') {
      return Promise.resolve({ data: { bitcoin: { usd: 60000 }, ethereum: { usd: 2000 } } });
    }
    if (url === 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml') {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">\n  <Cube>\n    <Cube time="2026-02-04">\n      <Cube currency="USD" rate="1.08"/>\n    </Cube>\n  </Cube>\n</gesmes:Envelope>`;
      return Promise.resolve({ data: xml });
    }
    return Promise.reject(new Error('unknown url'));
  });

  const payload = await fetchAndStoreRates();
  expect(payload).toHaveProperty('provider', 'coingecko');
  expect(payload).toHaveProperty('rates');
  // ensure USD/EUR present
  expect(payload.rates.USD.BTC).toBe(60000);
  expect(payload.rates.EUR.BTC).toBeCloseTo(60000 * (1 / 1.08));
});
