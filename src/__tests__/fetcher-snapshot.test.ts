import axios from 'axios';
import * as firestore from '../firestore';
import { fetchAndStoreRates } from '../fetcher';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.spyOn(firestore, 'writeLatest').mockImplementation(async () => {});
jest.spyOn(firestore, 'writeSnapshot').mockImplementation(async () => {});
jest.spyOn(firestore, 'writeMonitoringLog').mockImplementation(async () => {});

describe('latest vs snapshot storage', () => {
  beforeEach(() => jest.resetAllMocks());

  it('writes small latest payload and full snapshot', async () => {
    const headers = {
      'Etag': 'W/"abcd"',
      'Cache-Control': 'max-age=30',
      'CF-Ray': 'abc123',
      'Server': 'cloudflare',
    };

    mockedAxios.get.mockImplementation((url: any) => {
      if (typeof url === 'string' && url.includes('coins/list')) {
        return Promise.resolve({ data: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }, { id: 'ethereum', symbol: 'eth', name: 'Ethereum' }] });
      }
      if (typeof url === 'string' && url.includes('coingecko')) {
        return Promise.resolve({ data: { bitcoin: { usd: 76038, eur: 64340 }, ethereum: { usd: 2253.76, eur: 1907.03 } }, headers });
      }
      if (typeof url === 'string' && url.includes('eurofxref')) {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">\n  <Cube>\n    <Cube time="2026-02-04">\n      <Cube currency="USD" rate="1.08"/>\n    </Cube>\n  </Cube>\n</gesmes:Envelope>`;
        return Promise.resolve({ data: xml });
      }
      return Promise.reject(new Error('unknown url'));
    });

    const payload = await fetchAndStoreRates();

    expect(payload).toHaveProperty('provider', 'coingecko');
    // latest should have minimal meta
    expect(payload.meta).toHaveProperty('fetchedAt');
    expect(payload.meta).toHaveProperty('fiatBase', 'EUR');
    expect(payload.meta.headers).toBeDefined();
    // filtered headers should include etag and cache-control only (lowercased keys)
    expect(payload.meta.headers).toHaveProperty('etag', 'W/"abcd"');
    expect(payload.meta.headers).toHaveProperty('cache-control', 'max-age=30');
    expect(payload.meta.headers).not.toHaveProperty('cf-ray');
    expect(payload.meta.headers).not.toHaveProperty('server');

    // snapshot should have been written with full rawResponse
    expect(firestore.writeSnapshot).toHaveBeenCalled();
    const snapshotArg = (firestore.writeSnapshot as jest.Mock).mock.calls[0][0];
    expect(snapshotArg.meta).toHaveProperty('rawResponse');
    expect(snapshotArg.meta.rawResponse).toMatch(/"bitcoin"/);
  });
});
