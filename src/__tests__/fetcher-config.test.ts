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
      if (url === 'https://api.coingecko.com/api/v3/coins/list') {
        return Promise.resolve({ data: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }, { id: 'litecoin', symbol: 'ltc', name: 'Litecoin' }] });
      }
      if (url === 'https://api.coingecko.com/api/v3/simple/price') {
        expect(opts.params.ids).toBe('bitcoin,litecoin');
        expect(opts.params.vs_currencies).toBe('usd');
        return Promise.resolve({ data: { bitcoin: { usd: 60000 }, litecoin: { usd: 100 } }, headers: {} });
      }
      if (url === 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml') {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">\n  <Cube>\n    <Cube time="2026-02-04">\n      <Cube currency="USD" rate="1.08"/>\n    </Cube>\n  </Cube>\n</gesmes:Envelope>`;
        return Promise.resolve({ data: xml });
      }
      return Promise.reject(new Error('unexpected url'));
    });

    const payload = await fetchAndStoreRates();
    expect(payload.rates).toHaveProperty('BTC');
    expect(payload.rates).toHaveProperty('LITECOIN');
  });

  it('supports top-N via CRYPTO_IDS=top:3', async () => {
    process.env.CRYPTO_IDS = 'top:3';

    mockedAxios.get.mockImplementation((url, opts: any = {}) => {
      if (url === 'https://api.coingecko.com/api/v3/coins/list') {
        return Promise.resolve({ data: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }, { id: 'ethereum', symbol: 'eth', name: 'Ethereum' }, { id: 'litecoin', symbol: 'ltc', name: 'Litecoin' }] });
      }
      if (typeof url === 'string' && url.includes('coins/markets')) {
        // return top-3
        return Promise.resolve({ data: [{ id: 'bitcoin' }, { id: 'ethereum' }, { id: 'litecoin' }] });
      }
      if (url === 'https://api.coingecko.com/api/v3/simple/price') {
        // ensure we requested the top 3 ids
        expect(opts.params.ids).toBe('bitcoin,ethereum,litecoin');
        return Promise.resolve({ data: { bitcoin: { usd: 60000 }, ethereum: { usd: 2000 }, litecoin: { usd: 100 } }, headers: {} });
      }
      if (url === 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml') {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">\n  <Cube>\n    <Cube time="2026-02-04">\n      <Cube currency="USD" rate="1.08"/>\n    </Cube>\n  </Cube>\n</gesmes:Envelope>`;
        return Promise.resolve({ data: xml });
      }
      return Promise.reject(new Error('unexpected url'));
    });

    const payload = await fetchAndStoreRates();
    expect(payload.rates).toHaveProperty('BTC');
    expect(payload.rates).toHaveProperty('ETH');
    expect(payload.rates).toHaveProperty('LITECOIN');

    delete process.env.CRYPTO_IDS;
  });

  it('falls back to configured Binance symbols', async () => {
    process.env.CRYPTO_IDS = 'bitcoin';
    process.env.CRYPTO_SYMBOLS = 'BTC,LTC';

    mockedAxios.get.mockImplementation((url: any, opts: any = {}) => {
      if (typeof url === 'string' && url.includes('coins/list')) {
        return Promise.resolve({ data: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }] });
      }
      if (url.includes('coingecko')) {
        return Promise.reject(new Error('coingecko down'));
      }
      if (url.includes('api.binance.com')) {
        // ensure it called for BTCUSDT and LTCUSDT
        expect(opts.params && (opts.params.symbol === 'BTCUSDT' || opts.params.symbol === 'LTCUSDT')).toBe(true);
        return Promise.resolve({ data: { price: '123' }, headers: {} });
      }
      if (url.includes('eurofxref')) {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">\n  <Cube>\n    <Cube time="2026-02-04">\n      <Cube currency="USD" rate="1.08"/>\n    </Cube>\n  </Cube>\n</gesmes:Envelope>`;
        return Promise.resolve({ data: xml });
      }
      return Promise.reject(new Error('unexpected url'));
    });

    const payload = await fetchAndStoreRates();
    expect(payload).toBeDefined();
  });
});
