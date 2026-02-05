import axios from 'axios';
import * as crypto from 'crypto';
import { initFirestore, writeLatest, writeSnapshot, writeMonitoringLog } from './firestore';
import { sendTelegramAlert } from './notify/telegram';
import type { RatesResult } from './types';
import { PROVIDER_COINGECKO, PROVIDER_BINANCE, PROVIDER_COINPAPRIKA, PROVIDER_COINGECKO_BINANCE, PROVIDER_COINGECKO_COINPAPRIKA, PROVIDER_NONE } from './constants';
import { fetchSupportedCoinIds, fetchTopCoinIds, fetchCryptoFromCoingecko } from './providers/coingecko';
import { fetchCryptoFromBinance } from './providers/binance';
import { fetchCryptoFromCoinPaprika } from './providers/coinpaprika';
import { retry, truncateRaw } from './utils';

const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';


const COINGECKO_MAP: Record<string, string> = { bitcoin: 'BTC', ethereum: 'ETH' };




// CoinPaprika is a public API we use as a fallback. We search by symbol then fetch tickers.
// Improve robustness: try multiple search candidates and tolerate per-candidate failures


async function fetchFiat() {
  // ECB publishes a simple XML feed with EUR as the base. We parse it here
  // to produce { base, date, rates } similar to exchangerate.host output.
  const res = await axios.get(ECB_URL, { timeout: 10000, responseType: 'text' });
  const xml: string = res.data;
  // extract date: <Cube time="YYYY-MM-DD"> ... </Cube>
  const timeMatch = xml.match(/<Cube\s+time=['"]([^'"\s]+)['"]/i);
  const date = timeMatch ? timeMatch[1] : undefined;
  const rates: Record<string, number> = {};
  // match <Cube currency="USD" rate="1.0812"/>
  const re = /<Cube\s+currency=['"]([A-Z]+)['"]\s+rate=['"]([0-9.]+)['"]\s*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const curr = m[1];
    const rateStr = m[2];
    if (curr && rateStr) {
      const rate = Number(rateStr);
      if (!Number.isNaN(rate)) {
        rates[curr] = rate;
      }
    }
  }
  return { base: 'EUR', date, rates };
}


