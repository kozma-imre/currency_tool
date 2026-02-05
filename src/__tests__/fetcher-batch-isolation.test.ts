import axios from 'axios';
import { fetchAndStoreRates } from '../fetcher';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

import * as firestore from '../firestore';
jest.spyOn(firestore, 'writeLatest').mockImplementation(async () => {});
jest.spyOn(firestore, 'writeSnapshot').mockImplementation(async () => {});
jest.spyOn(firestore, 'writeMonitoringLog').mockImplementation(async () => {});

describe('fetcher batch isolation for CoinGecko 400', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.CRYPTO_IDS = 'bitcoin,ethereum,figure-heloc';
  });

  afterEach(() => {
    delete process.env.CRYPTO_IDS;
  });

  it('drops invalid ids from a failing batch and continues with valid ids', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    mockedAxios.get.mockImplementation((url: any, config: any) => {
      if (url === 'https://api.coingecko.com/api/v3/coins/list') {
        return Promise.resolve({ data: [{ id: 'bitcoin' }, { id: 'ethereum' }, { id: 'figure-heloc' }] });
      }
      if (url === 'https://api.coingecko.com/api/v3/simple/price') {
        const ids = config?.params?.ids;
        // If batch contains figure-heloc and more than one id, simulate a 400 for the batch
        if (ids && ids.includes('figure-heloc') && ids.split(',').length > 1) {
          const err: any = new Error('bad request');
          err.response = { status: 400, data: { error: 'invalid ids' } };
          return Promise.reject(err);
        }
        // single-id call for figure-heloc -> also 400
        if (ids === 'figure-heloc') {
          const err: any = new Error('invalid id');
          err.response = { status: 400, data: { error: 'invalid id' } };
          return Promise.reject(err);
        }
        // otherwise return valid data for bitcoin/ethereum
        const data: any = {};
        if (ids.includes('bitcoin')) data['bitcoin'] = { usd: 50000, eur: 46000 };
        if (ids.includes('ethereum')) data['ethereum'] = { usd: 2000, eur: 1800 };
        return Promise.resolve({ data });
      }
      if (url === 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml') {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">\n  <Cube>\n    <Cube time="2026-02-04">\n      <Cube currency="USD" rate="1.08"/>\n    </Cube>\n  </Cube>\n</gesmes:Envelope>`;
        return Promise.resolve({ data: xml });
      }
      if (url === 'https://api.binance.com/api/v3/ticker/price') {
        const sym = config?.params?.symbol;
        if (sym && sym.toUpperCase().includes('FIGURE')) {
          const err: any = new Error('geo');
          err.response = { status: 451 };
          return Promise.reject(err);
        }
        return Promise.resolve({ data: { price: '1' } });
      }
      return Promise.reject(new Error('unknown url'));
    });

    const payload = await fetchAndStoreRates();

    expect(payload.provider).toBe('coingecko');
    // rates are keyed by base fiat
    expect(payload.rates.USD).toHaveProperty('BTC');
    expect(payload.rates.USD).toHaveProperty('ETH');
    // ensure the invalid id was effectively dropped
    expect(Object.keys(payload.rates.USD).map(s => s.toUpperCase()).includes('FIGURE-HELOC')).toBeFalsy();

    // cleanup
    (console.warn as jest.Mock).mockRestore();
  });
});
