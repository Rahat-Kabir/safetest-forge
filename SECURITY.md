# Security Policy

## Supported Scope

This project is intended for local use against repositories on the user's machine. The v1 backend binds to `127.0.0.1` only.

## Reporting

Please do not open public issues for security-sensitive reports.

Send a private report with:

- a short description of the issue
- impact and exploitation conditions
- reproduction steps
- affected version or commit if known

Until a dedicated security contact is set up, coordinate directly with the maintainer through a private channel before public disclosure.

## Secrets

- Do not commit `.env`.
- Use `.env.example` as the template for local setup.
- Anthropic API keys are user-provided and are required only for live `claude` runs.
