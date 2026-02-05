import axios from 'axios';
import * as notify from '../notify/telegram';
import * as firestore from '../firestore';
import { fetchAndStoreRates } from '../fetcher';

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

    mockedAxios.get.mockImplementation((url: any, opts?: any) => {
      if (typeof url === 'string' && url.includes('coins/list')) {
        return Promise.resolve({ data: [{ id: 'bitcoin' }, { id: 'ethereum' }] });
      }
      if (typeof url === 'string' && url.includes('coingecko')) {
        // only return bitcoin price, simulate failure for other batch(s)
        return Promise.resolve({ data: { bitcoin: { usd: 50000 } }, headers: { etag: 'W/"abcd"' } });
      }
      if (typeof url === 'string' && url.includes('api.coinpaprika.com')) {
        // Simulate CoinPaprika failing so we proceed with partial CoinGecko data
        const e: any = new Error('paprika-fail');
        return Promise.reject(e);
      }
      if (typeof url === 'string' && url.includes('exchangerate.host')) {
        return Promise.resolve({ data: { base: 'EUR', date: '2026-02-04', rates: { USD: 1.08 } } });
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
