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
