import admin = require('firebase-admin');
import { initFirestore } from '../firestore';
import { sendTelegramAlert } from '../notify/telegram';

export async function checkStaleness(db?: FirebaseFirestore.Firestore, staleAfterHours = 48, writeMonitoring = true) {
  if (!db) {
    await initFirestore();
    if (!admin.apps.length) {
      console.log('GOOGLE_SERVICE_ACCOUNT env not set; skipping staleness check (dry-run)');
      return { ok: true, stale: false };
    }
    db = admin.firestore();
  }

  const collectionName = process.env.EXCHANGE_RATES_COLLECTION_TEST ?? process.env.EXCHANGE_RATES_COLLECTION ?? 'exchange_rates';
  const latestRef = db!.collection(collectionName).doc('latest');
  const snap = await latestRef.get();
  if (!snap.exists) {
    return { ok: true, stale: false, reason: 'no-latest' };
  }
  const data = snap.data() as any;
  const ts = data?.timestamp;
  if (!ts) return { ok: true, stale: false, reason: 'no-timestamp' };

  const last = new Date(ts);
  const cutoff = new Date(Date.now() - staleAfterHours * 3600 * 1000);
  const isStale = last < cutoff;

  if (isStale && writeMonitoring) {
    const mcol = process.env.MONITORING_COLLECTION ?? 'monitoring';

    // Write an event for aggregation
    await db!.collection(mcol).add({
      type: 'staleness',
      provider: data.provider,
      lastUpdated: ts,
      staleAfterHours,
      detectedAt: new Date().toISOString(),
    });
    console.log('Stale detected; wrote monitoring entry');

    // Alert aggregation & debouncing
    const alertsCol = process.env.MONITORING_ALERTS_COLLECTION ?? `${mcol}_alerts`;
    const alertId = `staleness-${data.provider ?? 'unknown'}`;
    const alertRef = db!.collection(alertsCol).doc(alertId);

    const alertDoc = await alertRef.get();
    const now = new Date();
    const debounceMins = Number(process.env.ALERT_DEBOUNCE_MINUTES ?? '60');
    const thresholdRuns = Number(process.env.ALERT_THRESHOLD_RUNS ?? '1');

    let state: any = alertDoc.exists ? alertDoc.data() : { failureCount: 0 };
    state.failureCount = (state.failureCount || 0) + 1;
    state.lastCheckedAt = now.toISOString();
    state.firstSeen = state.firstSeen ?? now.toISOString();

    // Decide whether to send an alert
    const lastAlertSentAt = state.lastAlertSentAt ? new Date(state.lastAlertSentAt) : null;
    const enoughFailures = state.failureCount >= thresholdRuns;
    const debounceExpired = !lastAlertSentAt || (now.getTime() - lastAlertSentAt.getTime()) > debounceMins * 60 * 1000;

    let sent = false;
    if (enoughFailures && debounceExpired) {
      const alertText = `[ALERT] Exchange rates stale — provider: ${data.provider || 'unknown'}\nLast updated: ${ts}\nFirst seen: ${state.firstSeen}\nFailures: ${state.failureCount}`;
      const alertRes = await sendTelegramAlert(alertText);
      state.lastAlertSentAt = new Date().toISOString();
      state.lastAlertResult = alertRes;
      sent = true;
      console.log('Staleness alert sent:', alertRes);
    } else {
      console.log('Staleness alert not sent (debounce/threshold):', { enoughFailures, debounceExpired });
    }

    // Attempt remediation (optional)
    const remediationEnabled = String(process.env.REMEDIATION_ENABLED ?? 'false').toLowerCase() === 'true';
    if (remediationEnabled) {
      try {
        console.log('Attempting remediation: triggering fetchAndStoreRates()');
        const { fetchAndStoreRates } = require('../fetcher');
        const remRes = await fetchAndStoreRates();
        state.lastRemediationAt = new Date().toISOString();
        state.lastRemediationResult = { ok: true, provider: remRes.provider, timestamp: remRes.timestamp };
        console.log('Remediation succeeded:', state.lastRemediationResult);
      } catch (e) {
        state.lastRemediationAt = new Date().toISOString();
        state.lastRemediationResult = { ok: false, error: String(e) };
        console.error('Remediation failed:', e);
      }
    }

    await alertRef.set(state, { merge: true });
    if (sent) {
      // also write a monitoring log for alert send if desired
      await db!.collection(mcol).add({ type: 'alert_sent', alertId, provider: data.provider, sentAt: new Date().toISOString(), via: 'telegram' });
    }
  }

  return { ok: true, stale: isStale, lastUpdated: ts };
}

if (require.main === module) {
  const hoursEnv = process.env.STALE_AFTER_HOURS;
  const hours = hoursEnv ? Number(hoursEnv) : 48;
  checkStaleness(undefined, hours, true).catch((err) => {
    console.error('checkStaleness failed', err);
    process.exit(2);
  });
}
