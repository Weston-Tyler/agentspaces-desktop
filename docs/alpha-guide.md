# Running the Windows source alpha

Use Node 24+. From this checkout run npm ci, npm run check, and npm test. The pinned fabric Git dependency is built by the product postinstall script; upstream source/license/NOTICE remain with the dependency.

- npm run desktop opens the native companion. Closing its window hides it to its tray. Tray Quit closes this application's server and fabric connection.
- npm start runs the standalone loopback preview at http://127.0.0.1:43127.
- node app/cli.mjs status verifies the exact local runtime identity. node app/cli.mjs stop stops that verified instance.
- scripts/Start-Background.ps1 reuses a verified owned runtime and refuses to create a duplicate when prior state is unresolved. scripts/Stop-Background.ps1 stops it.
- npm run diagnostics detects installed versions without inspecting accounts or histories.

No system startup task, recurring automation, account connector or paid inference is installed automatically.

## First sample flow

Open the sample workspace explicitly. All sample sessions/findings are synthetic.

1. Inspect API client implementation (Codex). Enroll it and allow retrieval.
2. Search retry or filter archived Codex sessions. Inspect Retry and idempotency research. Enroll it, allow bounded content, and allow sharing.
3. Inspect its finding/artifact, choose the requester and retrieve. Original source/version/SHA-256 remain inspectable. No model runs.
4. Enroll Transport adapter implementation (Claude Code) with retrieval permission. Repeat for the cross-tool handoff.
5. Revoke a grant and verify refusal. Activity records actions that actually occurred.

## remote and local workstation

The companion runs on Windows/local workstation; remote is reached through the existing SSH alias and keeps native Linux authentication/configuration. No account/session tokens are copied.

In Setup, detect remote versions, select a tool/host, and explicitly authorize one absolute project folder plus an account boundary label. Codex discovery uses read-only app-server methods over stdio, locally or SSH. Claude discovery uses the pinned official SDK read functions locally or through a product-owned temporary read helper on remote. scripts/Install-RemoteReadHelper.ps1 installs that pinned SDK only; it reads no histories and starts no model.

Use the same project label and account boundary only when intentionally linking allowed work across machines/tools. Each host/provider/path target is granted separately. Source references include host, provider, original native thread ID, logical participant ID and version. Account labels are user-configured scope boundaries, not verified provider account identities.

Read metadata in batches of at most 50. Load the next page explicitly in Setup; earlier pages remain available. Metadata does not grant content. Enroll each selected session and separately allow bounded content and sharing/retrieval. Codex metadata omits the private preview field. Claude's catalog title may derive from a first prompt; the metadata grant includes this bounded title. Claude's SDK exposes no qualified live/archive state; it is shown as unknown.

Native sign-in buttons request a visible native terminal. Complete the provider's own flow there. The app does not collect credentials or assert a successful sign-in. This path was implemented but not used to reconnect accounts during the build.

## Fabric boundary

AgentSpaces remains shared-work/claims/result authority. The app implements no second task registry or lease scheduler. Application state contains permission settings, metadata caches, publication references, effect-reconciliation receipts and usage/audit views.

The local proof builds the upstream Java replicated-space runtime and uses the actual pinned TypeScript binding to join a verified self-certifying loopback group. Sample publication is limited to the synthetic project. Private native content publication remains unqualified. A publish returns exact entry/issuer references without pretending a write is an acknowledgement; retrieval reconciles the signed entry. Repeating publication reconciles its original reference.

The proof exercises signed findings, same/cross-tool app retrieval, subordinate identity persistence, upstream LEASE_RACE take/completion, result observation, duplicate effect refusal and reconnection. Session/execution payloads are synthetic; provider calls are zero. The founding fixture uses whole-second timestamps and a 10-second bootstrap bound. A repeated known-member bootstrap timed out even though fresh joins received valid founding documents. Reconnection now re-verifies the cached signed founding document and uses the upstream configured-group connection contract. Two independent end-to-end repeats passed after this repair; upstream source was not changed.

Inline text artifacts are limited to 16 KiB and have an application integrity digest. This is not a substitute block-exchange implementation. Large asset transfer, sealed-space support, general group admission, AgentCard publication and post-join transport liveness qualification remain open.

## MCP and native execution

Create a connector for an enrolled retrieval participant. The app issues its own scoped capability token, not a provider session token. Review its configuration and install through the native tool's supported MCP path. Only discovery and permitted retrieval are exposed; the connector binds caller identity. No global native configuration is silently changed.

The real MCP SDK stdio transport was fixture-tested. Installed native-tool MCP enrollment and per-native-thread caller propagation across desktop/CLI/IDE remain acceptance checks. Rediscover metadata after restart before a connector is usable; grants persist, private histories are never silently reloaded.

Native inference is disabled. The fixture-only effect gate tests one local controller per provider/account/native thread, duplicate deliveries, cancellation and lost-ack reconciliation by native turn ID. A busy result returns work to the upstream authority; the app has no alternate queue scheduler. Cross-host exclusion, native approvals, billing-scope mapping and autonomous session wake have not been qualified.

The next acceptance gate is an explicitly selected project/session cohort on each host: permitted metadata discovery, one bounded source-content read, installed native MCP retrieval and inspected provenance. Bounded native execution then needs a compatible supported path, an explicit execution budget and preserved native approvals.

The upstream TypeScript suite passed 57/59 on Windows. Its two failing assertions check POSIX 0600 key modes, which Windows does not implement. The product uses owner-only Windows DACLs for its state/keystore parent directories; a native ACL test passes. This is an application boundary repair, not a modified upstream suite or a complete keystore review.

This private source alpha has no selected open-source license, signed installer or release approval. Windows installation/removal, signing, rollback, dependency/privacy review and other operating systems retain release gates. No product code was pushed, merged or deployed by this lane.
