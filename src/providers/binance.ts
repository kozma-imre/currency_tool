import axios from 'axios';
import { PROVIDER_BINANCE } from '../constants';

const BINANCE_URL = 'https://api.binance.com/api/v3/ticker/price';
const BINANCE_MAP: Record<string, string> = { BTCUSDT: 'BTC', ETHUSDT: 'ETH' };

export async function fetchCryptoFromBinance(symbols: string[]) {
  const out: Record<string, any> = {};
  const binanceHeaders: Record<string, string> | undefined = process.env.BINANCE_KEY ? { 'X-MBX-APIKEY': process.env.BINANCE_KEY } : undefined;
  for (const sym of symbols) {
    const pair = sym + 'USDT';
    const config: any = { params: { symbol: pair }, timeout: 10000 };
    if (binanceHeaders) config.headers = binanceHeaders;
    const res = await axios.get(BINANCE_URL, config);
    const price = Number(res.data.price);
    const mapped = BINANCE_MAP[pair] ?? sym;
    out[mapped] = { usd: price, eur: undefined };
  }
  return { provider: PROVIDER_BINANCE, data: out, headers: {} };
}