export async function fetchAndStoreRates() {
  await initFirestore();
  let runId: string;
  try {
    runId = (crypto as any).randomUUID ? (crypto as any).randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  } catch (e) {
    runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  const start = Date.now();

  // Read configured cryptos / fiats from env (defaults)
  const rawConfigured = (process.env.CRYPTO_IDS ?? 'bitcoin,ethereum').trim();
  const fiatCurrencies = (process.env.FIAT_CURRENCIES ?? 'usd,eur').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  // Support top-N via `CRYPTO_IDS=top:100` or env `CRYPTO_USE_TOP_N=100`
  let configuredIds: string[] = [];
  const topMatch = /^top:(\d+)$/i.exec(rawConfigured);
  const topEnvN = process.env.CRYPTO_USE_TOP_N ? Number(process.env.CRYPTO_USE_TOP_N) : undefined;
  if (topMatch || topEnvN) {
    const n = topMatch ? Number(topMatch[1]) : (topEnvN || 100);
    const topSet = await fetchTopCoinIds(n);
    configuredIds = Array.from(topSet);
  } else {
    configuredIds = rawConfigured.split(',').map(s => s.trim()).filter(Boolean);
  }
  // For CoinGecko we only request common fiat bases (usd, eur) to avoid unsupported fiats; ECB will be used to expand others
  const coinGeckoFiats = fiatCurrencies.filter(f => ['usd', 'eur'].includes(f));
  if (!coinGeckoFiats.length) {
    coinGeckoFiats.push('usd', 'eur'); // ensure at least USD/EUR
  }


  let provider = PROVIDER_COINGECKO;
  let cryptoResult: any;

  // Validate configured CRYPTO_IDS against CoinGecko /coins/list
  const supportedIds = await fetchSupportedCoinIds();
  const filteredIds = configuredIds.filter(id => supportedIds.has(id));

  // Diagnostics to report when provider ends up as 'none'
  const diagnostics: { supportedCount?: number; droppedIds?: string[]; recentErrors: string[] } = { supportedCount: supportedIds.size, droppedIds: [], recentErrors: [] };
  const addErrorMsg = (ctx: string, e: any) => {
    try {
      const m = (e && (e.message || e.response && e.response.status && String(e.response.status))) || String(e);
      diagnostics.recentErrors.push(`${ctx}: ${m}`);
    } catch (_) {
      diagnostics.recentErrors.push(`${ctx}: (unknown error)`);
    }
  };

  if (filteredIds.length === 0) {
    console.warn('No configured CRYPTO_IDS are supported by CoinGecko; proceeding to CoinPaprika fallback or ECB-only.');
    // Ensure we have a safe default so later code that reads `cryptoResult` does not crash.
    cryptoResult = { provider: PROVIDER_NONE, data: {}, headers: {} } as any;
    provider = PROVIDER_NONE;
  } else {
    if (filteredIds.length < configuredIds.length) {
      const dropped = configuredIds.filter(id => !supportedIds.has(id));
      diagnostics.droppedIds = dropped;
      const sample = Array.from(supportedIds).slice(0, 10);
      console.warn(`Dropping unsupported CoinGecko ids: ${JSON.stringify(dropped)} (supportedCount=${supportedIds.size}, sampleSupported=${sample.join(', ')})`);
    }
    try {
      // Try CoinGecko first (batched). If no results, fall back to CoinPaprika.
      cryptoResult = await fetchCryptoFromCoingecko(filteredIds, coinGeckoFiats);
      const missingIds: string[] = cryptoResult.missing || [];
      const succeededCount = Object.keys(cryptoResult.data || {}).length;
      if (missingIds.length) {
        const missingSymbols = missingIds.map(id => COINGECKO_MAP[id] ?? id.toUpperCase());
        try {
          // Try Binance for missing symbols first
          const binRes = await retry(() => fetchCryptoFromBinance(missingSymbols), 2);
          cryptoResult.data = { ...(cryptoResult.data || {}), ...(binRes.data || {}) };
          provider = succeededCount > 0 ? PROVIDER_COINGECKO_BINANCE : PROVIDER_BINANCE;
        } catch (binErr: any) {
          console.warn('Binance fallback failed for missing symbols', (binErr as any).message || String(binErr));
          // Try CoinPaprika fallback regardless of Binance error
          try {
            const ccRes = await retry(() => fetchCryptoFromCoinPaprika(missingSymbols), 1);
            if (ccRes && ccRes.data && Object.keys(ccRes.data).length > 0) {
              cryptoResult.data = { ...(cryptoResult.data || {}), ...(ccRes.data || {}) };
                // If CoinPaprika returned any data for missing symbols, prefer
                // a mixed label if CoinGecko provided some data. If CoinGecko
                // returned no data, prefer CoinPaprika when it provided data
                // for multiple symbols; otherwise use legacy 'binance' label
                // for single-symbol fallback to preserve historical semantics.
                if (succeededCount > 0) {
                  provider = PROVIDER_COINGECKO_COINPAPRIKA;
                } else {
                  const ccKeys = Object.keys(ccRes.data || {});
                  if (process.env.BINANCE_KEY) {
                    provider = PROVIDER_COINPAPRIKA;
                  } else {
                    provider = ccKeys.length > 1 ? PROVIDER_COINPAPRIKA : PROVIDER_BINANCE;
                  }
                }
            } else {
              console.warn('CoinPaprika returned no data for missing symbols; proceeding with partial CoinGecko data.');
              try { await sendTelegramAlert(`CoinPaprika fallback returned no data for missing symbols: ${missingSymbols.join(', ')}`); } catch (e) {}
            }
          } catch (ccErr: any) {
            console.warn('CoinPaprika fallback failed for missing symbols', (ccErr as any).message || String(ccErr));
            try { await sendTelegramAlert(`CoinPaprika fallback failed for missing symbols: ${missingSymbols.join(', ')}. Error: ${(ccErr as any).message || String(ccErr)}`); } catch (e) {}
          }
        }
        const finalCount = Object.keys(cryptoResult.data || {}).length;
        if (finalCount === 0) provider = PROVIDER_NONE;
      } else if (succeededCount === 0) {
        // full failure from CoinGecko - try Binance then CoinPaprika
        const symbolsForFallback = (filteredIds.length ? filteredIds : configuredIds).map((id: string) => COINGECKO_MAP[id] ?? id.toUpperCase());
        try {
          const binRes = await retry(() => fetchCryptoFromBinance(symbolsForFallback), 2);
          cryptoResult = binRes;
          provider = PROVIDER_BINANCE;
        } catch (binErr: any) {
          console.warn('Binance fallback failed on full fallback', (binErr as any).message || String(binErr));
          // Try CoinPaprika as a public fallback in full-failure scenarios
          try {
            const ccRes = await retry(() => fetchCryptoFromCoinPaprika(symbolsForFallback), 1);
            if (ccRes && ccRes.data && Object.keys(ccRes.data).length > 0) {
              cryptoResult = ccRes;
              // If CoinPaprika returned any data for our requested symbols,
              // prefer the explicit 'coinpaprika' provider label for clarity.
              provider = PROVIDER_COINPAPRIKA;
            } else {
              console.warn('CoinPaprika returned no data on full fallback; proceeding with ECB-only fiat data.');
              cryptoResult = { provider: PROVIDER_NONE, data: {}, headers: {} } as any;
              provider = PROVIDER_NONE;
            }
          } catch (ccErr: any) {
            console.warn('CoinPaprika fallback failed on full fallback', (ccErr as any).message || String(ccErr));
            cryptoResult = { provider: 'none', data: {}, headers: {} } as any;
            provider = 'none';
          }
        }
      }
    } catch (err) {
      console.warn('CoinGecko fetch failed; attempting Binance then CoinPaprika fallback', (err as any).message || String(err));
      addErrorMsg('coingecko-full-fail', err);
      const symbolsForFallback = (filteredIds.length ? filteredIds : configuredIds).map((id: string) => COINGECKO_MAP[id] ?? id.toUpperCase());
      try {
        const binRes = await retry(() => fetchCryptoFromBinance(symbolsForFallback), 2);
        cryptoResult = binRes;
        provider = PROVIDER_BINANCE;
      } catch (binErr: any) {
        addErrorMsg('binance-full-fail', binErr);
        const status = binErr?.response?.status;
        if (status === 451) {
          console.warn('Binance returned 451 on full fallback; attempting CoinPaprika as a public fallback.');
          try {
            const ccRes = await retry(() => fetchCryptoFromCoinPaprika(symbolsForFallback), 1);
            if (ccRes && ccRes.data && Object.keys(ccRes.data).length > 0) {
              cryptoResult = ccRes;
              // If CoinPaprika returned any data for our requested symbols,
              // prefer the explicit 'coinpaprika' provider label for clarity.
              provider = PROVIDER_COINPAPRIKA;
            } else {
              console.warn('CoinPaprika returned no data on full fallback; proceeding with ECB-only fiat data.');
              cryptoResult = { provider: PROVIDER_NONE, data: {}, headers: {} } as any;
              provider = PROVIDER_NONE;
            }
          } catch (ccErr: any) {
            console.warn('CoinPaprika fallback failed on full fallback', (ccErr as any).message || String(ccErr));
            addErrorMsg('coinpaprika-full-fail', ccErr);
            cryptoResult = { provider: 'none', data: {}, headers: {} } as any;
            provider = 'none';
          }
        } else {
          console.warn('Binance fallback failed on full fallback', (binErr as any).message || String(binErr));
          cryptoResult = { provider: PROVIDER_NONE, data: {}, headers: {} } as any;
          provider = PROVIDER_NONE;
        }
      }
    }
  }

  const fiat = await retry(fetchFiat, 2);

  // Persist ECB fiat data separately to Firestore for easy access
  try {
    const ecbPayload = { timestamp: new Date().toISOString(), base: fiat?.base ?? 'EUR', rates: fiat?.rates ?? {} };
    // import writeLatestFiat from firestore module
    try {
      // dynamic import to avoid circular issues in some test setups
      const fsMod = await import('./firestore');
      if (typeof fsMod.writeLatestFiat === 'function') {
        await fsMod.writeLatestFiat(ecbPayload);
      }
    } catch (e) {
      console.log('Could not write latest fiat to Firestore (dry-run or missing function).', (e as any).message || String(e));
    }
  } catch (e) {
    console.warn('Failed to persist ECB fiat data to Firestore', (e as any).message || String(e));
  }

  const rates: RatesResult = {};
  // Normalize raw provider result into symbol -> { usd?, eur? }
  if (cryptoResult.provider === PROVIDER_COINGECKO) {
    for (const [id, vals] of Object.entries(cryptoResult.data)) {
      const symbol = COINGECKO_MAP[id] ?? id.toUpperCase();
      rates[symbol] = vals as any; // e.g. { usd: 123, eur: 110 }
    }
  } else {
    for (const [symbol, vals] of Object.entries(cryptoResult.data)) {
      rates[symbol] = vals as any; // binance returns { usd: price, eur: undefined }
    }
  }

  // Expand rates to include all requested fiatCurrencies using ECB conversions if necessary
  const ecbRates: Record<string, number> = (fiat && fiat.rates) ? fiat.rates : {};

  function convertUsingEcb(value: number | undefined, from: string | undefined, to: string): number | undefined {
    if (value == null || !from) return undefined;
    const upperTo = to.toUpperCase();
    const upperFrom = from.toUpperCase();
    // If ECB base is same as 'from' or 'to', compute relative
    // ECB provides rates as: rate[X] = X per 1 EUR (if base EUR), so conversion factor from 'from' to 'to' is rate[to]/rate[from]
    const rateTo = ecbRates[upperTo];
    const rateFrom = ecbRates[upperFrom];
    if (rateTo == null || rateFrom == null) return undefined;
    return value * (rateTo / rateFrom);
  }

  // For each symbol, for each requested fiat, fill missing values by converting from usd or eur
  for (const [sym, vals] of Object.entries(rates)) {
    const target: Record<string, any> = {};
    // copy existing known lowercase keys
    const existingLower: Record<string, number> = {};
    for (const [k, v] of Object.entries(vals as any)) {
      existingLower[String(k).toLowerCase()] = v as number;
    }
    // Try to ensure usd and eur exist by using what is available
    for (const base of ['usd', 'eur']) {
      if (existingLower[base] == null) {
        // try to derive from the other if possible using ECB
        const other = base === 'usd' ? 'eur' : 'usd';
        if (existingLower[other] != null) {
          const conv = convertUsingEcb(existingLower[other], other, base);
          if (conv != null) existingLower[base] = conv;
        }
      }
    }
    // For every requested fiat currency, compute final value
    for (const fiatTarget of fiatCurrencies) {
      if (existingLower[fiatTarget] != null) {
        target[fiatTarget] = existingLower[fiatTarget];
        continue;
      }
      // Prefer converting from USD then EUR
      let computed: number | undefined = undefined;
      if (existingLower['usd'] != null) {
        computed = convertUsingEcb(existingLower['usd'], 'USD', fiatTarget);
      }
      if (computed == null && existingLower['eur'] != null) {
        computed = convertUsingEcb(existingLower['eur'], 'EUR', fiatTarget);
      }
      if (computed != null) target[fiatTarget] = Number(computed);
    }
    rates[sym] = target as any;
  }

  const headersObj = (cryptoResult.headers && typeof (cryptoResult.headers as any).toJSON === 'function')
    ? (cryptoResult.headers as any).toJSON()
    : JSON.parse(JSON.stringify(cryptoResult.headers ?? {}));

  // Whitelist headers we want to keep in the lightweight `latest` doc
  const HEADER_WHITELIST = ['etag', 'cache-control', 'date', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'];
  const filteredHeaders: Record<string, any> = {};
  for (const [k, v] of Object.entries(headersObj || {})) {
    const lk = String(k).toLowerCase();
    if (HEADER_WHITELIST.includes(lk)) {
      filteredHeaders[lk] = v;
    }
  }

  const fetchedAt = new Date().toISOString();

  // If we failed to obtain any crypto rates at all, ensure we mark provider as 'none'
  // and alert so the operator knows something went wrong while still preserving fiat writes.
  if (!Object.keys(rates).length) {
    console.warn('No crypto rates available after fallbacks; marking provider as none and sending alert');
    provider = 'none';
    try {
      const detail = `No crypto rates were fetched for configured symbols; only fiat rates written to Firestore.`;
      // Append diagnostics to the alert for operator visibility
      const diag = JSON.stringify({ supportedCount: diagnostics.supportedCount, droppedIds: diagnostics.droppedIds, recentErrors: diagnostics.recentErrors.slice(-10) }, null, 2);
      const message = `${detail}\n\nDiagnostics:\n${diag}`;
      try { await sendTelegramAlert(message); } catch (e) { addErrorMsg('telegram-send-fail', e); }
      // also write monitoring log with diagnostics for observability
      try { await writeMonitoringLog({ runId, provider, operation: 'fetch_and_store', durationMs: Date.now() - start, status: 'warn', meta: { fetchedAt, diagnostics } }); } catch (e) { addErrorMsg('writeMonitoringLog-fail', e); }
    } catch (e) {
      // ignore alert sending failure
    }
  }

  // Minimal payload for `latest` — small and stable for clients
  const latestPayload = {
    provider,
    timestamp: fetchedAt,
    rates,
    meta: {
      fetchedAt,
      fiatBase: fiat?.base ?? 'EUR',
      headers: filteredHeaders,
    },
  };

  // Full snapshot with raw response and more verbose metadata for debugging/audit
  const snapshotPayload = {
    provider,
    timestamp: fetchedAt,
    rates,
    meta: {
      fetchedAt,
      fiatBase: fiat?.base ?? 'EUR',
      headers: headersObj,
      rawResponse: truncateRaw(cryptoResult.data),
    },
  };

  const durationMs = Date.now() - start;
  await writeMonitoringLog({ runId, provider, operation: 'fetch_and_store', durationMs, status: 'ok', meta: { fetchedAt }, timestamp: new Date().toISOString() });

  await writeLatest(latestPayload);
  await writeSnapshot(snapshotPayload, new Date());

  return latestPayload;
}
