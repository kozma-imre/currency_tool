import axios from 'axios';
import * as firestore from '../firestore';
import { fetchAndStoreRates } from '../fetcher';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.spyOn(firestore, 'writeLatest').mockImplementation(async () => {});
jest.spyOn(firestore, 'writeSnapshot').mockImplementation(async () => {});
jest.spyOn(firestore, 'writeMonitoringLog').mockImplementation(async () => {});

jest.spyOn(firestore, 'writeLatestFiat').mockImplementation(async () => {});
jest.spyOn(firestore, 'writeSnapshotFiat').mockImplementation(async () => {});

describe('fiat persistence', () => {
  beforeEach(() => jest.resetAllMocks());

  it('writes latest fiat when ECB returns data', async () => {
    mockedAxios.get.mockImplementation((url: any) => {
      if (typeof url === 'string' && url.includes('coins/list')) {
        return Promise.resolve({ data: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }, { id: 'ethereum', symbol: 'eth', name: 'Ethereum' }] });
      }
      if (typeof url === 'string' && url.includes('coingecko')) {
        return Promise.resolve({ data: { bitcoin: { usd: 76038, eur: 64340 }, ethereum: { usd: 2253.76, eur: 1907.03 } } });
      }
      if (typeof url === 'string' && url.includes('eurofxref')) {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">\n  <Cube>\n    <Cube time="2026-02-04">\n      <Cube currency="USD" rate="1.08"/>\n    </Cube>\n  </Cube>\n</gesmes:Envelope>`;
        return Promise.resolve({ data: xml });
      }
      return Promise.reject(new Error('unknown url'));
    });

    const payload = await fetchAndStoreRates();
    // latest fiat should have been written
    expect(firestore.writeLatestFiat).toHaveBeenCalled();
    const fiatArg = (firestore.writeLatestFiat as jest.Mock).mock.calls[0][0];
    expect(fiatArg).toHaveProperty('base', 'EUR');
    expect(fiatArg).toHaveProperty('rates');
    expect(fiatArg.rates).toHaveProperty('USD', 1.08);
  });

  it('writes fiat snapshot when writeSnapshotFiat exists', async () => {
    mockedAxios.get.mockImplementation((url: any) => {
      if (typeof url === 'string' && url.includes('coins/list')) {
        return Promise.resolve({ data: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }] });
      }
      if (typeof url === 'string' && url.includes('coingecko')) {
        return Promise.resolve({ data: { bitcoin: { usd: 76038, eur: 64340 } } });
      }
      if (typeof url === 'string' && url.includes('eurofxref')) {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">\n  <Cube>\n    <Cube time="2026-02-04">\n      <Cube currency="USD" rate="1.08"/>\n    </Cube>\n  </Cube>\n</gesmes:Envelope>`;
        return Promise.resolve({ data: xml });
      }
      return Promise.reject(new Error('unknown url'));
    });

    await fetchAndStoreRates();

    expect(firestore.writeSnapshotFiat).toHaveBeenCalled();
    const snapArg = (firestore.writeSnapshotFiat as jest.Mock).mock.calls[0][0];
    expect(snapArg).toHaveProperty('base', 'EUR');
    expect(snapArg.rates).toHaveProperty('USD', 1.08);
  });
});
