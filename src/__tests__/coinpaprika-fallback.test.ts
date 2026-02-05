import axios from 'axios';
import { fetchCryptoFromCoinPaprika } from '../providers/coinpaprika';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('CoinPaprika search fallback', () => {
  beforeEach(() => jest.resetAllMocks());

  it('falls back to ticker lookup when search returns 400', async () => {
    const symbol = 'algorand';
    const err: any = new Error('bad request');
    err.response = { status: 400, data: 'bad' };
    // search fails
    mockedAxios.get
      .mockImplementationOnce(() => Promise.reject(err))
      // then ticker guess succeeds
      .mockImplementationOnce(() => Promise.resolve({ data: { id: 'alg-algorand', quotes: { USD: { price: 0.10 } } } }));

    const res = await fetchCryptoFromCoinPaprika([symbol]);
    expect(res.data.ALGORAND).toBeDefined();
    expect(res.data.ALGORAND.usd).toBeCloseTo(0.10);
  });
});
