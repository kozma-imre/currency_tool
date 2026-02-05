import axios from 'axios';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sleep, truncateRaw, retry } from '../utils';
import { PROVIDER_COINPAPRIKA } from '../constants';

const COINPAPRIKA_TOP_CACHE_FILE = path.join(os.tmpdir(), 'coinpaprika-top.json');
const COINPAPRIKA_TOP_CACHE_TTL = Number(process.env.COINPAPRIKA_TOP_CACHE_TTL) || 24 * 60 * 60; // seconds
const COINPAPRIKA_TOP_N = Number(process.env.COINPAPRIKA_TOP_N) || 250;

export async function fetchTopCoinpaprikaIds(n = COINPAPRIKA_TOP_N): Promise<Array<{ id: string; symbol: string; name: string }>> {
  try {
    if (fs.existsSync(COINPAPRIKA_TOP_CACHE_FILE)) {
      const raw = fs.readFileSync(COINPAPRIKA_TOP_CACHE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.ts && (Date.now() - parsed.ts) < COINPAPRIKA_TOP_CACHE_TTL * 1000) {
        return parsed.data || [];
      }
    }
  } catch (e) {
    // ignore cache read errors
  }

  // CoinPaprika doesn't have a single 'top' list endpoint; use tickers and limit
  const res = await retry(() => axios.get('https://api.coinpaprika.com/v1/tickers', { params: { limit: n }, timeout: 15000 }), 2);
  const data = Array.isArray(res.data) ? res.data.map((d: any) => ({ id: d.id, symbol: d.symbol, name: d.name })) : [];
  try {
    fs.writeFileSync(COINPAPRIKA_TOP_CACHE_FILE, JSON.stringify({ ts: Date.now(), data }), 'utf8');
  } catch (e) {
    console.warn('Failed to write CoinPaprika top cache:', (e as any).message || String(e));
  }
  return data;
}

