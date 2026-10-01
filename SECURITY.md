# Security Policy

Wire Team Bot is a proof of concept maintained by a single developer. Security reports are
welcome and taken seriously, but there is no bug bounty programme and no dedicated security
team behind this repository.

## Scope

This policy covers the code in this repository: the bot application, its prompts, storage and
workflow logic, the Compose files and the published container image.

It does **not** cover the Wire platform. Vulnerabilities in Wire clients, the Wire backend or
`@wireapp/wire-apps-js-sdk` belong to Wire's own process. Please follow
[Wire's global security policy](https://github.com/wireapp/wire/blob/master/SECURITY.md) for those.

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x (latest release) | Yes |
| Earlier pre-release builds | No |

Only the latest tagged release and the `main` branch receive security fixes.

## Reporting a vulnerability

Do not open a public GitHub issue for a security problem.

Use GitHub's private vulnerability reporting instead: open the repository's
[Security tab](https://github.com/adamlow-wire/wire-team-bot/security) and choose
**Report a vulnerability**. Reports go to the maintainer only and stay private until a fix is
released.

Please include:

- A description of the issue and its impact.
- Steps to reproduce, or a proof of concept.
- The affected version, commit or container image tag.
- Any suggested mitigation, if you have one.

You should receive an acknowledgement within five working days. Fixes are made on a best-effort
basis and released as a new tagged version and container image. Credit is given in the release
notes unless you prefer otherwise.

## Deployment guidance

The bot handles the content of Wire conversations and stores derived records in Postgres. If you
run it, keep these points in mind:

- **Secrets stay in the environment.** `.env` files, the Wire app token and model API keys are
  excluded from git and from the container build context. Never commit them.
- **Model endpoints see message content.** Every chat or embedding request sends conversation
  text to the configured model service. Only point the bot at endpoints you trust with that data.
  The design goal is local or air-gapped inference.
- **Stored records can be sensitive.** Decisions, actions and summaries extracted from a channel
  are kept in the database. Protect the database as you would the conversation itself, and use
  the PAUSED and SECURE controls described in the README when a channel discusses something that
  must not be captured.
- **Message content and user identifiers are never logged.** Please report any log line that
  breaks this rule as a security issue.
