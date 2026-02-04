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
- Run unit tests: `npm test`
- Run integration tests (writes to Firestore): create a `.env` with `GOOGLE_SERVICE_ACCOUNT` set to the service account JSON string and set `RUN_INTEGRATION_TESTS=true` then run:

```bash
# example (.env)
# GOOGLE_SERVICE_ACCOUNT='{"type":"service_account", ... }'
# RUN_INTEGRATION_TESTS=true

npm run test:integration
```

Data shape & snapshot retention
-------------------------------

- `latest` (lightweight, read by clients):

```json
{
  "provider": "coingecko",
  "timestamp": "2026-02-04T09:50:15.263Z",
  "rates": { "BTC": { "usd": 76038, "eur": 64340 }, "ETH": { "usd": 2253.76 } },
  "meta": {
    "fetchedAt": "2026-02-04T09:50:15.263Z",
    "fiatBase": "EUR",
    "headers": { "etag": "W/\"e77f...\"", "cache-control": "max-age=30" }
  }
}
```

- `snapshot` (daily history, full debug info): stored as `history-YYYY-MM-DD` and contains the full `rawResponse` and complete headers for auditing and troubleshooting.
- Default retention: **30 days**. Configure with `SNAPSHOT_RETENTION_DAYS` (env) or change in the scheduled cleanup workflow.
- To clean up snapshots manually (safe dry-run first):

```bash
# dry-run
npm run cleanup-snapshots -- --dry-run

# delete older-than default (30 days)
npm run cleanup-snapshots

# override retention
SNAPSHOT_RETENTION_DAYS=7 npm run cleanup-snapshots
```

Optional provider keys (local / CI)
- You can set provider keys in `.env` or as GitHub Secrets:
  - `COINGECKO_API_KEY` — optional CoinGecko Pro key. If set, requests will include the `X-CG-PRO-API-KEY` header.
  - `BINANCE_KEY` — optional Binance API key. When present it's sent in the `X-MBX-APIKEY` header (used for authenticated requests).
  - `BINANCE_SECRET` — optional Binance secret (for future signed calls; not required for public price endpoints).
- Configure which cryptos/fiats to fetch (env / GitHub Secrets):
  - `CRYPTO_IDS` — comma-separated CoinGecko ids (default: `bitcoin,ethereum`).
  - `CRYPTO_SYMBOLS` — optional comma-separated symbols for Binance (default derived from `CRYPTO_IDS`).
  - `FIAT_CURRENCIES` — comma-separated fiat codes (default: `usd,eur`).
- For alerting later, you may set `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` (optional).

Notes:
- Integration tests will write to the Firestore collection specified by `EXCHANGE_RATES_COLLECTION_TEST` (if set) or `EXCHANGE_RATES_COLLECTION` (default: `exchange_rates_integration_test` when running tests). To avoid touching production data, set `EXCHANGE_RATES_COLLECTION_TEST=exchange_rates_test` in your `.env`, and use a dedicated test Firestore project and service account.
- For CI: add `GOOGLE_SERVICE_ACCOUNT` (JSON file content) as a GitHub repository secret and run the `Integration Tests` workflow from the Actions tab (manual `workflow_dispatch`).

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


