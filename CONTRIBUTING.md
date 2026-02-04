# Contributing

Thank you for considering contributing to this project — contributions are welcome. This document explains the general process for reporting issues, proposing changes, and submitting code.

## How to contribute

- Open an issue first to discuss larger changes or features. Small bug fixes can be sent directly as PRs.
- Fork the repository and create a feature branch from `main` (e.g. `fix/short-description`, `feat/cron-config`).
- Keep changes small and focused. One feature or fix per PR.
- Use Conventional Commits in your commit messages (e.g. `feat: add ECB fiat fetch`, `fix: handle missing rates`).
- Note: Triage and review are performed on a best-effort basis — we will review issues and PRs when time permits. Please be patient; contributions are appreciated.

## Development & tests

- Install: `npm ci`
- Run tests: `npm test` (unit tests should pass)
- Run a one-off fetch (dry-run if no service account): `npm run fetch`
- Lint: `npm run lint` (add/fix rules as necessary)
- Update or add unit tests for any logic you change.

## Pull requests

- Target branch: `main`.
- Ensure all tests pass and linting is clean before opening a PR.
- Provide a short description of the change, rationale, and any migration steps.
- A maintainer will review and request changes or approve.

## Code style

- TypeScript is used for source files. Keep types strict and add `import type` for type-only imports where appropriate.
- Prefer small, well-tested functions over large monoliths.

## Security-sensitive changes

If your PR touches authentication, secrets handling, or any security-sensitive code, mention it explicitly in the PR description and link to `SECURITY.md`.

## Secrets and credentials

- **Do not commit secrets.** Never add service account JSON, private keys, or tokens to the repository.
- For local development, use `.env` (see `.env.example`) and ensure `.env` is in `.gitignore` (it is).
- For GitHub Actions, store secrets in **GitHub Secrets** rather than in the repo.

## Other ways to help

- Improve documentation (README, docs folder) and onboarding notes.
- Add integration tests or CI enhancements.
- Report issues with steps to reproduce and expected behavior.

Thanks — your patches and feedback make this project better! 🙏
