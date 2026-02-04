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

export async function writeLatest(payload: any) {
  if (!admin.apps.length) {
    console.log('Dry-run write:', JSON.stringify(payload, null, 2));
    return;
  }
  const db = admin.firestore();
  const ref = db.collection('exchange_rates').doc('latest');
  await ref.set(payload, { merge: true });
  console.log('Wrote latest to Firestore');
}
