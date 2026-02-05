import axios from 'axios';
import * as notify from '../notify/telegram';
import * as firestore from '../firestore';
import { fetchAndStoreRates } from '../fetcher';
import { isHost } from './url-helpers';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.spyOn(firestore, 'writeLatest').mockImplementation(async () => {});
jest.spyOn(firestore, 'writeSnapshot').mockImplementation(async () => {});
jest.spyOn(firestore, 'writeMonitoringLog').mockImplementation(async () => {});

describe('fetcher CoinPaprika multi-candidate fallback', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('tries multiple CoinPaprika candidates when the first ticker fails', async () => {
    const tgSpy = jest.spyOn(notify, 'sendTelegramAlert').mockImplementation(async () => ({ ok: true } as any));

    // Test with configured cryptos that include AAVE and ALGORAND
    process.env.CRYPTO_IDS = 'bitcoin,aave,algorand';

    mockedAxios.get.mockImplementation((url: any, _opts?: any) => {
      if (typeof url === 'string' && url.includes('coins/list')) {
        return Promise.resolve({ data: [{ id: 'bitcoin' }, { id: 'ethereum' }, { id: 'aave' }, { id: 'algorand' }] });
      }
      if (typeof url === 'string' && url.includes('coingecko')) {
        // simulate partial CoinGecko success (bitcoin only)
        return Promise.resolve({ data: { bitcoin: { usd: 50000 } }, headers: { etag: 'W/"abcd"' } });
      }
      if (typeof url === 'string' && url.includes('api.binance.com')) {
        const e: any = new Error('geo');
        e.response = { status: 451 };
        return Promise.reject(e);
      }
      if (typeof url === 'string' && isHost(url, 'api.coinpaprika.com')) {
        if (url.includes('/search')) {
          const q = _opts && _opts.params && _opts.params.query ? String(_opts.params.query).toUpperCase() : '';
          if (q === 'AAVE') {
            return Promise.resolve({ data: { coins: [{ id: 'aave-invalid', symbol: 'AAVE' }, { id: 'aave-aave', symbol: 'AAVE' }] } });
          }
          if (q === 'ALGORAND') {
            return Promise.resolve({ data: { coins: [{ id: 'alg-invalid', symbol: 'ALGORAND' }, { id: 'alg-algorand', symbol: 'ALGORAND' }] } });
          }
        }
        if (url.includes('/tickers/aave-invalid')) {
          const e: any = new Error('bad request');
          e.response = { status: 400 };
          return Promise.reject(e);
        }
        if (url.includes('/tickers/aave-aave')) {
          return Promise.resolve({ data: { id: 'aave-aave', quotes: { USD: { price: 90 } } }, headers: {} });
        }
        if (url.includes('/tickers/alg-invalid')) {
          const e: any = new Error('bad request');
          e.response = { status: 400 };
          return Promise.reject(e);
        }
        if (url.includes('/tickers/alg-algorand')) {
          return Promise.resolve({ data: { id: 'alg-algorand', quotes: { USD: { price: 0.10 } } }, headers: {} });
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
    expect(payload.rates.AAVE!.usd).toBe(90);
    expect(payload.rates.ALGORAND!.usd).toBe(0.10);
    expect(tgSpy).not.toHaveBeenCalled();
  });
});
