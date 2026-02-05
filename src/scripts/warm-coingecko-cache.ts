import { fetchSupportedCoinIds } from '../providers/coingecko';

export async function main() {
  try {
    const ids = await fetchSupportedCoinIds();
    console.log('Warmup complete: loaded', ids.size, 'CoinGecko ids');
    return ids.size;
  } catch (e: any) {
    console.error('Warmup failed:', e?.message || String(e));
    throw e;
  }
}

if (require.main === module) {
  main().catch(() => process.exit(1));
}
