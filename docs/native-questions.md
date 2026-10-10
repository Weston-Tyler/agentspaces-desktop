# Native questions and targeted queue qualification

Advanced answering answers ordinary questions and questions using selected permitted work. The answering service is independent of source providers. An OpenAI answer can cite a Claude finding, for example, without waking the historical source. The default Native chat view uses the native provider login; see native-companion.md.

## Use the source alpha

Open Advanced answering, or the loopback URL with ?view=advanced. Choose OpenAI through native Codex or Claude through provider-permitted API, select local or remote, and enter the question. General question submits no history. Use connected work searches the full permitted session catalog and derived work map; choose shared findings or readable indexed files before Ask. Locked metadata and non-file map objects remain references rather than implicit content grants.

The request contains an explicit execution grant, stable delivery identifier and positive time/input/output/token bounds. The owner’s Ask button supplies the displayed limits. Native Codex uses existing native sign-in; Claude requires ANTHROPIC_API_KEY in the native helper’s environment plus a positive API cost budget and runs in bare mode. No key is collected, copied into instructions, passed in the prompt or logged. The current local/remote API environment is absent, so Claude readiness is unavailable. Its consumer subscription is not used as an embedded API credential. Credential configuration must occur in a protected environment on the selected host, not in chat or source.

Native questions use a fresh owned scratch folder, stdin prompts, native JSON output and no existing-session resume. Codex optional tools/MCP/hooks are disabled where supported and the filesystem sandbox is read-only. Managed native policy remains authoritative; this does not establish total tool isolation. Claude bare mode disables tool use and native session persistence. Native diagnostics are not retained. Cleanup is restricted to the allocated scratch path.

Timeouts bound observation and captured-output bounds limit retention; neither cancels native execution. Stopping Ask detaches its observer. A dispatched native process continues and its scratch directory is removed when it exits; no automatic retry occurs. Process or host shutdown survival is not guaranteed. Requested output tokens are checked after native completion, not a guaranteed hard Codex token/dollar cap. Unknown cancellation or acknowledgement outcomes consume a durable effect fence and are not automatically retried. API/native authentication, provider billing and subscription quota are distinct from these application records.

## Retrieval, citations and receipt safety

POST /api/ask/search matches the full currently permitted catalog rather than the Discover page’s 200-result window. Question punctuation/filler are ignored in keyword lookup; this is not semantic embedding qualification. Coverage carries known scan limits, errors, cursors, staleness and the absence of an account-wide completeness claim.

POST /api/ask/answer supports general/work modes. Bounded context forwarding requires current source enrollment/content/sharing grants. Files use the existing exact-byte inspector. Source identities, versions, capture/expiry, hashes and selected/retrieved/truncated/omitted counts accompany the answer. Source grants are checked again before actual provider dispatch and after the reply. Indexed bytes are rechecked on cached replay and completion. The model cannot cite an S-number that was never retrieved; citation presence does not establish the truth of every generated claim.

Owner-private receipt state is saved before dispatch. Reusing a delivery ID with different inputs rejects. Completed replay returns the recorded result, without another model invocation; revoked/changed source content is hidden. Only explicitly known preflight failure is recorded as before-dispatch; uncertain inference is never silently repeated. The API is owner-authenticated/CSRF-protected. Scoped MCP retrieval connectors cannot invoke paid/native Ask or change grants. POST /api/ask/cancel stops waiting for the answer without cancelling native inference. Before dispatch it prevents the request from starting.

Usage displays once-per-question receipt totals and known native token metrics separately from historical per-native-turn usage. Unknown metrics and missing native turn IDs remain unknown. Native exec JSON can identify the fresh thread without a native turn ID; no turn UUID is manufactured. Replies are rendered as safe text/limited formatting, never executable HTML.

## Actual tests and live evidence

The owner approved five short live questions. Exactly five completed; there were no model retries:

