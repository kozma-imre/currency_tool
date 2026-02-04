# Exchange Rates Fetcher — Design & Implementation Plan ✅

> Purpose: A small scheduled service that fetches crypto + fiat exchange rates daily (adjustable), persists them into Firestore, and provides a single canonical source for mobile apps to read. This repo uses GitHub Actions as the scheduler and runner (public repos) and falls back to an alternate provider if the primary fails.

---

## 1) Goals & Requirements 🎯
- Fetch crypto rates (CoinGecko primary, Binance testnet fallback).
- Fetch fiat rates (ECB as primary; exchangerate.host as optional backup).
- Run once every 24 hours by default (cron schedule configurable).
- Store results in Firestore: a `latest` doc and optional daily snapshots.
- Keep provider API keys / credentials private (GitHub Secrets for Actions). No keys in client app.
- Provide a clear README and easy onboarding for new maintainers.
- Prefer minimal infra & low cost.

---

## 2) Provider selection & reasons 🔎
- Crypto (primary): **CoinGecko** — free, bulk `/simple/price`, no API key required for many use cases. Good coverage and reliability.
- Crypto (fallback): **Binance** (testnet/public endpoints) — alternate liquidity source.
- Fiat: **ECB** — authoritative daily EUR reference rates (free). Optionally use **exchangerate.host** for more flexible bulk queries.

Notes: validate provider TOS about caching/redistribution; include attribution if required.

---

## 3) Architecture (high level) 🏗️

1. GitHub Actions workflow scheduled by `on: schedule` or `workflow_dispatch` (for manual runs).
2. Action runs a small script (Node.js / TypeScript recommended) that:
   - calls CoinGecko for requested crypto pairs
   - calls ECB / exchangerate.host for fiat
   - on primary failure, tries fallback (Binance)
   - normalizes data into a canonical shape
   - writes `exchange_rates/latest` doc plus optional daily snapshot `exchange_rates/history/YYYY-MM-DD`
3. Mobile apps read Firestore `exchange_rates/latest` directly or via your API layer.

Pros: simple, secure (keys in GH secrets), cheap / free for modest usage.

---

## 4) Firestore schema (recommended) 📦

Collection: `exchange_rates`
- Doc `latest` (single doc):
```json
{
  "provider": "coingecko",
  "timestamp": <serverTimestamp>,
  "rates": {
    "BTC": { "USD": 56000.0, "EUR": 46800.0 },
    "ETH": { "USD": 1900.0 }
  },
  "meta": { "sourceETag": "...", "fetchedAt": "2026-02-04T02:00:00Z" }
}
```
- Snapshots (optional): `history-YYYY-MM-DD` with same shape for audit/replay.

Security: either public read (easy) or restricted reads (require Firebase token) depending on your use case.

---

## 5) Scheduling & config 🔁
- Default: daily (cron) at a configurable hour (e.g., 02:00 UTC).
- Expose schedule as an environment variable or GitHub secret (e.g., `FETCH_CRON='0 2 * * *'`).
- Support manual trigger via `workflow_dispatch`.

---

## 6) GitHub Actions — example workflow ✍️
Create `.github/workflows/fetch-rates.yml` (example):

```yaml
name: fetch-exchange-rates
on:
  schedule:
    - cron: '0 2 * * *'    # default: daily 02:00 UTC
  workflow_dispatch: {}
jobs:
  fetch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '18'
      - run: npm ci
      - name: Fetch & store rates
        env:
          GOOGLE_SERVICE_ACCOUNT: ${{ secrets.GOOGLE_SERVICE_ACCOUNT }}
          COINGECKO_API_KEY: ${{ secrets.COINGECKO_API_KEY }} # optional
          BINANCE_KEY: ${{ secrets.BINANCE_KEY }}
          BINANCE_SECRET: ${{ secrets.BINANCE_SECRET }}
          ECB_URL: 'https://api.exchangerate.host/latest' # optional
        run: node scripts/fetchRatesToFirestore.js
```

---