export async function fetchCryptoFromCoinPaprika(symbols: string[]) {
  const out: Record<string, any> = {};
  if (!symbols || symbols.length === 0) return { provider: PROVIDER_COINPAPRIKA, data: out, headers: {} };

  // If we have many symbols, prefetch a top-list to attempt mappings to CoinPaprika ids
  let topList: Array<{ id: string; symbol: string; name: string }> | undefined;
  const needTop = symbols.length > 5;
  if (needTop) {
    try {
      topList = await fetchTopCoinpaprikaIds(Math.max(COINPAPRIKA_TOP_N, symbols.length));
    } catch (e) {
      console.warn('Failed to fetch CoinPaprika top list:', (e as any).message || String(e));
    }
  }

  // Build lookup maps if topList available
  const symbolMap: Record<string, string> = {}; // UPPER(symbol) -> id
  const nameMap: Record<string, string> = {}; // normalized name -> id
  if (topList && topList.length) {
    for (const item of topList) {
      symbolMap[String(item.symbol).toUpperCase()] = item.id;
      const norm = String(item.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (norm) nameMap[norm] = item.id;
    }
  }

  for (const symbol of symbols) {
    try {
      const searchRes = await axios.get('https://api.coinpaprika.com/v1/search', { params: { query: symbol, limit: 5, type: 'coins' }, timeout: 10000 });
      const rawResults = searchRes.data && searchRes.data.coins ? searchRes.data.coins : searchRes.data || [];
      const results: any[] = Array.isArray(rawResults) ? rawResults : [];
      if (!results.length) {
        console.warn('CoinPaprika search returned no candidates for symbol', symbol, 'searchResponse:', truncateRaw(rawResults, 500));
        // If we haven't prefetched topList yet, try to fetch it on-demand - helps small sets too
        if (!topList) {
          try {
            topList = await fetchTopCoinpaprikaIds(Math.max(COINPAPRIKA_TOP_N, symbols.length));
            // rebuild maps
            for (const item of topList) {
              symbolMap[String(item.symbol).toUpperCase()] = item.id;
              const norm = String(item.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
              if (norm) nameMap[norm] = item.id;
            }
          } catch (e) {
            console.warn('CoinPaprika top-list fetch failed during fallback mapping:', (e as any).message || String(e));
          }
        }

        // Try lookup from topList maps
        let mappedId: string | undefined;
        if (symbolMap && symbolMap[String(symbol).toUpperCase()]) {
          mappedId = symbolMap[String(symbol).toUpperCase()];
          console.warn('CoinPaprika: matched symbol via top list mapping', symbol, '->', mappedId);
        }
        if (!mappedId && nameMap) {
          const norm = String(symbol).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          if (norm && nameMap[norm]) {
            mappedId = nameMap[norm];
            console.warn('CoinPaprika: matched name via top list mapping', symbol, '->', mappedId);
          }
        }
        if (mappedId) {
          try {
            const tickerRes = await axios.get(`https://api.coinpaprika.com/v1/tickers/${mappedId}`, { timeout: 10000 });
            const quotes = tickerRes.data && tickerRes.data.quotes ? tickerRes.data.quotes : {};
            const usd = quotes.USD ? Number(quotes.USD.price) : undefined;
            const eur = quotes.EUR ? Number(quotes.EUR.price) : undefined;
            out[String(symbol).toUpperCase()] = { usd, eur };
            continue;
          } catch (e) {
            console.warn('CoinPaprika mapped ticker failed for', mappedId, 'symbol', symbol, 'error:', (e as any).message || String(e));
          }
        }
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
        // Try to fetch top-list and perform mapping fallback similar to empty search flow
        console.warn('CoinPaprika search returned 400 for symbol', symbol, '; attempting top-list mapping fallback');
        try {
          // Always attempt to fetch a top list on 400 to increase chance of mapping
          topList = await fetchTopCoinpaprikaIds(Math.max(COINPAPRIKA_TOP_N, symbols.length));
          // rebuild maps
          for (const item of topList) {
            symbolMap[String(item.symbol).toUpperCase()] = item.id;
            const norm = String(item.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
            if (norm) nameMap[norm] = item.id;
          }
        } catch (e) {
          console.warn('CoinPaprika top-list fetch failed during 400 fallback:', (e as any).message || String(e));
        }

        let mappedId: string | undefined;
        if (symbolMap && symbolMap[String(symbol).toUpperCase()]) {
          mappedId = symbolMap[String(symbol).toUpperCase()];
          console.warn('CoinPaprika: matched symbol via top list mapping (400 fallback)', symbol, '->', mappedId);
        }
        if (!mappedId && nameMap) {
          const norm = String(symbol).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          if (norm && nameMap[norm]) {
            mappedId = nameMap[norm];
            console.warn('CoinPaprika: matched name via top list mapping (400 fallback)', symbol, '->', mappedId);
          }
        }
        if (mappedId) {
          try {
            // Attempt a direct axios get (wrapped in retry) for the mapped id
            const tickerRes = await retry(() => axios.get(`https://api.coinpaprika.com/v1/tickers/${mappedId}`, { timeout: 10000 }), 2);
            const quotes = tickerRes.data && tickerRes.data.quotes ? tickerRes.data.quotes : {};
            const usd = quotes.USD ? Number(quotes.USD.price) : undefined;
            const eur = quotes.EUR ? Number(quotes.EUR.price) : undefined;
            out[String(symbol).toUpperCase()] = { usd, eur };
            continue;
          } catch (mappedErr: any) {
            console.warn('CoinPaprika mapped ticker failed during 400 fallback for', mappedId, 'symbol', symbol, 'error:', (mappedErr as any).message || String(mappedErr));
          }
        }

        // Fallback to guess id lookup
        try {
          const guessId = String(symbol).toLowerCase();
          const tickerRes = await retry(() => axios.get(`https://api.coinpaprika.com/v1/tickers/${guessId}`, { timeout: 10000 }), 2);
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
