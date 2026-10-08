# Open-source readiness

AgentSpaces Desktop is a source alpha intended for an open-source release. Local showcase documentation does not publish the repository, change visibility or grant a license. No project license has been selected. Dependencies’ licenses do not automatically license this application.

## Showcase material

The [README](../README.md) and [walkthrough](walkthrough.md) use sanitized demonstration images:

- [Ask](images/ask.png): fictional question, sources and synthetic answer.
- [Group chat](images/group-chat.png): fictional thread agents and synthetic replies.
- [Connected work](images/connected-work.png): fictional projects, paths and relationships.

These are presentation examples, not live native execution proof. Generate them in an isolated demo runtime. Check every exported image for private titles, usernames, machine addresses, local paths, repository names, credentials and hidden metadata before release. Screenshot generation must make no native model calls. Acceptance evidence belongs in revision-bound test and runtime records.

## Current boundaries

| Area | Evidence boundary |
| --- | --- |
| Desktop | Windows source application observed; no signed packaged release |
| Linux | Remote terminal and adapter target exercised; Linux desktop parity unqualified |
| macOS | Packaging, native login and acceptance run unqualified |
| Ask | Automatic permitted context; native inference requires supported authentication and request limits |
| Claude groups | Native channel and transport fixtures; live preview consent and model reply need their own evidence |
| Codex groups | Scoped headless conversation implementation and fixtures; no new arbitrary-thread live qualification |
| Framework | AgentSpaces retains work/claim/lease/result authority; direct replies do not establish signed delegated-work execution |
| Privacy | Owner-private state and scoped controls implemented; distribution review remains necessary |
| Distribution | Source launchers and shortcuts; no published package, installer or active updater |

Exact native versions and upstream revisions remain in compatibility material and handoffs. A dependency update, fixture or screenshot is not release acceptance.

## Before public distribution

1. Approve a project license. Review dependency licenses, redistribution notices, native addon packaging and trademark/name use.
2. Review the repository and Git history for private data, credentials, machine-specific material and runtime state. Validate showcase images separately.
3. Build signed installation/removal flows, document state retention, and test upgrades and rollback. Source shortcuts are not installer coverage.
4. Qualify each advertised desktop platform, native version, login flow and host connection. Distinguish observed, fixture-tested and unqualified paths in a compatibility matrix.
5. Exercise refusal, native approvals, busy controllers, cancellation, disconnect and restart in the intended release configuration. Use explicit grants and budgets for live model tests.
6. Document local data, selected context sent to providers, remote channel connections, revocation and unknown usage or uncertain effects.
7. Record exact revision, tests and runtime evidence for the release candidate. Keep delegated work, direct conversations, integration and deployment claims separate.

Publishing, changing visibility, selecting a license, transferring ownership and releasing binaries are separate owner decisions. This prepares a reviewable local showcase; it does not perform those actions.
