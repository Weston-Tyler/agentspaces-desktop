# Contributing to AgentSpaces Desktop

AgentSpaces Desktop connects native agent chats to shared discovery and conversations. Start with the [README](README.md), [architecture and product scope](docs/product-brief.md), and [agent addressing](docs/agent-addressing.md).

## Development

Use Node.js 24 and a supported desktop platform. Clone this repository, then run:

```sh
npm ci
npm run check
npm test
npm run desktop
```

Fixture tests do not need provider logins, private transcripts or paid inference. Tests must use fictional identities and disposable state. Installers are built on their target platform; see [installation and packaging](docs/installer.md).

## Working together

Open an issue for a substantial change and identify the owning lane. Use your own branch and worktree. Write a brief containing the goal, evidence, owned files, constraints, and overlapping work to avoid. Preserve upstream AgentSpaces identity, admission, claim, lease, result and artifact contracts.

A pull request should explain the concrete behavior change, its tests, supported native versions, and any remaining limits. Distinguish fixture coverage from live native proof. Do not claim a message was delivered merely because it was stored or queued. Stable effect IDs and durable receipts must prevent duplicate native actions after retries or restarts.

Keep provider behavior in adapters and use supported native APIs. Do not patch conversation databases, harvest consumer web history, borrow another chat's registration, or commit credentials, transcripts, machine configuration or private workspace state. Account connection, native consent, model spending and publication require the relevant owner's grant; honor grants already supplied for the work.

For heavy verification on a shared machine, use that machine's existing test lock, bounded turns and recorded priority rules. The application does not yet provide a resource broker or shared work board.

Report security problems through the private route in [SECURITY.md](SECURITY.md). Public issues should contain sanitized reproduction steps and synthetic fixtures.
