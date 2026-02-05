import axios from 'axios';
import * as notify from '../notify/telegram';
import * as firestore from '../firestore';
import { fetchAndStoreRates } from '../fetcher';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.spyOn(firestore, 'writeLatest').mockImplementation(async () => {});
jest.spyOn(firestore, 'writeSnapshot').mockImplementation(async () => {});
jest.spyOn(firestore, 'writeMonitoringLog').mockImplementation(async () => {});

describe('fetcher no crypto fallback', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.TELEGRAM_ALERTING_ENABLED = 'true';
    process.env.TELEGRAM_BOT_TOKEN = 'x';
    process.env.TELEGRAM_CHAT_ID = 'y';
  });

  it('alerts and sets provider=none when no crypto rates can be fetched', async () => {
    const tgSpy = jest.spyOn(notify, 'sendTelegramAlert').mockImplementation(async () => ({ ok: true } as any));

    mockedAxios.get.mockImplementation((url: any, _opts?: any) => {
      if (typeof url === 'string' && url.includes('coins/list')) {
        return Promise.resolve({ data: [{ id: 'bitcoin' }, { id: 'ethereum' }] });
      }
      if (typeof url === 'string' && url.includes('coingecko')) {
        // simulate no price data
        return Promise.resolve({ data: {}, headers: {} });
      }
      if (typeof url === 'string' && url.includes('api.binance.com')) {
        const e: any = new Error('geo');
        e.response = { status: 451 };
        return Promise.reject(e);
      }
      if (typeof url === 'string' && url.includes('api.coinpaprika.com')) {
        // return no candidates
        if (url.includes('/search')) {
          return Promise.resolve({ data: { coins: [] } });
        }
      }
      if (typeof url === 'string' && url.includes('eurofxref')) {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">\n  <Cube>\n    <Cube time="2026-02-04">\n      <Cube currency="USD" rate="1.08"/>\n    </Cube>\n  </Cube>\n</gesmes:Envelope>`;
        return Promise.resolve({ data: xml });
      }
      return Promise.reject(new Error('unknown url'));
    });

    const payload = await fetchAndStoreRates();
    expect(payload.provider).toBe('none');
    expect(Object.keys(payload.rates || {}).length).toBe(0);
    expect(tgSpy).toHaveBeenCalled();
    const called = tgSpy.mock.calls.some(c => String(c[0]).includes('No crypto rates were fetched'));
    expect(called).toBe(true);
    // ensure diagnostics were included in the alert
    const diagCalled = tgSpy.mock.calls.some(c => String(c[0]).includes('supportedCount') && String(c[0]).includes('recentErrors'));
    expect(diagCalled).toBe(true);
    // There should be a monitoring log entry with diagnostics
    expect(firestore.writeMonitoringLog).toHaveBeenCalled();
    const mlCalled = (firestore.writeMonitoringLog as jest.Mock).mock.calls[0][0];
    expect(mlCalled.meta && mlCalled.meta.diagnostics).toBeDefined();
  });
});
