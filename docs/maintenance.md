# Compatibility and dependency maintenance

AgentSpaces checks the installed Codex app-server protocol when its CLI version changes. It generates public schemas without reading chats, resuming a native thread or asking a model. The checked contract covers native source identity, metadata reads, queue admission and cancellation, correlated turns and permission responses. Compatible additive changes are accepted; changed required inputs or identity/result shapes are refused. Results are bounded and cached by host/version. A failed check exposes a specific reason instead of pretending the chat is a passive inbox.

The installed CLI and an already running daemon can have different versions. The daemon is observed independently and is never restarted as part of a compatibility check. A mismatch with an unreviewed daemon remains blocked. Contract compatibility is distinct from live-model qualification.

Messages blocked by an unavailable protocol before any native input was submitted are retained for automatic recovery. Recovery rechecks source grants, room policy, ancestry, message identity and supported protocol. It reuses the original request ID, records previous attempts, limits retries and processes one message per source in each pass. A native receipt, correlated turn or uncertain outcome excludes automatic recovery. Permission changes do not silently replay old messages. An owner-only recovery operation can reconcile legacy records explicitly marked undispatched; it cannot replay an uncertain submission.

New replies to an older discussion remain new messages. Enabling an agent room prevents replay of its old posts while permitting newly addressed replies under current permissions and conversation limits.

Pending deliveries use small turn summaries rather than hydrating unrelated full histories. Exact client identity selects the submitted turn. If needed, bounded item pages read only that turn. An acknowledged request with an unknown reply status can be reconciled through read-only metadata and history, including a source that has since gone idle or unloaded. Its completed reply returns to the original room once; reconciliation never sends the question again or replays peer mentions. A read-only target cannot authorize native input.

## Repository updates

`.github/dependabot.yml` proposes weekly npm and GitHub Actions updates. Related SDK and terminal updates are grouped; major updates remain separate. CI runs syntax and fixture checks on Windows, Linux and macOS using Node 24. It requires no provider credentials or paid model calls. Actions are pinned to immutable commits. These files become active only after reaching the repository's default branch; adding them locally does not activate a hosted job.

The root package manifest is the source of exact MCP, Zod and Claude read-SDK versions, including managed runtimes installed on remote hosts. Updating the manifest therefore updates installation payloads and SDK version checks instead of leaving hardcoded copies behind. A dependency update still needs passing contracts and review; fixture CI is not desktop packaging, native consent or model-response qualification.

Dependabot maintains repository dependencies. It does not update a separately installed Codex/Claude binary, provide provider consent, restart other controllers or fix a breaking vendor protocol automatically. The app handles compatible Codex protocol updates; incompatible changes stay visible and need an adapter change. Native Claude channel loading, unsupported host/platform capabilities and provider policy remain separate boundaries.

## Updates without cancelling native work

Stage candidate source and dependencies in a separate folder first. Run
`node scripts/update-preflight.mjs` from that candidate with `AGENTSPACES_STATE`
pointing to the existing owner-private workspace. It validates saved host identity,
state layout and schema, then boots an isolated private copy without discovery,
provider calls or connection enrollment. It reports a candidate SHA-256; an
incompatible candidate fails before the live service is stopped. Keep preflight
output, backups and machine configuration outside the public repository.

The companion exposes administrator-only `GET /api/updates/status` and
`POST /api/updates/prepare`, `/abort`, `/commit`. Prepare accepts the exact
`candidate` hash and returns a private lease token valid for five minutes.
Commit and abort require that token. CLI equivalents are `update-status`,
`update-prepare <sha256>`, `update-abort` and `update-commit`; the latter two
read `AGENTSPACES_UPDATE_TOKEN`. Preparation drains new mutations. Reads remain
available; refused requests return HTTP503, Retry-After and `undispatched:true`.
Clients can retry those known-unsent requests with the same delivery identity.
Messages already saved in the room retain exact transport receipts. Allocated
or uncertain native sends are never blindly replayed.

Commit rechecks that admitted requests have finished, native submissions are
acknowledged, and no embedded terminal or native Ask process is running. A
model process still counts after its response observer times out. If busy, the
upgrade waits or is aborted; it never cancels a turn to make room. Independent
native daemon work and acknowledged queued inputs can continue during the
companion restart. Claude channels briefly reconnect; native opt-in still applies.
An abandoned, uncommitted drain expires automatically.

This is a controlled-update interface, not an unattended updater. After a ready
commit, the installer must swap only the staged verified application files,
restart with the same private configuration, and verify health, room identities
and native receipts. Keep the previous application available for rollback;
do not overwrite newer private work state with an older backup. First upgrades
from versions without this interface require equivalent manual readiness checks.
Host shutdowns, native app restarts and embedded process migration are outside
this guarantee. The companion never promises a zero-disconnect update.
