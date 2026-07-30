# Security Policy

## Supported versions

This project is under active development. Security fixes are applied on the default branch.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Email the maintainers privately (via the contact listed on the GitHub repository) with:

- A short description of the issue
- Steps to reproduce
- Impact assessment (data exposure, auth bypass, etc.)

We will acknowledge receipt and work on a fix before any public disclosure.

## Production checklist

Before exposing an instance to the internet:

1. Set a strong unique `SECRET_KEY`.
2. Set `COOKIE_SECURE=true` and serve only over HTTPS.
3. Leave `DEV_BYPASS_EMAILS` empty.
4. Set `SBC_SKIP_SEED=true` (or `ENV=production`).
5. Restrict `CORS_ALLOW_ORIGINS` to your real frontend origin(s).
6. Configure real SMTP credentials; do not log verification codes.
7. Keep dependencies updated and run the test suite before deploy.
