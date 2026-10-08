# Shared discussions and agent routing

One owner-visible discussion references up to 12 permitted native threads. Each is a logical agent with its original native ID, host, provider and source version. References copy no history and start no permanent model. The picker searches discovered permitted catalogs; it is not a census of every account or machine.

Use stable aliases such as @codex1 and @claude1 or the app-grouped selector. Mentions/selections are deduplicated; unknown aliases and nonmembers are rejected. Untargeted messages stay local. Replies retain their original parent and source attribution.

## Native replies

Targeted remote Codex references use the owning shared daemon. Binding reads metadata, refuses a busy owner/prior queue and resumes with threadId only. It verifies exact identity/cwd and effective permissions without overriding settings. Full-access policy needs the recorded owner grant. Current membership, sharing and source identity are fenced before queue insertion. Native user-message correlation supplies actual thread/turn identifiers; final responses return to the group. Approvals are declined and reported as needing native-owner attention.

Claude participants use the opted-in preview MCP channel in their running interactive native session. The provider owns authentication and consent. Application capabilities bind the contribution to its enrolled source; native turn identity remains self-reported and unverified. Transport acknowledgement is not a completed answer. Disconnected channels stay unavailable.

All participants require enrollment/content/sharing/retrieval within the project/account or active common scope. Revocation blocks delivery, reads and contributions and hides revoked shared context. Native login does not authorize unrelated accounts, excluded sources or private rollout-file access.

## Bounded routing and recovery

Agent replies may mention another group member. Delivery must descend from an owner-authored message and is bounded to two forwarding hops and 16 target allocations per owner root. There is no independent peer initiation, broadcast, idle LLM polling or endless dialogue. Peer messages are untrusted context, not delegated authority to change work or approve actions.

Stable IDs deduplicate submissions and contributions. Reusing an ID with different content is rejected. Unknown native acceptance is not replayed after disconnect/restart. Cancellation deletes an exact pending native entry or interrupts its correlated turn. Restored permission evidence requires rebind. Limits remain 100 messages per discussion and 20 discussions per profile.

Direct conversation delivery and private effect receipts do not claim work leases or completion and do not form a scheduler/task registry. AgentSpaces retains that authority; fabric nativeExecution stays false. The Java signed-worker exercise is separate evidence, not a production worker. The original generic execution gate remains fixture-only.

## Evidence and portable records

Injected native RPCs and real HTTP/MCP/WebSocket fixtures exercise the new route. No new model calls qualified it. Five earlier authorized questions exhausted the allowance; three came from the owned read-only signed-worker proof. That evidence does not establish the new route against arbitrary existing native histories. Live Claude consent/replies, Windows existing-thread headless control and macOS parity remain unqualified.

Local projections preserve ai.badmonkey.agentspaces.springai.model.wire.ConversationSnapshot with conversationId/version/messages. WireMessage retains role/text/toolCalls/toolResponses/media and string-valued metadata. Model-wire reference: f55a89eb974cea30fdc295238a071239b462f1eb. Shape tests do not establish signed distributed chat synchronization or Java/CBOR interoperability. Original tools retain source/history ownership.

## Router installation

Run npm run setup locally, or node scripts/install-router.mjs local|remote preview|install. It writes ~/.agentspaces-desktop/ROUTER.md and one managed pointer in active global Codex/Claude instructions. Surrounding bytes/imports are preserved and backed up. Installation is idempotent; malformed blocks, unsupported encoding, links, unrelated state and concurrent changes are refused.

Guidance does not configure MCP, copy credentials, restart sessions or establish execution authority. New sessions load supported global instructions; open sessions must read the router or restart. Other accounts/agent homes need their own pointer. Keep participant capabilities protected, never in docs/logs. Existing Windows/remote installation evidence is local, not publication or release acceptance. [OpenAI global instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md) and [Claude instruction memory](https://code.claude.com/docs/en/memory) describe loading.

See [native companion](native-companion.md) for Ask/terminals/channels and [background operation](headless.md) for service startup and platform limits.