1. Browser → authenticated Ask API → remote Codex → displayed general answer 4.
2. Browser → full-catalog search → two selected shared Codex/Claude synthetic findings → remote Codex → displayed real answer with S1/S2 citations. Findings were samples; inference was actual native inference.
3. Owning Java targeted work → shared native daemon queue → owned read-only thread A → ORCHID.
4. Same targeted route → distinct owned read-only thread B → CEDAR.
5. Same original A native UUID → a distinct correlated turn → ORCHID recalled from its earlier context.

The initial queue transport attempt created no threads and dispatched no questions: the proxy is a raw byte relay to the daemon’s WebSocket listener, not JSONL. The corrected transport uses pinned ws8.22.0 for HTTP upgrade, masked frames, fragments, ping/pong, bounded payloads and no compression. It never starts a competing daemon or resolves/copies its tokens.

All three queued turns completed, with native thread/turn/queue/client IDs and duplicate receipt refusals. The initial harness then rejected a CBOR-decoded null-prototype usage map despite identical field values. The repaired harness compares fields and saves native answers plus exact signed snapshots before subsequent assertions. The original live group snapshot was not retained. Read-only recovery matched the exact three completed native turns/client IDs, then a new owning Java/TypeScript group signed and completed the recovered replies, with correct target issuer/claim holder and an unrelated-space request left unclaimed. This recovery performed zero queue mutation or model calls. Original queued token notifications were not retained, so recovered usage stays unknown. Fresh signed recovery is not the original signed packet.

Fixture/process/HTTP tests exercise permissions, full-catalog matching, serialization budgets, unavailable providers, cancellation, deduplication, restart, source changes, invalid citations, unknown usage and native transport correlation. Browser evidence and exact source/revision/runtime/test counts are in the local E2E handoff, not a release claim.

## Shared daemon queue scope

app/codex-queue.mjs uses only remote’s existing native daemon proxy with the qualified 0.161 experimental queue protocol. Native queues preserve busy threads. Stable client IDs correlate user-message events to native turns; queue insertion itself is not idempotent, so durable receipts precede mutation. Stop requests detach observation and preserve native execution. Grant revocation can withdraw an exact pending input, without interrupting a turn if dispatch has already occurred. A timeout or proxy disconnect is not proof of zero effect.

The original live exercise used controlled sources created through the owned read-only thread/start path. Subsequent source code adds existing-thread conversation routes: loaded direct-input targets under explicit acceptance of the existing native policy, or eligible cold targets bound through a native resume response. Metadata does not prove sandbox configuration; loaded-target evidence explicitly leaves policy unknown. Queue messages inherit native configuration without per-request policy overrides. Fixture coverage and native MCP reads do not broaden the earlier live-model proof to arbitrary discovered threads.

test/java/TargetedWorkProof.java and NativeQueueWorkProof.java reuse AgentSpaces ReplicatedSpace and typed Template.where selectors; TypeScript’s broad takeEntry is not used. Java owns claims/leases/completions, while the native runtime owns per-thread queuing. Local effect receipts and UI request cancellation are not another work registry or scheduler. This sidecar proof is not yet a production broadcast route from the Discussions/Ask UI to all native references.

## Remaining boundaries

Claude live API execution needs its configured provider-permitted credentials. Consumer-web ChatGPT/Claude histories are not native catalog access. Broad original-thread fan-out needs an owning native permission/approval/ownership integration and a production targeted work route. Cross-host controller fencing, signed chat synchronization, Mac/Linux native desktop installation, complete tool isolation, account identity verification, provider billing and released distribution remain unqualified. No maintenance automation, publication or another product’s runtime was changed.

Official interfaces: [OpenAI Docs app-server](https://learn.chatgpt.com/docs/app-server), [Claude programmatic CLI](https://code.claude.com/docs/en/headless), [Claude authentication rules](https://code.claude.com/docs/en/legal-and-compliance), [standard ws transport](https://github.com/websockets/ws).
