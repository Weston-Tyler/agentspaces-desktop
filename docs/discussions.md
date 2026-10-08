# Shared discussions and agent routing

The Discussions page keeps one owner-visible conversation around up to 12 permitted source-thread references. Titles, source IDs, host and provider come from the existing native metadata catalog. References do not copy histories or enroll participants. The picker searches all currently permitted discovered sessions, with up to 60 matches per provider shown; narrowing the query finds later matches. This is not a claim that every account conversation or every machine has been discovered.

Create a discussion, then address stable aliases such as @codex1 and @claude1 or choose threads under the provider-grouped reply selector. Mentions and selection are combined and deduplicated. Unknown mentions and references outside the discussion are rejected. Untargeted owner messages stay in the discussion. Each message retains its identity, optional parent message, source participant, native source ID, source version and attribution.

## What runs today

The owner can write and read local group messages. A native session with an explicitly configured application-issued connector can discover its permitted groups through discover_group_discussions, then use read_group_discussion and contribute_to_discussion. Author identity is bound server-side to that connector, not accepted from message arguments. Its native turn ID is self-reported and is labeled accordingly. All participants must have current enrollment/content/sharing grants within the caller’s project/account or active common workspace scope; the caller must have retrieval access. Grant revocation prevents connector reads and contributions. Revoked contributed content is hidden in the owner’s cached view.

This exercises real MCP SDK transport and the actual loopback HTTP authorization boundary with synthetic actors. It does not establish that a live native tool has loaded the connector or produced a verified native turn. No private history or paid inference is used in these tests. Global native configuration is not silently changed and a general-purpose administrator token is never shared with an agent.

Automatic native wake is not implemented. Selecting or mentioning a native source records a visible blocked request indication with no dispatch. This is conversation content, not queued AgentSpaces work. There is no local task scheduler, local claim implementation, polling of models or silent original-session resume. The native execution gate remains fixture-only. The current TypeScript binding’s typed take path lacks target-field/space filtering required to safely route a targeted work claim; ownership and native approval/budget qualification also remain open. These are upstream/native controller integration gates, not problems solved by adding instructions.

## Synthetic interaction

Open the explicit sample workspace, create a group containing Codex and Claude references, and send mentions or check reply targets. Synthetic participants return fixed demonstration messages and zero inference. A separate control allows 0, 2 or 4 extra synthetic dialogue turns. Every response is visibly synthetic with fixture turn identity and parent message reference. This verifies UI flow and bounds, not model reasoning, real agent autonomy or actual original-thread wake.

Stable delivery IDs deduplicate repeated submissions. Reusing an ID with different content is rejected. Owner-private settings persist local conversation records and their portable projection; restart does not replay execution. The alpha caps each discussion at 100 messages and each profile at 20 discussions. Conversation synchronization between devices, typing/presence, file uploads and live streamed native turns are not qualified. Read-only UI refresh makes no model calls.

## Portable conversation identity

The projection preserves the owning namespace ai.badmonkey.agentspaces.springai.model.wire.ConversationSnapshot and its conversationId/version/messages fields. WireMessage keeps role/text/toolCalls/toolResponses/media/metadata, with string-valued metadata. The selected owning model-wire revision is f55a89eb974cea30fdc295238a071239b462f1eb. This JavaScript projection is shape-tested; Java/CBOR interoperability and signed distributed chat synchronization are not established. The upstream fabric remains responsible for coordination and shared work. Local user-authored conversation content is not native history or an alternate work registry.

## Durable router installation

Run npm run setup for the current local account. The Setup page can preview/install on local or remote. The CLI is node scripts/install-router.mjs local|remote preview|install. The installer writes ~/.agentspaces-desktop/ROUTER.md and adds one managed pointer block to the active global Codex instruction file and Claude’s global CLAUDE.md. It follows CODEX_HOME, CLAUDE_CONFIG_DIR and the nonempty Codex AGENTS.override.md preference. Existing text outside the block is byte-preserved, including existing imports. Exact prior instruction bytes are backed up inside the protected router directory.

Repeated installation is idempotent. Malformed/duplicate blocks, manually changed or unmanaged router content, invalid encoding, symbolic links/junctions, unrelated state and concurrent instruction changes are refused. The supported format is bounded UTF-8. No provider credentials or private session exports are embedded. The router neither changes program authority nor authorizes native execution. Installation verifies file bytes; it does not restart sessions, configure MCP or prove that every agent loaded it. New sessions discover global instructions according to their native tool; already-open sessions must explicitly read the router or restart. Other accounts, profiles, machines and unsupported tools require their own entry-point installation.

The current router was installed and hash-verified for the local Windows account and the existing remote Linux account. Installation records are local evidence, not repository publication or release acceptance. Official loading semantics: [OpenAI Docs for global AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [Claude Code instruction memory](https://code.claude.com/docs/en/memory).

## Platform boundary

The source shell uses Electron and shared Node code. Local path semantics and labels now follow the actual OS; remote paths stay POSIX. Windows desktop rendering, source service and the new interaction are exercised. Linux router and portable discussion/path/persistence tests are exercised on remote. macOS path rules are covered by parameterized tests only. A Linux native Electron shell, macOS runtime, native sign-in launchers on those desktop platforms, signed installers and equal native tool feature parity are still unqualified. The convenient sign-in terminal button remains Windows-only; other platforms can use the displayed provider-owned command.
