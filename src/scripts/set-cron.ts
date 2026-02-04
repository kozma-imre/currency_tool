const fs = require('fs');
const path = require('path');

function usage() {
  console.log('Usage: ts-node scripts/set-cron.ts "<cron>" [--commit] [--create-pr]');
  console.log('Example: ts-node scripts/set-cron.ts "0 3 * * *" --create-pr');
}

function validateCron(cron: string) {
  // Very basic validation: 5 fields separated by spaces
  return cron.trim().split(/\s+/).length === 5;
}

export async function createPullRequest(branch: string, cron: string, wfPath: string) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const base = process.env.PR_BASE_BRANCH || 'main';

  if (!repo || !token) {
    console.log('GITHUB_REPOSITORY or GITHUB_TOKEN not set; cannot create PR. Please create one manually.');
    return;
  }

  const url = `https://api.github.com/repos/${repo}/pulls`;
  const title = `chore: update cron schedule to ${cron}`;
  const body = `Automated change to update workflow cron for ${wfPath} to\n\n${cron}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ title, head: branch, base, body })
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error('Failed to create PR:', res.status, txt);
      return;
    }
    const json: any = await res.json();
    const htmlUrl = json && typeof json === 'object' ? (json as any).html_url : undefined;
    console.log('Created PR:', htmlUrl ?? JSON.stringify(json));
  } catch (err) {
    console.error('Error creating PR:', err);
  }
}

export async function main(argv?: string[], wfPathArg?: string) {
  const args = argv ?? process.argv;
  const [, , cron, ...flags] = args;
  if (!cron) {
    usage();
    throw new Error('missing-cron');
  }
  if (!validateCron(cron)) {
    console.error('Invalid cron expression (basic check failed)');
    throw new Error('invalid-cron');
  }

  const wfPath = wfPathArg ?? `${process.cwd()}/.github/workflows/fetch-rates.yml`;
  let content: string;
  try {
    content = fs.readFileSync(wfPath, 'utf8');
  } catch (err) {
    console.error('Workflow file not found at', wfPath);
    throw new Error('missing-workflow');
  }
  // Replace the cron under the schedule: block; be tolerant of comments/blank lines
  const schedIdx = content.indexOf('schedule:');
  if (schedIdx === -1) {
    console.error('Workflow file does not contain a schedule: block');
    throw new Error('missing-schedule');
  }
  const before = content.slice(0, schedIdx);
  const after = content.slice(schedIdx);
  const replaced = after.replace(/(-\s*cron:\s*')([^']*)(')/m, `$1${cron}$3`);
  if (replaced === after) {
    console.error('Failed to replace cron (pattern not found in schedule block)');
    throw new Error('pattern-not-found');
  }
  const newContent = before + replaced;

  fs.writeFileSync(wfPath, newContent, 'utf8');
  console.log('Updated workflow cron to:', cron);

  const commit = flags.includes('--commit');
  const createPr = flags.includes('--create-pr');

  const { execSync } = require('child_process');

  if (createPr) {
    // Create a branch, commit, push, and open a PR
    const branch = `chore/update-cron-${Date.now()}`;
    try {
      execSync(`git checkout -b ${branch}`, { stdio: 'inherit' });
      execSync(`git add ${wfPath}`, { stdio: 'inherit' });
      execSync(`git commit -m "chore: update cron schedule to ${cron} (automated)" ${wfPath}`, { stdio: 'inherit' });
      execSync(`git push --set-upstream origin ${branch}`, { stdio: 'inherit' });
      console.log('Pushed branch for PR:', branch);
      await createPullRequest(branch, cron, wfPath);
    } catch (e) {
      console.error('Failed to create PR automatically:', e);
      console.log('Note: --create-pr requested but PR creation failed. Please review and create a PR manually.');
    }
    return;
  }

  if (commit) {
    try {
      execSync(`git add ${wfPath}`, { stdio: 'inherit' });
      execSync(`git commit -m "chore: update cron schedule to ${cron} (automated)" ${wfPath}`, { stdio: 'inherit' });
      execSync('git push', { stdio: 'inherit' });
      console.log('Committed and pushed workflow change.');
    } catch (e) {
      console.error('Failed to commit workflow change automatically:', e);
      console.log('Note: --commit requested but auto-commit failed. Please review and commit the change manually.');
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  // Ensure CommonJS consumers can access the helpers
  module.exports = { main, createPullRequest };
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(10);
  });
}
