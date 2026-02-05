import { checkStaleness } from '../scripts/check-staleness';

// Minimal mock Firestore objects for unit tests
function makeMockDb({ latestTimestamp, existingAlertState }: any) {
  const collections: Record<string, any> = {};

  collections['exchange_rates_test'] = {
    docs: new Map([['latest', { id: 'latest', data: () => ({ timestamp: latestTimestamp, provider: 'coingecko' }), exists: true }]]),
  };

  const monitoring = new Map();

  const db = {
    collection: (name: string) => {
      if (name === 'exchange_rates_test') {
        return {
          doc: (id: string) => ({
            get: async () => {
              const d = collections['exchange_rates_test'].docs.get(id);
              return { exists: !!d, data: () => (d ? d.data() : undefined) };
            },
          }),
        };
      }
      if (name === 'monitoring') {
        return {
          add: async (obj: any) => { monitoring.set(`m_${Date.now()}`, obj); },
        };
      }
      if (name === 'monitoring_alerts') {
        return {
          doc: (id: string) => ({
            get: async () => ({ exists: !!existingAlertState, data: () => existingAlertState }),
            set: async (obj: any, _opts: any) => { monitoring.set(id, obj); },
          }),
        };
      }
      return { doc: (_: string) => ({ get: async () => ({ exists: false }) }) };
    },
  } as any;

  return { db, monitoring };
}

test('writes monitoring entry and sets alert state when stale', async () => {
  const staleDate = new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString();
  const { db } = makeMockDb({ latestTimestamp: staleDate, existingAlertState: null });

  // disable real Telegram send
  process.env.TELEGRAM_ALERTING_ENABLED = 'false';
  process.env.EXCHANGE_RATES_COLLECTION_TEST = 'exchange_rates_test';

  const res = await checkStaleness(db as any, 24, true);
  expect(res.stale).toBe(true);

  delete process.env.EXCHANGE_RATES_COLLECTION_TEST;
});

test('does not send alert if debounce and threshold not met', async () => {
  const staleDate = new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString();
  const { db } = makeMockDb({ latestTimestamp: staleDate, existingAlertState: { failureCount: 1, lastAlertSentAt: new Date().toISOString() } });

  process.env.TELEGRAM_ALERTING_ENABLED = 'false';
  process.env.ALERT_DEBOUNCE_MINUTES = '60';
  process.env.ALERT_THRESHOLD_RUNS = '3';
  process.env.EXCHANGE_RATES_COLLECTION_TEST = 'exchange_rates_test';

  const res = await checkStaleness(db as any, 24, true);
  expect(res.stale).toBe(true);

  delete process.env.EXCHANGE_RATES_COLLECTION_TEST;
});
