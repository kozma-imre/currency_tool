import admin = require('firebase-admin');

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

let configuredExchangeRatesCollection: string | undefined;
let configuredMonitoringCollection: string | undefined;

export function configureFirestore(opts: { exchangeRatesCollection?: string; monitoringCollection?: string } = {}) {
  if (opts.exchangeRatesCollection) configuredExchangeRatesCollection = opts.exchangeRatesCollection;
  if (opts.monitoringCollection) configuredMonitoringCollection = opts.monitoringCollection;
}

export function getCollectionName() {
  if (configuredExchangeRatesCollection) return configuredExchangeRatesCollection;
  // Only use test env var when integration tests are explicitly enabled
  if (process.env.RUN_INTEGRATION_TESTS === 'true' && process.env.EXCHANGE_RATES_COLLECTION_TEST) return process.env.EXCHANGE_RATES_COLLECTION_TEST;
  return process.env.EXCHANGE_RATES_COLLECTION ?? 'exchange_rates';
}
export function getMonitoringCollection() {
  return configuredMonitoringCollection ?? process.env.MONITORING_COLLECTION ?? 'monitoring';
}

export async function writeLatest(payload: any) {
  if (!admin.apps.length) {
    console.log('Dry-run write latest:', JSON.stringify(payload, null, 2));
    return;
  }
  const db = admin.firestore();
  const collectionName = getCollectionName();
  const ref = db.collection(collectionName).doc('latest');
  await ref.set(payload, { merge: true });
  console.log('Wrote latest to Firestore', collectionName);
}

export async function writeSnapshot(payload: any, date = new Date()) {
  const docId = `history-${date.toISOString().slice(0, 10)}`;
  if (!admin.apps.length) {
    console.log('Dry-run write snapshot:', docId, JSON.stringify(payload, null, 2));
    return;
  }
  const db = admin.firestore();
  const collectionName = getCollectionName();
  const ref = db.collection(collectionName).doc(docId);
  await ref.set(payload);
  console.log('Wrote snapshot to Firestore:', collectionName, docId);
}

export async function writeMonitoringLog(entry: any) {
  if (!admin.apps.length) {
    console.log('Dry-run monitoring log:', JSON.stringify(entry, null, 2));
    return;
  }
  const db = admin.firestore();
  const monitoringCollection = getMonitoringCollection();
  await db.collection(monitoringCollection).doc().set(entry);
  console.log('Wrote monitoring log to', monitoringCollection);
}
