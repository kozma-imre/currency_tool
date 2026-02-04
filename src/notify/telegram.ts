import axios from 'axios';

export async function sendTelegramAlert(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const enabled = String(process.env.TELEGRAM_ALERTING_ENABLED || 'false').toLowerCase() === 'true';
  if (!enabled) return { ok: false, reason: 'disabled' };
  if (!token || !chatId) return { ok: false, reason: 'missing-creds' };

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await axios.post(url, { chat_id: chatId, text, disable_web_page_preview: true });
    return { ok: true, data: res.data };
  } catch (err: any) {
    console.error('sendTelegramAlert failed', err?.message || err);
    return { ok: false, reason: 'failed', error: String(err) };
  }
}
