import axios from 'axios';
import * as firestore from '../firestore';
import { fetchAndStoreRates } from '../fetcher';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.spyOn(firestore, 'writeLatest').mockImplementation(async () => {});
jest.spyOn(firestore, 'writeSnapshot').mockImplementation(async () => {});
jest.spyOn(firestore, 'writeMonitoringLog').mockImplementation(async () => {});

describe('fetcher coinpaprika top-N fallback', () => {
  const OLD = process.env.CRYPTO_IDS;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.CRYPTO_IDS = 'top:3';
  });
  afterEach(() => {
    if (OLD === undefined) delete process.env.CRYPTO_IDS; else process.env.CRYPTO_IDS = OLD;
  });

  it('uses CoinPaprika top-N tickers when CoinGecko and Binance fail', async () => {
    mockedAxios.get.mockImplementation((url: any, _opts?: any) => {
      const s = String(url || '');
      if (s.includes('/coins/list')) {
        return Promise.resolve({ data: [{ id: 'coin-a' }, { id: 'coin-b' }, { id: 'coin-c' }] });
      }
      if (s.includes('/coins/markets')) {
        // fetchTopCoinIds response
        return Promise.resolve({ data: [{ id: 'coin-a' }, { id: 'coin-b' }, { id: 'coin-c' }] });
      }
      if (s.includes('/simple/price')) {
        // Simulate CoinGecko simple price failing (so missing all)
        const err: any = new Error('coingecko simple price failure');
        err.response = { status: 500 };
        return Promise.reject(err);
      }
      if (s.includes('api.coinpaprika.com') && s.includes('/tickers') && !s.includes('/tickers/')) {
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
    // ensure provider
    expect(payload.provider).toBe('coinpaprika');
    // USD quotes from CoinPaprika are available under USD base
    expect(payload.rates.USD.A).toBeCloseTo(10);
    expect(payload.rates.EUR.A).toBeCloseTo(10 * (1 / 1.08));
    expect(payload.rates.USD.B).toBeCloseTo(20);
    expect(payload.rates.EUR.B).toBeCloseTo(20 * (1 / 1.08));
    expect(payload.rates.USD.C).toBeCloseTo(30);
    expect(payload.rates.EUR.C).toBeCloseTo(30 * (1 / 1.08));
  });
});
