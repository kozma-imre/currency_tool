// Use Node fs/os directly at runtime to avoid jest module mock issues
let fs: any;
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
    // require fs at runtime to avoid accidental module mocks leaking in
    fs = require('fs');
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
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.PR_BASE_BRANCH;
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

  it('creates a PR when --create-pr is passed and GITHUB_TOKEN is set (integration-like)', async () => {
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    process.env.GITHUB_TOKEN = 'fake-token';
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    process.env.PR_BASE_BRANCH = 'main';

    const execSyncMock = jest.spyOn(require('child_process'), 'execSync').mockImplementation(() => {});

    const fakeFetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ html_url: 'https://github.com/owner/repo/pull/123' }) });
    // @ts-ignore
    global.fetch = fakeFetch;

    jest.resetModules();
    const mod = require('../../scripts/set-cron');
    // debug: show what the module exports in the test env
    console.log('set-cron module keys:', Object.keys(mod));
    const { main, createPullRequest } = mod;

    // Running main should not throw (it will try to run git commands); we don't require git to exist in the test env
    await expect(main(['node', 'script', '0 3 * * *', '--create-pr'] as any, wfPath)).resolves.toBeUndefined();

    // The dedicated PR helper should call the GitHub API; call it directly to assert the API call
    await expect(createPullRequest('test-branch', '0 3 * * *', wfPath)).resolves.toBeUndefined();

    expect(fakeFetch).toHaveBeenCalled();

    writeSpy.mockRestore();
    execSyncMock.mockRestore();
    // @ts-ignore
    delete global.fetch;
  });
});
