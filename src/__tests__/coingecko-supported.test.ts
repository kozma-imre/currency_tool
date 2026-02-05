import axios from 'axios';
import * as fs from 'fs';
import { fetchSupportedCoinIds } from '../providers/coingecko';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('fetchSupportedCoinIds resilient fetch', () => {
  const CACHE = require('os').tmpdir() + '/coingecko-coins.json';
  beforeEach(() => {
    jest.resetAllMocks();
    try { fs.unlinkSync(CACHE); } catch (e) {}
    process.env.NODE_ENV = 'production'; // exercise the non-test path
  });
  afterEach(() => {
    process.env.NODE_ENV = 'test';
    try { fs.unlinkSync(CACHE); } catch (e) {}
  });

  it('forces a markets fallback if /coins/list looks truncated', async () => {
    // First /coins/list returns a tiny truncated list
    mockedAxios.get
      .mockImplementationOnce(() => Promise.resolve({ data: [{ id: 'abc' }] }))
      // markets fallback returns bitcoin + others
      .mockImplementationOnce(() => Promise.resolve({ data: [{ id: 'bitcoin' }, { id: 'ethereum' }, { id: 'litecoin' }] }));

    const ids = await fetchSupportedCoinIds();
    expect(ids.has('bitcoin')).toBe(true);
    expect(ids.has('ethereum')).toBe(true);
  });
});
