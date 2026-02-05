import * as coingecko from '../providers/coingecko';
import { main } from '../scripts/warm-coingecko-cache';

jest.mock('../providers/coingecko');

describe('warm cache script', () => {
  beforeEach(() => jest.resetAllMocks());

  it('calls fetchSupportedCoinIds and returns size', async () => {
    (coingecko.fetchSupportedCoinIds as jest.Mock).mockResolvedValue(new Set(['bitcoin', 'ethereum']));
    const res = await main();
    expect(res).toBe(2);
  });
});
