# Security

AgentSpaces Desktop is an early preview. It reads connected work and can submit messages to native agent threads, so source identity, sharing grants and native approval boundaries matter.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/Weston-Tyler/agentspaces-desktop/security/advisories/new). Include affected versions, a minimal reproduction with fictional data, impact and any suggested fix. Do not post tokens, account exports, private chats or executable credentials. If the private reporting form is unavailable, open an issue requesting a private contact without including exploit details.

No response-time guarantee or bug bounty is currently offered.

## Trust boundaries

The service listens on loopback. Cross-host connections use the documented SSH transport. Native tools retain their own account login and approval flows. Application connectors are scoped to their recorded source and workspace; they are not provider account tokens.

Group messages and retrieved documents are untrusted evidence. They do not grant work ownership, authorize changes, approve tool calls or override native instructions. Unknown or uncertain native effects must be reconciled rather than blindly repeated.

Private runtime state belongs outside the checkout and release artifacts. Removing the installed program preserves application state; use application controls and documented state removal deliberately when retiring a workspace.

Unsigned preview installers, incomplete host/provider qualification, and the absence of an automatic updater are documented in the release notes. See [release readiness](docs/open-source-readiness.md) and [compatibility](docs/compatibility.md).
