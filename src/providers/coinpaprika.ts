import axios from 'axios';
import { sleep, truncateRaw } from '../utils';
import { PROVIDER_COINPAPRIKA } from '../constants';

export async function fetchCryptoFromCoinPaprika(symbols: string[]) {
  const out: Record<string, any> = {};
  if (!symbols || symbols.length === 0) return { provider: PROVIDER_COINPAPRIKA, data: out, headers: {} };
  for (const symbol of symbols) {
    try {
      const searchRes = await axios.get('https://api.coinpaprika.com/v1/search', { params: { query: symbol, limit: 5, type: 'coins' }, timeout: 10000 });
      const rawResults = searchRes.data && searchRes.data.coins ? searchRes.data.coins : searchRes.data || [];
      const results: any[] = Array.isArray(rawResults) ? rawResults : [];
      if (!results.length) {
        console.warn('CoinPaprika search returned no candidates for symbol', symbol, 'searchResponse:', truncateRaw(rawResults, 500));
        // Try a best-effort ticker lookup using the symbol as id (lowercased)
        try {
          const guessId = String(symbol).toLowerCase();
          const tickerRes = await axios.get(`https://api.coinpaprika.com/v1/tickers/${guessId}`, { timeout: 10000 });
          const quotes = tickerRes.data && tickerRes.data.quotes ? tickerRes.data.quotes : {};
          const usd = quotes.USD ? Number(quotes.USD.price) : undefined;
          const eur = quotes.EUR ? Number(quotes.EUR.price) : undefined;
          out[String(symbol).toUpperCase()] = { usd, eur };
          continue;
        } catch (guessErr: any) {
          // Not found — proceed to the normal loop (no candidates)
          console.warn('CoinPaprika best-effort ticker lookup failed for', symbol, 'error:', (guessErr as any).message || String(guessErr));
          continue;
        }
      }

      const normalized = String(symbol).toUpperCase();
      const exactIdx = results.findIndex((r: any) => String(r.symbol).toUpperCase() === normalized);
      const ordered = exactIdx >= 0 ? [results[exactIdx], ...results.slice(0, exactIdx), ...results.slice(exactIdx + 1)] : results;

      let success = false;
      const triedIds: string[] = [];
      for (const candidate of ordered) {
        if (!candidate || !candidate.id) continue;
        const id = candidate.id;
        triedIds.push(id);
        try {
          const tickerRes = await axios.get(`https://api.coinpaprika.com/v1/tickers/${id}`, { timeout: 10000 });
          const quotes = tickerRes.data && tickerRes.data.quotes ? tickerRes.data.quotes : {};
          const usd = quotes.USD ? Number(quotes.USD.price) : undefined;
          const eur = quotes.EUR ? Number(quotes.EUR.price) : undefined;
          out[String(symbol).toUpperCase()] = { usd, eur };
          success = true;
          break; // done for this symbol
        } catch (err: any) {
          const status = err?.response?.status;
          console.warn('CoinPaprika ticker failed for candidate', id, 'symbol', symbol, 'status:', status, 'error:', (err as any).message || String(err));
          if (status === 429) {
            const rh = err?.response?.headers?.['retry-after'];
            const waitSec = Number(rh) || 1;
            await sleep(waitSec * 1000 + 250);
            try {
              const tickerRes = await axios.get(`https://api.coinpaprika.com/v1/tickers/${id}`, { timeout: 10000 });
              const quotes = tickerRes.data && tickerRes.data.quotes ? tickerRes.data.quotes : {};
              const usd = quotes.USD ? Number(quotes.USD.price) : undefined;
              const eur = quotes.EUR ? Number(quotes.EUR.price) : undefined;
              out[String(symbol).toUpperCase()] = { usd, eur };
              success = true;
              break;
            } catch (err2: any) {
              console.warn('Retry of CoinPaprika ticker failed for candidate', id, 'symbol', symbol, 'error:', (err2 as any).message || String(err2));
            }
          }
        }
      }

      if (!success) {
        console.warn('CoinPaprika returned no usable ticker for symbol', symbol, 'triedIds:', triedIds.join(', '));
      }
    } catch (err: any) {
      console.warn('CoinPaprika search failed for symbol', symbol, 'error:', (err as any).message || String(err));
      // If the search call returned a 4xx for some symbols, try best-effort
      // ticker lookup using the symbol as id before giving up.
      const status = err?.response?.status;
      if (status === 400) {
        try {
          const guessId = String(symbol).toLowerCase();
          const tickerRes = await axios.get(`https://api.coinpaprika.com/v1/tickers/${guessId}`, { timeout: 10000 });
          const quotes = tickerRes.data && tickerRes.data.quotes ? tickerRes.data.quotes : {};
          const usd = quotes.USD ? Number(quotes.USD.price) : undefined;
          const eur = quotes.EUR ? Number(quotes.EUR.price) : undefined;
          out[String(symbol).toUpperCase()] = { usd, eur };
        } catch (guessErr: any) {
          console.warn('CoinPaprika fallback ticker lookup failed for', symbol, 'error:', (guessErr as any).message || String(guessErr));
        }
      }
    }
  }
  return { provider: PROVIDER_COINPAPRIKA, data: out, headers: {} };
}
