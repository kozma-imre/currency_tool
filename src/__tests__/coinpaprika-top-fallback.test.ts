import axios from 'axios';
import { fetchCryptoFromCoinPaprika, fetchTopCoinpaprikaIds } from '../providers/coinpaprika';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;
import * as fs from 'fs';
import * as os from 'os';
const COINPAPRIKA_TOP_CACHE_FILE = require('path').join(os.tmpdir(), 'coinpaprika-top.json');

describe('CoinPaprika top-list fallback', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    try { if (fs.existsSync(COINPAPRIKA_TOP_CACHE_FILE)) fs.unlinkSync(COINPAPRIKA_TOP_CACHE_FILE); } catch (e) { /* ignore */ }
  });

  it('uses top-list mapping when search returns no candidates', async () => {
    const symbol = 'ALGORAND';
    // Implement mocked axios.get that responds based on the requested URL
    mockedAxios.get.mockImplementation((url: any) => {
      if (String(url).includes('/search')) {
        return Promise.resolve({ data: { coins: [] } });
      }
      if (String(url).includes('/tickers') && !String(url).includes('/tickers/')) {
        // top tickers list
        return Promise.resolve({ data: [{ id: 'alg-algorand', symbol: 'ALGORAND', name: 'Algorand' }] });
      }
      if (String(url).includes('/tickers/alg-algorand')) {
        return Promise.resolve({ data: { id: 'alg-algorand', quotes: { USD: { price: 0.10 } } } });
      }
      return Promise.reject(new Error('unexpected url ' + url));
    });

    const res = await fetchCryptoFromCoinPaprika([symbol]);
    // debug log
    console.log('TOP-FALLBACK RES', JSON.stringify(res, null, 2));
    expect(res.data.ALGORAND).toBeDefined();
    expect(res.data.ALGORAND.usd).toBeCloseTo(0.10);
  });
});
