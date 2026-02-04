import axios from 'axios';
import { sendTelegramAlert } from '../notify/telegram';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

afterEach(() => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  delete process.env.TELEGRAM_ALERTING_ENABLED;
});

test('does nothing when disabled', async () => {
  process.env.TELEGRAM_ALERTING_ENABLED = 'false';
  const res = await sendTelegramAlert('hi');
  expect(res.ok).toBe(false);
  expect(res.reason).toBe('disabled');
});

test('fails when creds missing', async () => {
  process.env.TELEGRAM_ALERTING_ENABLED = 'true';
  const res = await sendTelegramAlert('hello');
  expect(res.ok).toBe(false);
  expect(res.reason).toBe('missing-creds');
});

test('sends message when enabled and creds present', async () => {
  process.env.TELEGRAM_ALERTING_ENABLED = 'true';
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
  process.env.TELEGRAM_CHAT_ID = '12345';
  mockedAxios.post.mockResolvedValue({ data: { ok: true } });
  const res = await sendTelegramAlert('test');
  expect(res.ok).toBe(true);
});
