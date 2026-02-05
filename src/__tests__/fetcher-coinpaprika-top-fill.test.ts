import axios from 'axios';
import * as firestore from '../firestore';
import { fetchAndStoreRates } from '../fetcher';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.spyOn(firestore, 'writeLatest').mockImplementation(async () => {});
jest.spyOn(firestore, 'writeSnapshot').mockImplementation(async () => {});
jest.spyOn(firestore, 'writeMonitoringLog').mockImplementation(async () => {});

describe('fetcher coinpaprika top-N fill fallback', () => {
  const OLD = process.env.CRYPTO_IDS;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.CRYPTO_IDS = 'top:3';
  });
  afterEach(() => {
    if (OLD === undefined) delete process.env.CRYPTO_IDS; else process.env.CRYPTO_IDS = OLD;
  });

  it('fills missing items from CoinPaprika top-N when CoinGecko returns partial results', async () => {
    mockedAxios.get.mockImplementation((url: any, _opts?: any) => {
      const s = String(url || '');
      if (s.includes('/coins/list')) {
        return Promise.resolve({ data: [{ id: 'coin-a' }, { id: 'coin-b' }, { id: 'coin-c' }] });
      }
      if (s.includes('/coins/markets')) {
        // markets fallback used by fetchTopCoinIds during tests
        return Promise.resolve({ data: [{ id: 'coin-a' }, { id: 'coin-b' }, { id: 'coin-c' }] });
      }
      if (s.includes('/simple/price')) {
        // simulate partial result: only coin-a present
        return Promise.resolve({ data: { 'coin-a': { usd: 1 } } });
      }
      if (s.includes('/tickers') && !s.includes('/tickers/')) {
        // CoinPaprika top tickers list with quotes
        return Promise.resolve({ data: [
          { id: 'coin-a', symbol: 'A', quotes: { USD: { price: 10 } } },
          { id: 'coin-b', symbol: 'B', quotes: { USD: { price: 20 } } },
          { id: 'coin-c', symbol: 'C', quotes: { USD: { price: 30 } } },
        ] });
      }
      if (s.includes('eurofxref')) {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">\n  <Cube>\n    <Cube time="2026-02-05">\n      <Cube currency="USD" rate="1.08"/>\n    </Cube>\n  </Cube>\n</gesmes:Envelope>`;
        return Promise.resolve({ data: xml });
      }

      return Promise.reject(new Error('unexpected url ' + url));
    });

    const payload = await fetchAndStoreRates();
    // Expect that we end up with top 3 filled
    expect(payload.provider).toMatch(/coinpaprika/);
    expect(payload.rates.A).toBeDefined();
    expect(payload.rates.B).toBeDefined();
    expect(payload.rates.C).toBeDefined();
  });
});
