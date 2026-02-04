const fs = require('fs');
const os = require('os');
const path = require('path');
const { main: setCronMain } = require('../scripts/set-cron');

describe('sync cron script', () => {
  it('updates cron in the provided workflow file', async () => {
    const tmp = path.join(os.tmpdir(), `ct-${Date.now()}-${Math.floor(Math.random()*10000)}`);
    fs.mkdirSync(tmp, { recursive: true });
    const wfPath = path.join(tmp, 'cleanup-snapshots.yml');
    const sample = fs.readFileSync('.github/workflows/cleanup-snapshots.yml', 'utf8');
    fs.writeFileSync(wfPath, sample, 'utf8');

    const newCron = "0 6 * * 0";
    await setCronMain(['node', 'set-cron', newCron], wfPath);

    const updated = fs.readFileSync(wfPath, 'utf8');
    expect(updated.includes(newCron)).toBe(true);
  });
});