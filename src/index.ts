import * as dotenv from 'dotenv';
import { fetchAndStoreRates } from './fetcher';

dotenv.config();

async function main() {
  try {
    await fetchAndStoreRates();
    console.log('Fetch completed successfully');
    process.exit(0);
  } catch (err) {
    console.error('Fetch failed', err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
