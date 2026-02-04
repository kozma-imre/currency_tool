// Use Node fs/os directly at runtime to avoid jest module mock issues
const fs = require('fs');
const os = require('os');
const path = require('path');

const sampleWorkflow = `name: fetch-exchange-rates
on:
  schedule:
    - cron: '0 2 * * *'
  workflow_dispatch:
jobs:`;

describe('set-cron script', () => {
  let tmpDir: string;
  let wfPath: string;
  beforeEach(() => {
    jest.resetAllMocks();
    tmpDir = fs.mkdtempSync(`${os.tmpdir()}/ct-`);
    const wfDir = `${tmpDir}/.github/workflows`;
    fs.mkdirSync(wfDir, { recursive: true });
    wfPath = `${wfDir}/fetch-rates.yml`;
    fs.writeFileSync(wfPath, sampleWorkflow, 'utf8');
    // Sanity check: ensure the file exists and is readable in the test runtime
    const check = fs.readFileSync(wfPath, 'utf8');
    if (check !== sampleWorkflow) throw new Error('sanity-check-failed');
    jest.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      /* ignore */
    }
    jest.restoreAllMocks();
  });

  it('replaces cron line in workflow file', async () => {
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    const { main } = require('../../scripts/set-cron');
    await expect(main(['node', 'script', '0 3 * * *'] as any, wfPath)).resolves.toBeUndefined();

    expect(writeSpy).toHaveBeenCalled();
    const written = (writeSpy.mock.calls[0]![1] as string);
    expect(written).toContain("cron: '0 3 * * *'");

    writeSpy.mockRestore();
  });
});