## 7) Implementation details (script) 🧩
- Language: **Node.js + TypeScript** recommended (fast dev, `firebase-admin`, small bundle). Python is a fine alternative.
- Steps in script:
  1. Initialize `firebase-admin` from `GOOGLE_SERVICE_ACCOUNT` env JSON.
  2. Try CoinGecko:
     - call `/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd,eur`
     - on success, normalize and write `latest` doc.
  3. On failure of CoinGecko, try Binance public/test endpoints and construct rates.
  4. Fetch fiat rates from ECB or exchangerate.host (or both for cross-check).
  5. Include metadata: provider, raw response, timestamps, any ETag/headers.
  6. On write error, keep last known good data and write `meta` doc recording the error.
- Add retry with exponential backoff and timeouts (10s default). Respect provider rate limits.

---

## 8) Secrets & GitHub repo settings 🔐
Store these as GitHub Secrets (Repository Settings → Secrets):
- `GOOGLE_SERVICE_ACCOUNT` (JSON file contents for Firestore service account)
- `COINGECKO_API_KEY` (only if you use a keyed plan)
- `BINANCE_KEY`, `BINANCE_SECRET` (if using signed endpoints)
- `ECB_URL` or `EXR_HOST_KEY` if needed
- `FETCH_CRON` (optional override)

Never store secrets in code or commit them.

---

## 9) Readme & onboarding (what to include) 📖
Create `README.md` with:
- purpose, quick architecture diagram, and requirements
- steps to configure GH secrets (list names) and Firestore project + service account creation
- how to change the cron schedule and trigger manual runs
- shape of Firestore `exchange_rates/latest` and how to read
- troubleshooting section (how to read Action logs, common failure modes)
- license & attribution notes for providers

Include a `CONTRIBUTING.md` with local testing steps and code style.

---

## 10) Monitoring, Logging & Notifications ⚠️
- Use GitHub Actions logs and failure notifications.
- Structured logging: write structured logs for every run to Firestore `monitoring/logs` (or Cloud Logging). Each log entry should include: `timestamp`, `level` (INFO/WARN/ERROR), `runId`, `provider`, `operation` (fetch/write), `durationMs`, `status`, `error` (message + stack), and optional `rawResponse` (truncated).
- Errors and aggregation: write aggregated error documents to `monitoring/errors` with `firstSeen`, `lastSeen`, `count`, `status` (active/resolved), and `lastRunId`. Use this to avoid alert storms and to present a timeline in the UI.
- Staleness detection: add a scheduled check (Cloud Function or separate cron job) that asserts `exchange_rates/latest.timestamp` is within TTL (configurable). If stale, create an error doc and trigger alerts.

### Telegram alerting (recommended)
- Purpose: deliver immediate, low-friction alerts for failures (fetch failure, write failure, repeated failures, or stale data) and optional daily summary messages.
- Secrets required (add to GitHub Secrets):
  - `TELEGRAM_BOT_TOKEN` — bot token from BotFather
  - `TELEGRAM_CHAT_ID` — chat id for the target chat/group
  - `TELEGRAM_ALERTING_ENABLED` — optional boolean-like flag (true/false)
- Alerting policy (operational):
  - Send a concise alert on the *first* failure (fetch or write). Include provider, short error, and timestamp.
  - If failure persists across `N` runs (configurable, e.g., 2), send an escalation message with aggregated counts and last error details.
  - On recovery, send a short recovery message mentioning duration of outage and last failure count.
  - Send a daily summary message (configurable) optionally that lists success/fail counts and fetch latency percentiles.
  - Debounce: do not send more than one failure alert per 1 hour per provider without manual acknowledgement; store `lastAlertSentAt` in `monitoring/alerts` to implement this.
- Message templates (short & actionable):
  - Failure alert (first failure):
    "[ALERT] Exchange fetch failed — provider: COINGECKO\nError: <short message>\nRun: <GH_RUN_URL or runId>\nLast good: <timestamp>\nAction: Investigate logs: <link>"
  - Escalation after repeated failures:
    "[ESCALATION] Fetch failing for 3 runs — provider: COINGECKO\nFirst seen: <firstSeen>\nLast error: <short message>\nCount: 3\nSuggested: retry or check provider status"
  - Stale data alert:
    "[STALE] Rates stale > TTL — lastUpdated: <timestamp> — consider manual fetch or investigate failures."
  - Recovery notice:
    "[RECOVERY] Fetch succeeded after 2 failures — provider: COINGECKO\nRecovered at: <timestamp>\nDowntime: ~2 runs"
  - Daily summary (optional):
    "[SUMMARY] Daily fetch results — success: 1, failed: 0 — average fetch time: 240ms."
