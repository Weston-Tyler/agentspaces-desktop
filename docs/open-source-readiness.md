# Open-source readiness

The owner approved public distribution of AgentSpaces Desktop under [Apache 2.0](../LICENSE). The application is an open-source alpha with unsigned Windows/Linux packages. Actual publication, package contents and installation acceptance must still be verified against the release revision; a documentation edit is not evidence that those steps completed. Third-party components retain their own licenses and notices.

The desktop companion builds on [AgentSpaces](https://www.badmonkey.ai/agentspaces/) by [BadMonkey](https://www.badmonkey.ai/). Upstream framework/binding ownership and this standalone repository's role are documented in [brand and attribution](brand-and-attribution.md) and [NOTICE](../NOTICE).

## Showcase material

The [README](../README.md) and [walkthrough](walkthrough.md) use sanitized demonstration images:

- [Ask](images/ask.png): fictional question, sources and synthetic answer.
- [Group chat](images/group-chat.png): fictional thread agents and synthetic replies.
- [Connected work](images/connected-work.png): fictional projects, paths and relationships.

These are presentation examples, not live native execution proof. Generate them in an isolated demo runtime. Check every exported image for private titles, usernames, machine addresses, local paths, repository names, credentials and hidden metadata before release. Screenshot generation must make no native model calls. Acceptance evidence belongs in revision-bound test and runtime records.

## Current boundaries

| Area | Evidence boundary |
| --- | --- |
| Desktop | Windows source application observed; Windows installer construction implemented; signed distribution and release acceptance remain separate |
| Linux | Remote terminal/adapter target exercised; archive and per-user menu installer implemented; desktop/provider parity unqualified |
| macOS | Packaging, native login and acceptance run unqualified |
| Ask | Automatic permitted context; native inference requires supported authentication and request limits |
| Claude groups | Native channel and transport fixtures; live preview consent and model reply need their own evidence |
| Codex groups | Scoped headless conversation implementation and fixtures; no new arbitrary-thread live qualification |
| Addressing | Source-bound one-peer/multiple-recipient messaging, room `@all`, topic/date selectors and durable recipient snapshots; native wake still depends on connected adapter eligibility |
| Persistence | Connected metadata/discussions/effect receipts and expiring local Ask history implemented; full interrupted-work-lane recovery outstanding |
| Framework | AgentSpaces retains work/claim/lease/result authority; direct replies do not establish signed delegated-work execution |
| Privacy | Owner-private state and scoped controls implemented; distribution review remains necessary |
| Distribution | Windows per-user NSIS installer/uninstaller and Linux archive/menu installer; unsigned alpha, no automatic updater or signed production release |

Exact native versions and upstream revisions remain in compatibility material and handoffs. A dependency update, fixture or screenshot is not release acceptance.

## Release checks

1. Retain the approved Apache 2.0 license and attribution. Check dependency redistribution notices, native addon packaging and accurate product/company branding against each release candidate.
2. Review the repository and Git history for private data, credentials, machine-specific material and runtime state. Validate showcase images separately.
3. Qualify the implemented installation/removal flows, upgrades and rollback, then establish signed distribution. Document retained state and bundled notices. Package construction is distinct from successful native-platform installation acceptance; see [installation](installer.md).
4. Qualify each advertised desktop platform, native version, login flow and host connection. Distinguish observed, fixture-tested and unqualified paths in a compatibility matrix.
5. Exercise refusal, native approvals, busy controllers, cancellation, disconnect and restart in the intended release configuration. Use explicit grants and budgets for live model tests.
6. Document local data, selected context sent to providers, remote channel connections, revocation and unknown usage or uncertain effects.
7. Record exact revision, tests and runtime evidence for the release candidate. Keep delegated work, direct conversations, integration and deployment claims separate.

Public repository visibility and Apache 2.0 are approved for this task. A transfer to a company-owned repository remains an owner decision. [v0.1.0-alpha.2](https://github.com/Weston-Tyler/agentspaces-desktop/releases/tag/v0.1.0-alpha.2) is the version-specific release target; record its published revision/artifact hashes and installed runtime evidence separately. Approval and public availability do not imply signed distribution, native-platform parity or production qualification.
