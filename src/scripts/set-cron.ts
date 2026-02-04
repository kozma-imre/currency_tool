const fs = require('fs');
const path = require('path');

function usage() {
  console.log('Usage: ts-node scripts/set-cron.ts "<cron>" [--commit]');
  console.log('Example: ts-node scripts/set-cron.ts "0 3 * * *"');
}

function validateCron(cron: string) {
  // Very basic validation: 5 fields separated by spaces
  return cron.trim().split(/\s+/).length === 5;
}

export async function main(argv?: string[], wfPathArg?: string) {
  const [, , cron, maybeCommit] = argv ?? process.argv;
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
  const newContent = content.replace(/(schedule:\s*\n\s*-\s*cron:\s*')([^']*)(')/m, `$1${cron}$3`);
  if (newContent === content) {
    console.error('Failed to replace cron (pattern not found)');
    throw new Error('pattern-not-found');
  }

  fs.writeFileSync(wfPath, newContent, 'utf8');
  console.log('Updated workflow cron to:', cron);

  if (maybeCommit === '--commit') {
    console.log('Note: --commit requested but this script will not run git commands automatically. Please review and commit the change.')
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(10);
  });
}