- Implementation details:
  - Use Telegram HTTP API `POST https://api.telegram.org/bot<token>/sendMessage` with JSON body `{ chat_id, text, parse_mode: "HTML", disable_web_page_preview: true }`.
  - Sanitize user-provided strings and escape special characters if using Markdown/HTML parse modes.
  - Implement send retries with exponential backoff and log both successes and failures to `monitoring/notifications`.
  - On send failure, write the failure into `monitoring/notifications` and fall back to an internal monitoring doc — avoid infinite retry loops.
  - Respect Telegram rate limits by limiting alerts per provider (debounce/aggregate) and by using a single chat per project.
- On-call & escalation config (recommendation):
  - Define `ALERT_THRESHOLD_RUNS` (e.g., 2) and `DEBOUNCE_WINDOW_MINUTES` (e.g., 60) as configuration variables (secrets or repo variables). Adjust per team needs.

### Security & operational notes
- Store `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in GitHub Secrets; do not commit them.
- Limit service account Firestore IAM to only required collections: `exchange_rates`, `monitoring/*`.
- Add a short doc `docs/NOTIFICATION_ONBOARDING.md` explaining how to create a bot (`@BotFather`), add it to a group, and obtain `chat_id` (via `getUpdates` or `getChat`).

### Logging & retention
- Retain logs and error docs for at least 30 days (adjustable) for debugging and auditing. Consider downsampling or truncating raw provider responses.

---


---

## 11) Tests & validation ✅
- Unit test script parsing & normalization functions.
- Integration test (dry run) writing to a test Firestore project.
- End-to-end test: GitHub Action `workflow_dispatch` manual run.

---

## 12) Language recommendation & rationale 🛠️
- **Node.js + TypeScript** — recommended:
  - Fast to implement, great NPM ecosystem (axios, firebase-admin), small runtime.
  - Easy to run in GH Actions, low friction for maintainers.
- **Python** — alternative if your team prefers it (firebase-admin for Python exists). Choose what your team knows.

---

## 13) Security & legal checklist ✅
- Confirm provider terms for caching & redistribution.
- Do not expose private keys to mobile clients.
- Use minimal IAM privileges for the service account (Firestore write on specific collection only).

---

## 14) Deliverables & next steps (PR checklist) 🧾
- [x] Add `scripts/fetchRatesToFirestore.js` (or `.ts`) with CoinGecko + Binance + ECB fetch + write logic
- [ ] Add `.github/workflows/fetch-rates.yml` with schedule & secrets references
- [x] Add `docs/EXCHANGE_RATES_FETCH_PLAN.md` (this file)
- [x] Add `README.md` and `CONTRIBUTING.md` with setup instructions
- [x] Add unit tests for normalization/ETags/retry logic
- [x] Add monitoring: `monitoring/errors` + alert policy (basic logs written; alerting not yet implemented)

---

## Appendix: Minimal README snippet to include in repo 🧾
```
# Exchange Rates Fetcher

Purpose: Daily fetcher for crypto & fiat exchange rates. Writes to Firestore `exchange_rates/latest`.

Quick start:
1. Create a Firestore project and service account; add JSON to `GOOGLE_SERVICE_ACCOUNT` secret.
2. Add provider secrets (if used).
3. Configure schedule in `.github/workflows/fetch-rates.yml` or via `FETCH_CRON` secret.
4. Trigger the action manually or wait for the scheduled run.

Firestore doc: `exchange_rates/latest` with fields `provider`, `timestamp`, `rates`.
```

---

If you'd like, I can create the `fetchRatesToFirestore.js` script and GitHub Actions workflow in this repo now (Node.js/TypeScript skeleton + tests + README). Which language would you like me to use for the implementation? 🚀
