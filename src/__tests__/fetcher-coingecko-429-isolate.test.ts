import axios from 'axios';
import * as notify from '../notify/telegram';
import * as firestore from '../firestore';
import { fetchAndStoreRates } from '../fetcher';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;



describe('CoinGecko 429 isolation', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    // Re-apply Firestore spies after reset
    jest.spyOn(firestore, 'writeLatest').mockImplementation(async () => {});
    jest.spyOn(firestore, 'writeSnapshot').mockImplementation(async () => {});
    jest.spyOn(firestore, 'writeMonitoringLog').mockImplementation(async () => {});

    process.env.TELEGRAM_ALERTING_ENABLED = 'true';
    process.env.TELEGRAM_BOT_TOKEN = 'x';
    process.env.TELEGRAM_CHAT_ID = 'y';
  });

  it('isolates ids when batch returns 429 and recovers some per-id', async () => {
    const tgSpy = jest.spyOn(notify, 'sendTelegramAlert').mockImplementation(async () => ({ ok: true } as any));
    // silence console logging for this test to avoid "Cannot log after tests are done" races
    const logMock = jest.spyOn(console, 'log').mockImplementation(() => {});

    // some scenarios involve retries/sleeps; increase timeout for this test
    jest.setTimeout(20000);

    // Configure CRYPTO_IDS to a set that will be processed in a single batch
    process.env.CRYPTO_IDS = 'aave,algorand,a7a5';

    mockedAxios.get.mockImplementation((url: any, _opts?: any) => {
      if (typeof url === 'string' && url.includes('coins/list')) {
        return Promise.resolve({ data: [{ id: 'aave' }, { id: 'algorand' }, { id: 'a7a5' }] });
      }
      if (typeof url === 'string' && url.includes('coingecko')) {
        // Simulate batch 429 for the combined call (requires comma to avoid matching per-id calls)
        if (url.includes('/simple/price') && _opts && _opts.params && _opts.params.ids && String(_opts.params.ids).includes(',') && String(_opts.params.ids).includes('aave')) {
          const e: any = new Error('rate limited');
          e.response = { status: 429, headers: { 'retry-after': '0' } };
          return Promise.reject(e);
        }
        // Per-id calls (isolation) return data for AAVE, but ALG gets 400
        if (url.includes('/simple/price') && _opts && _opts.params && String(_opts.params.ids) === 'aave') {
          return Promise.resolve({ data: { aave: { usd: 90 } }, headers: {} });
        }
        if (url.includes('/simple/price') && _opts && _opts.params && String(_opts.params.ids) === 'algorand') {
          const e: any = new Error('bad id');
          e.response = { status: 400 };
          return Promise.reject(e);
        }
        if (url.includes('/simple/price') && _opts && _opts.params && String(_opts.params.ids) === 'a7a5') {
          const e: any = new Error('bad id');
          e.response = { status: 400 };
          return Promise.reject(e);
        }
      }

      if (typeof url === 'string' && url.includes('api.binance.com')) {
        const e: any = new Error('geo');
        e.response = { status: 451 };
        return Promise.reject(e);
      }

      if (typeof url === 'string' && url.includes('api.coinpaprika.com')) {
        // Simulate CoinPaprika providing ALGORAND fallback
        if (url.includes('/search') && _opts && _opts.params && String(_opts.params.query).toUpperCase() === 'ALGORAND') {
          return Promise.resolve({ data: { coins: [{ id: 'alg-algorand', symbol: 'ALGORAND' }] } });
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
    // give the dry-run logging a moment to flush to avoid Jest "Cannot log after tests are done" races
    await new Promise((r) => setTimeout(r, 500));

    expect(payload.rates.AAVE!.usd).toBe(90);
    expect(payload.rates.ALGORAND!.usd).toBe(0.10); // recovered via CoinPaprika fallback

    // Ensure alerts were sent: one for dropped invalid ids and one for partial recovery
    expect(tgSpy).toHaveBeenCalled();
    const aggCalls = tgSpy.mock.calls.map(c => String(c[0]));
    expect(aggCalls.some(s => s.includes('Dropped unsupported CoinGecko ids'))).toBe(true);
    expect(aggCalls.some(s => s.includes('CoinGecko returned partial results'))).toBe(true);

    // restore console logging
    logMock.mockRestore();
  });
});
