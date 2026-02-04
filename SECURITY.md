# Security policy

Thank you for helping keep this project secure. If you discover a vulnerability, please follow the guidance below for responsible disclosure.

## Reporting a vulnerability

Preferred channels:

1. Use GitHub's **Security Advisories** (recommended) to privately report a vulnerability.

Do not open a public issue for a security problem — use a private channel so we can triage and patch before public disclosure.

## What we will do

- We will acknowledge receipt within 72 hours and provide a timeline for remediation.
- We will coordinate with you on validation and disclose publicly after a fix is released (or per mutual agreement).

## If your report contains secrets

- Rotate credentials immediately if any private keys or tokens have been exposed.
- Avoid sending private keys or passwords in plain text over email; provide minimal reproduction steps and coordinate via a secure channel.

## Public vulnerability disclosures

If a vulnerability is fixed, we will publish a public advisory with affected versions, mitigation steps, and credit (if requested).

## Security best practices for contributors

- Do not commit secrets — always use `.env` for local dev and `GitHub Secrets` for Actions.
- Keep dependencies updated and enable Dependabot (or similar) for automated alerts.
- Limit service account permissions to the minimum required scope.

If you'd like to contribute a security improvement (e.g., hardened IAM policy or secret scanning), open an issue and reference this document.
