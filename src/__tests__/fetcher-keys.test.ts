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
      if (typeof url === 'string' && url.includes('coins/list')) {
        return Promise.resolve({ data: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }, { id: 'ethereum', symbol: 'eth', name: 'Ethereum' }] });
      }
      if (typeof url === 'string' && url.includes('coingecko')) {
        expect(opts).toBeDefined();
        expect(opts.headers).toBeDefined();
        expect(opts.headers['X-CG-PRO-API-KEY']).toBe('test-cg-key');
        return Promise.resolve({ data: { bitcoin: { usd: 50000 }, ethereum: { usd: 2000 } }, headers: { 'x-test': 'ok' } });
      }
      if (typeof url === 'string' && url.includes('eurofxref')) {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">\n  <Cube>\n    <Cube time="2026-02-04">\n      <Cube currency="USD" rate="1.08"/>\n    </Cube>\n  </Cube>\n</gesmes:Envelope>`;
        return Promise.resolve({ data: xml });
      }
      return Promise.reject(new Error('unknown url'));
    });

    const payload = await fetchAndStoreRates();
    expect(payload.provider).toBe('coingecko');
    expect(payload.rates.BTC!.usd).toBe(50000);
  });

  it('falls back to CoinPaprika when CoinGecko fails', async () => {
    process.env.BINANCE_KEY = 'test-binance-key';

    mockedAxios.get.mockImplementation((url: any, opts?: any) => {
      if (typeof url === 'string' && url.includes('coins/list')) {
        return Promise.resolve({ data: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }] });
      }
      if (typeof url === 'string' && url.includes('coingecko')) {
        return Promise.reject(new Error('coingecko down'));
      }
      if (typeof url === 'string' && url.includes('api.coinpaprika.com')) {
        if (url.includes('/search')) {
          return Promise.resolve({ data: { coins: [{ id: 'btc-bitcoin', symbol: 'BTC' }] } });
        }
        if (url.includes('/tickers')) {
          return Promise.resolve({ data: { id: 'btc-bitcoin', quotes: { USD: { price: 60000 } } }, headers: {} });
        }
      }
      if (typeof url === 'string' && url.includes('eurofxref')) {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">\n  <Cube>\n    <Cube time="2026-02-04">\n      <Cube currency="USD" rate="1.08"/>\n    </Cube>\n  </Cube>\n</gesmes:Envelope>`;
        return Promise.resolve({ data: xml });
      }
      return Promise.reject(new Error('unknown url'));
    });

    const payload = await fetchAndStoreRates();
    expect(payload.provider).toBe('coinpaprika');
    expect(payload.rates.BTC!.usd).toBe(60000);
  });
});
