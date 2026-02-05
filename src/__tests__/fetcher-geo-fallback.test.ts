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

describe('fetcher geo-block fallback', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.TELEGRAM_ALERTING_ENABLED = 'true';
    process.env.TELEGRAM_BOT_TOKEN = 'x';
    process.env.TELEGRAM_CHAT_ID = 'y';
  });

  it('proceeds with partial CoinGecko data when Binance returns 451', async () => {
    const tgSpy = jest.spyOn(notify, 'sendTelegramAlert').mockImplementation(async () => ({ ok: true } as any));

    mockedAxios.get.mockImplementation((url: any, _opts?: any) => {
      if (typeof url === 'string' && url.includes('coins/list')) {
        return Promise.resolve({ data: [{ id: 'bitcoin' }, { id: 'ethereum' }] });
      }
      if (typeof url === 'string' && url.includes('coingecko')) {
        // only return bitcoin price, simulate failure for other batch(s)
        return Promise.resolve({ data: { bitcoin: { usd: 50000 } }, headers: { etag: 'W/"abcd"' } });
      }
      if (typeof url === 'string' && isHost(url, 'api.coinpaprika.com')) {
        // Simulate CoinPaprika failing so we proceed with partial CoinGecko data
        const e: any = new Error('paprika-fail');
        return Promise.reject(e);
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
    expect(payload.rates).not.toHaveProperty('ETH');
    expect(tgSpy).toHaveBeenCalled();
    const calledWith = tgSpy.mock.calls[0]![0] as string;
    expect(calledWith).toContain('CoinPaprika fallback');
  });
});
