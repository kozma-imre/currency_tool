import axios from 'axios';
import * as notify from '../notify/telegram';
import * as firestore from '../firestore';
import { fetchAndStoreRates } from '../fetcher';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.spyOn(firestore, 'writeLatest').mockImplementation(async () => {});
jest.spyOn(firestore, 'writeSnapshot').mockImplementation(async () => {});
jest.spyOn(firestore, 'writeMonitoringLog').mockImplementation(async () => {});

describe('fetcher CoinCap fallback', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('uses CoinCap when Binance is geo-blocked for full fallback', async () => {
    mockedAxios.get.mockImplementation((url: any, _opts?: any) => {
      if (typeof url === 'string' && url.includes('coins/list')) {
        return Promise.resolve({ data: [{ id: 'bitcoin' }, { id: 'ethereum' }] });
      }
      if (typeof url === 'string' && url.includes('coingecko')) {
        // simulate a full failure
        return Promise.reject(new Error('coingecko down'));
      }
      if (typeof url === 'string' && url.includes('api.coinpaprika.com')) {
        // simulate CoinPaprika search + tickers sequence
        if (url.includes('/search')) {
          return Promise.resolve({ data: { coins: [{ id: 'btc-bitcoin', symbol: 'BTC' }, { id: 'eth-ethereum', symbol: 'ETH' }] } });
        }
        if (url.includes('/tickers')) {
          // return ticker with quotes
          const symbol = url.includes('btc-bitcoin') ? 'BTC' : 'ETH';
          return Promise.resolve({ data: { id: symbol === 'BTC' ? 'btc-bitcoin' : 'eth-ethereum', quotes: { USD: { price: symbol === 'BTC' ? 50000 : 2500 } } }, headers: {} });
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
    expect(payload.rates.BTC!.usd).toBe(50000);
    expect(payload.rates.ETH!.usd).toBe(2500);
  });

  it('merges CoinCap when Binance geo-blocks missing symbols after partial CoinGecko', async () => {
    const tgSpy = jest.spyOn(notify, 'sendTelegramAlert').mockImplementation(async () => ({ ok: true } as any));

    mockedAxios.get.mockImplementation((url: any, _opts?: any) => {
      if (typeof url === 'string' && url.includes('coins/list')) {
        return Promise.resolve({ data: [{ id: 'bitcoin' }, { id: 'ethereum' }] });
      }
      if (typeof url === 'string' && url.includes('coingecko')) {
        // only return bitcoin price, simulate failure for other batch(s)
        return Promise.resolve({ data: { bitcoin: { usd: 50000 } }, headers: { etag: 'W/"abcd"' } });
      }
      if (typeof url === 'string' && url.includes('api.binance.com')) {
        const e: any = new Error('geo');
        e.response = { status: 451 };
        return Promise.reject(e);
      }
      if (typeof url === 'string' && url.includes('api.coinpaprika.com')) {
        if (url.includes('/search')) {
          // return mapping for ETH
          return Promise.resolve({ data: { coins: [{ id: 'eth-ethereum', symbol: 'ETH' }] } });
        }
        if (url.includes('/tickers')) {
          return Promise.resolve({ data: { id: 'eth-ethereum', quotes: { USD: { price: 2500 } } }, headers: {} });
        }
      }
      if (typeof url === 'string' && url.includes('eurofxref')) {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">\n  <Cube>\n    <Cube time="2026-02-04">\n      <Cube currency="USD" rate="1.08"/>\n    </Cube>\n  </Cube>\n</gesmes:Envelope>`;
        return Promise.resolve({ data: xml });
      }
      return Promise.reject(new Error('unknown url'));
    });

    const payload = await fetchAndStoreRates();
    expect(payload.provider).toBe('coingecko+coinpaprika');
    expect(payload.rates.BTC!.usd).toBe(50000);
    expect(payload.rates.ETH!.usd).toBe(2500);
    expect(tgSpy).not.toHaveBeenCalled(); // no need to send alert when CoinCap succeeded
  });
});
