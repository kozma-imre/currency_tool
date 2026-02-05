import axios from 'axios';
import { fetchTopCoinpaprikaTickers } from '../providers/coinpaprika';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('CoinPaprika top tickers', () => {
  beforeEach(() => jest.resetAllMocks());

  it('fetches top N tickers and maps to symbol->{usd,eur}', async () => {
    mockedAxios.get.mockImplementation((url: any, opts?: any) => {
      if (String(url).includes('/tickers') && !String(url).includes('/tickers/')) {
        return Promise.resolve({ data: [
          { id: 'a-one', symbol: 'A', name: 'A Coin', quotes: { USD: { price: 1.2 }, EUR: { price: 1.0 } } },
          { id: 'b-two', symbol: 'B', name: 'B Coin', quotes: { USD: { price: 2.5 } } },
        ] });
      }
      return Promise.reject(new Error('unexpected url ' + url));
    });

    const res = await fetchTopCoinpaprikaTickers(2);
    expect(res.A).toBeDefined();
    expect(res.A!.usd).toBeCloseTo(1.2);
    expect(res.A!.eur).toBeCloseTo(1.0);
    expect(res.B).toBeDefined();
    expect(res.B!.usd).toBeCloseTo(2.5);
  });
});
