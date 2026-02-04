import admin from 'firebase-admin';
import { initFirestore } from '../firestore';
import { cleanupSnapshots } from '../scripts/cleanup-snapshots';

const RUN_INTEGRATION = !!process.env.GOOGLE_SERVICE_ACCOUNT && process.env.RUN_INTEGRATION_TESTS === 'true';

describe('integration: cleanup snapshots', () => {
  if (!RUN_INTEGRATION) {
    test('skipping integration cleanup tests (set GOOGLE_SERVICE_ACCOUNT and RUN_INTEGRATION_TESTS=true)', () => {});
    return;
  }

  beforeAll(async () => {
    await initFirestore();
  });

  it('creates old and new snapshots and deletes old ones', async () => {
    const collection = process.env.EXCHANGE_RATES_COLLECTION ?? 'exchange_rates_integration_test_cleanup';
    const db = admin.firestore();

    // create an old snapshot (2 days ago)
    const oldDate = new Date();
    oldDate.setUTCDate(oldDate.getUTCDate() - 2);
    const oldId = `history-${oldDate.toISOString().slice(0, 10)}`;
    await db.collection(collection).doc(oldId).set({ test: true });

    // create a recent snapshot (today)
    const newId = `history-${new Date().toISOString().slice(0, 10)}`;
    await db.collection(collection).doc(newId).set({ test: true });

    // run cleanup with retentionDays=1 (should delete oldId)
    const res = await cleanupSnapshots(undefined, 1, false);
    expect(res.deleted).toBeGreaterThanOrEqual(1);

    const oldDoc = await db.collection(collection).doc(oldId).get();
    expect(oldDoc.exists).toBe(false);
    const newDoc = await db.collection(collection).doc(newId).get();
    expect(newDoc.exists).toBe(true);

    // cleanup: delete the remaining test docs
    await db.collection(collection).doc(newId).delete();
  }, 30000);
});
