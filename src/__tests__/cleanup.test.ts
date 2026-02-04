import { cleanupSnapshots } from '../scripts/cleanup-snapshots';

describe('cleanupSnapshots', () => {
  it('deletes docs older than cutoff and ignores non-history docs', async () => {
    const docs = [
      { id: 'history-2025-01-01', deleted: false },
      { id: 'history-2026-01-01', deleted: false },
      { id: 'latest', deleted: false },
    ];

    const mockCol = {
      get: async () => ({ docs: docs.map((d) => ({ id: d.id })) }),
      doc: (id: string) => ({ delete: async () => { const el = docs.find(x => x.id === id); if (el) el.deleted = true; } })
    };

    const mockDb = {
      collection: (_name: string) => mockCol,
    } as any;

    // retentionDays set to 365 to delete 2025-01-01
    const res = await cleanupSnapshots(mockDb, 365, false);
    expect(res.deleted).toBeGreaterThanOrEqual(1);
    // ensure non-history wasn't deleted
    expect(docs.find(d => d.id === 'latest')!.deleted).toBe(false);
  });

  it('in dry-run does not delete', async () => {
    const docs = [
      { id: 'history-2020-01-01', deleted: false }
    ];
    const mockCol = {
      get: async () => ({ docs: docs.map((d) => ({ id: d.id })) }),
      doc: (_id: string) => ({ delete: async () => { throw new Error('should not be called'); } })
    };
    const mockDb = { collection: (_n: string) => mockCol } as any;

    const res = await cleanupSnapshots(mockDb, 365, true);
    expect(res.deleted).toBe(0);
  });
});
