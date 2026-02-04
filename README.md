# Exchange Rates Fetcher

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)

Daily fetcher for crypto & fiat exchange rates. Writes to Firestore `exchange_rates/latest`.

Quick start:

1. Add `GOOGLE_SERVICE_ACCOUNT` JSON (service account credentials) to GitHub Secrets.
2. Locally for testing, create a `.env` with `GOOGLE_SERVICE_ACCOUNT` set to the JSON string.
3. Install deps: `npm ci` and run `npm run fetch` to do a one-off fetch (dry-run if no service account).

Configurable schedule
---------------------

- Default schedule: `0 2 * * *` UTC (see `.github/workflows/fetch-rates.yml`).
- To change the cron schedule locally, run:

  ```bash
  npm run set-cron -- "0 3 * * *"
  ```

  That will update `.github/workflows/fetch-rates.yml` replacing the schedule's cron line. Review and commit the updated file to apply the new schedule on GitHub. Note: GitHub Actions' `schedule` field cannot read values from secrets or environment variables, so change requires updating the workflow file.

- Alternatively, you can trigger runs manually from the Actions UI using the workflow's **Run workflow** button (workflow_dispatch).

CI / Tests
---------

- A GitHub Actions workflow `ci.yml` runs `npm ci` and `npm test` for `push` and `pull_request` on `main` (see `.github/workflows/ci.yml`).

Running locally
---------------

- Install dependencies: `npm ci`
- Run tests: `npm test`
- One-off fetch (dry-run if no service account): `npm run fetch`

Security & publishing
---------------------

- This repository is licensed under the **Apache License 2.0** (see `LICENSE`) and is free to use under that license.
- **Do not commit secrets or private keys.** Store service account credentials (the `GOOGLE_SERVICE_ACCOUNT` JSON) in GitHub Secrets and do not commit them to the repository.
- The repository currently ignores the following (listed in `.gitignore`):
  - `node_modules`, `dist`, `coverage`
  - `.env`, `.env.*`
  - editor files: `.vscode`, `.idea`
  - OS files: `.DS_Store`
  - logs: `npm-debug.log`, `yarn-error.log`, `firebase-debug.log`
  - sensitive artifacts: `service-account*.json`, `*.key`, `*.pem`

Before publishing, double-check `git status` for any local files with secrets (for example service account JSONs) and confirm they are not staged.

Contributing & security
-----------------------

- Please read `CONTRIBUTING.md` for guidance on issues, PRs, and running tests locally.
- See `SECURITY.md` for our security reporting policy and responsible disclosure instructions.


