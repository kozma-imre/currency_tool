import axios from 'axios';
import { fetchCryptoFromCoinPaprika, fetchTopCoinpaprikaIds } from '../providers/coinpaprika';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;
import * as fs from 'fs';
import * as os from 'os';

const COINPAPRIKA_TOP_CACHE_FILE = require('path').join(os.tmpdir(), 'coinpaprika-top.json');

describe('CoinPaprika 400 -> top-list mapping fallback', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    try { if (fs.existsSync(COINPAPRIKA_TOP_CACHE_FILE)) fs.unlinkSync(COINPAPRIKA_TOP_CACHE_FILE); } catch (e) { /* ignore */ }
  });

  it('uses top-list mapping when search returns 400', async () => {
    const symbol = 'AAVE';

    mockedAxios.get.mockImplementation((url: any) => {
      if (String(url).includes('/search')) {
        const err: any = new Error('Bad Request');
        err.response = { status: 400 };
        return Promise.reject(err);
      }
      if (String(url).includes('/tickers') && !String(url).includes('/tickers/')) {
        // top tickers list
        return Promise.resolve({ data: [{ id: 'aave-aave', symbol: 'AAVE', name: 'Aave' }] });
      }
      if (String(url).includes('/tickers/aave-aave')) {
        return Promise.resolve({ data: { id: 'aave-aave', quotes: { USD: { price: 45.2 } } } });
      }
      return Promise.reject(new Error('unexpected url ' + url));
    });

    // First, ensure fetchTopCoinpaprikaIds returns the expected mapping
    const top = await fetchTopCoinpaprikaIds(10);
    expect(Array.isArray(top)).toBeTruthy();
    expect(top.some(t => t.id === 'aave-aave' && t.symbol === 'AAVE')).toBeTruthy();

    const res = await fetchCryptoFromCoinPaprika([symbol]);
    // Ensure expected axios endpoints were requested
    const calledUrls = mockedAxios.get.mock.calls.map(c => String(c[0] || c[1] || 'no url'));
    expect(calledUrls.some(u => u.includes('/tickers'))).toBeTruthy();
    expect(calledUrls.some(u => u.includes('/tickers/aave-aave'))).toBeTruthy();
    expect(res.data.AAVE).toBeDefined();
    expect(res.data.AAVE.usd).toBeCloseTo(45.2);
  });
});
