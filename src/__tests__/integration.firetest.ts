import admin = require('firebase-admin');
import { initFirestore } from '../firestore';
import { fetchAndStoreRates } from '../fetcher';

const RUN_INTEGRATION = !!process.env.GOOGLE_SERVICE_ACCOUNT && process.env.RUN_INTEGRATION_TESTS === 'true';

describe('integration: Firestore write', () => {
  if (!RUN_INTEGRATION) {
    test('skipping integration tests (set GOOGLE_SERVICE_ACCOUNT and RUN_INTEGRATION_TESTS=true)', () => {
      // noop
    });
    return;
  }

  beforeAll(async () => {
    // explicitly configure test collection first to avoid accidental production writes
    const testCol = process.env.EXCHANGE_RATES_COLLECTION_TEST ?? 'exchange_rates_test';
    const monCol = process.env.MONITORING_COLLECTION ?? 'monitoring';
    const { configureFirestore } = require('../firestore');
    configureFirestore({ exchangeRatesCollection: testCol, monitoringCollection: monCol });

    // init from env
    await initFirestore();
  });

  it('writes latest and snapshot to Firestore', async () => {
    // Use a test collection name to avoid interfering with production data
    // Prefer an explicit test collection to avoid touching production data
    process.env.EXCHANGE_RATES_COLLECTION = process.env.EXCHANGE_RATES_COLLECTION_TEST ?? process.env.EXCHANGE_RATES_COLLECTION ?? 'exchange_rates_integration_test';

    const payload = await fetchAndStoreRates();
    expect(payload).toHaveProperty('provider');

    // read back latest doc
    const db = admin.firestore();
    const latestRef = db.collection(process.env.EXCHANGE_RATES_COLLECTION!).doc('latest');
    const snap = await latestRef.get();
    expect(snap.exists).toBe(true);
    const data = snap.data();
    expect(data).toBeDefined();
    expect(data).toHaveProperty('provider');

    // read snapshot doc
    const docId = `history-${new Date().toISOString().slice(0, 10)}`;
    const histRef = db.collection(process.env.EXCHANGE_RATES_COLLECTION!).doc(docId);
    const hsnap = await histRef.get();
    expect(hsnap.exists).toBe(true);
  }, 30000);
});
