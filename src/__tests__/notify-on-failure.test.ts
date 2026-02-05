import * as fetcher from '../fetcher';
import * as telegram from '../notify/telegram';
import { main } from '../index';

jest.mock('../fetcher');
jest.mock('../notify/telegram');

describe('notify on fetch failure', () => {
  const realEnv = process.env;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...realEnv };
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((_code?: number) => {}) as any);
  });

  afterEach(() => {
    process.env = realEnv;
    exitSpy.mockRestore();
  });

  it('sends Telegram alert when fetch fails and alerting enabled', async () => {
    (fetcher.fetchAndStoreRates as jest.Mock).mockRejectedValue(new Error('boom'));
    const sendMock = (telegram.sendTelegramAlert as jest.Mock).mockResolvedValue({ ok: true });
    process.env.TELEGRAM_ALERTING_ENABLED = 'true';
    process.env.TELEGRAM_BOT_TOKEN = 'tok';
    process.env.TELEGRAM_CHAT_ID = '123';

    await main();

    expect(sendMock).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('still exits when telegram send fails', async () => {
    (fetcher.fetchAndStoreRates as jest.Mock).mockRejectedValue(new Error('boom2'));
    const sendMock = (telegram.sendTelegramAlert as jest.Mock).mockRejectedValue(new Error('tg-fail'));
    process.env.TELEGRAM_ALERTING_ENABLED = 'true';
    process.env.TELEGRAM_BOT_TOKEN = 'tok';
    process.env.TELEGRAM_CHAT_ID = '123';

    await main();

    expect(sendMock).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does not call telegram when alerting disabled', async () => {
    (fetcher.fetchAndStoreRates as jest.Mock).mockRejectedValue(new Error('boom3'));
    const sendMock = (telegram.sendTelegramAlert as jest.Mock).mockResolvedValue({ ok: true });
    process.env.TELEGRAM_ALERTING_ENABLED = 'false';

    await main();

    expect(sendMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
