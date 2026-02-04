import * as dotenv from 'dotenv';
import { fetchAndStoreRates } from './fetcher';
import { sendTelegramAlert } from './notify/telegram';

dotenv.config();

export async function main() {
  try {
    await fetchAndStoreRates();
    console.log('Fetch completed successfully');
    process.exit(0);
  } catch (err: any) {
    console.error('Fetch failed', err);
    // Try to notify via Telegram (only if enabled); do not let notification errors prevent exit
    try {
      const enabled = String(process.env.TELEGRAM_ALERTING_ENABLED || 'false').toLowerCase() === 'true';
      if (enabled) {
        const msg = `⚠️ Fetch failed: ${err?.message || String(err)}\n\n${err?.stack ? 'Stack:\n' + err.stack : ''}`;
        await sendTelegramAlert(msg);
      }
    } catch (e) {
      console.error('Failed to send Telegram alert', e);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
