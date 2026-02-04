import admin from 'firebase-admin';
import { initFirestore } from '../firestore';

export async function cleanupSnapshots(db?: FirebaseFirestore.Firestore, retentionDays = 30, dryRun = false) {
  if (!db) {
    await initFirestore();
    if (!admin.apps.length) {
      console.log('GOOGLE_SERVICE_ACCOUNT env not set; skipping Firestore cleanup (dry-run)');
      return { deleted: 0 };
    }
    db = admin.firestore();
  }

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);

  const collectionName = process.env.EXCHANGE_RATES_COLLECTION ?? 'exchange_rates';
  const col = db.collection(collectionName);
  const snap = await col.get();

  let deleted = 0;

  for (const doc of snap.docs) {
    const id = doc.id;
    if (!id.startsWith('history-')) continue;
    const dateStr = id.slice('history-'.length);
    const docDate = new Date(dateStr);
    if (isNaN(docDate.getTime())) continue;
    if (docDate < cutoff) {
      if (dryRun) {
        console.log('[dry-run] would delete', id);
      } else {
        await col.doc(id).delete();
        console.log('deleted', id);
        deleted++;
      }
    }
  }

  console.log(`cleanupSnapshots: deleted=${deleted} older-than=${retentionDays}d in ${collectionName}`);
  return { deleted };
}

if (require.main === module) {
  const daysEnv = process.env.SNAPSHOT_RETENTION_DAYS;
  const retentionDays = daysEnv ? Number(daysEnv) : 30;
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  cleanupSnapshots(undefined, retentionDays, dryRun).catch((err) => {
    console.error('cleanupSnapshots failed', err);
    process.exit(1);
  });
}
