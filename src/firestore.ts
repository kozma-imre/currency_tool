import admin from 'firebase-admin';

export async function initFirestore() {
  if (admin.apps.length > 0) return;
  const key = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!key) {
    console.warn('GOOGLE_SERVICE_ACCOUNT env not set; skipping Firestore init (dry-run)');
    return;
  }
  let serviceAccount: any;
  try {
    serviceAccount = JSON.parse(key);
  } catch (err) {
    console.error('Failed to parse GOOGLE_SERVICE_ACCOUNT JSON:', err);
    throw err;
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount as admin.ServiceAccount) });
}

const COLLECTION_NAME = process.env.EXCHANGE_RATES_COLLECTION ?? 'exchange_rates';
const MONITORING_COLLECTION = process.env.MONITORING_COLLECTION ?? 'monitoring';

export async function writeLatest(payload: any) {
  if (!admin.apps.length) {
    console.log('Dry-run write latest:', JSON.stringify(payload, null, 2));
    return;
  }
  const db = admin.firestore();
  const ref = db.collection(COLLECTION_NAME).doc('latest');
  await ref.set(payload, { merge: true });
  console.log('Wrote latest to Firestore', COLLECTION_NAME);
}

export async function writeSnapshot(payload: any, date = new Date()) {
  const docId = `history-${date.toISOString().slice(0, 10)}`;
  if (!admin.apps.length) {
    console.log('Dry-run write snapshot:', docId, JSON.stringify(payload, null, 2));
    return;
  }
  const db = admin.firestore();
  const ref = db.collection(COLLECTION_NAME).doc(docId);
  await ref.set(payload);
  console.log('Wrote snapshot to Firestore:', COLLECTION_NAME, docId);
}

export async function writeMonitoringLog(entry: any) {
  if (!admin.apps.length) {
    console.log('Dry-run monitoring log:', JSON.stringify(entry, null, 2));
    return;
  }
  const db = admin.firestore();
  await db.collection(MONITORING_COLLECTION).doc().set(entry);
  console.log('Wrote monitoring log to', MONITORING_COLLECTION);
}
