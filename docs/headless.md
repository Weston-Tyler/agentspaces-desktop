# Background companion

The loopback service runs independently of the Electron window. It restores connected work, serves the Ask home and discussions, and keeps permitted thread, repository, worktree, Markdown and artifact relationships available while the window is closed. Each native thread is a logical agent reference; discovery starts no model.

For normal installation, use the Windows setup executable or Linux per-user archive installer described in [installation](installer.md). The installed launcher opens the retained owner workspace. Windows registers Start/search, a desktop shortcut and an Installed apps entry; Linux installs an applications-menu launcher. Alpha packages are unsigned; automatic updating is not implemented.

For source development on Windows, install the locked dependencies with npm ci, then run scripts/Install-Windows-Shortcuts.ps1. The Startup shortcut invokes scripts/Start-Background.ps1, which starts the source service in a hidden process and preserves an already-running owned runtime. Run node app/cli.mjs status to verify it; scripts/Stop-Background.ps1 stops the owned service. These source-script shortcuts are distinct from the packaged installer; the startup script is not Authenticode-signed.

`AGENTSPACES_STATE` can retain the existing owner-private workspace when selecting a new source checkout. CLI, background startup and desktop attachment use the same runtime file; changing source code does not require copying credentials or creating another workspace.

## Retained state and owner access

Connected native metadata, access settings, room membership, shared messages and delivery receipts live in the owner-private application workspace. Closing and reopening the window restores them. Restarting the companion restores that state and reconciles its existing delivery evidence; it does not automatically restart every interrupted native work lane.

Ask retains at most 100 recent questions for 30 days, including completed answers, source references and coverage. It records failed/uncertain outcomes without automatically retrying native effects. “Clear recent history” clears this owner view while retaining duplicate-prevention receipts. Shared discussions are persistent, bounded records with no automatic age-based deletion currently implemented. This is local saved context, not unrestricted agent memory or a replacement for the owning program record.

The owner browser cookie persists with the workspace for up to 30 days and survives ordinary companion restarts. “Local access required” means that browser lacks a valid owner session, even when source-bound agents can use their own connectors. Open or reopen through the installed launcher so the app establishes the owner browser session. Owner-browser authentication, native participant registration, loaded MCP tools and inbound wake transports are separate states; report which one is missing rather than treating them as the same access failure.

Connect all persists the selected hosts, local-retrieval policy and file indexing. The normal selection covers this device and remote. Existing account labels, roots, exclusions and per-thread refusals remain authoritative; revoked broad scopes are not silently reenabled. Native catalogs publish first, followed by the owning workspace inventory and continuation path. A run is bounded to 32 batches and stops on stalled progress. Partial coverage remains visible. There is no idle model polling, transcript broadcast or cleanup of source repositories/worktrees.

## Direct native Codex conversations

Group messages use CodexDiscussionHub and CodexQueueAdapter through the existing remote native daemon. With the recorded owner grant accepting the existing native policy, an already loaded active or idle thread can receive queued input after exact metadata and direct-input checks. This path never resumes the thread or changes its controller or configuration; its target evidence explicitly records policyKnown: false. A cold binding still refuses preexisting queued work and resumes with threadId only to verify the returned effective policy.

Current group membership, sharing boundaries, source identity and grants are rechecked immediately before native queue insertion. Stable client IDs and durable receipts prevent duplicate submission. Native events identify the actual turn; its final response returns to the originating group with message ancestry. Unknown acceptance is not replayed. Stopping observation never interrupts a native turn. Only a revoked grant may withdraw an exact input still pending in the native queue. Native approvals remain with the native client and are surfaced as needing native-owner attention.

New group chats permit agents to initiate conversations. A participant opening post with aliases addresses those members; without mentions it stays readable in the room without waking peers. Replies can mention peers, and plain replies finish without compulsory rebroadcast. Explicit thread/date/topic addressing resolves the existing permitted catalog and persists its recipients before bounded group delivery. `@all` addresses the current room. Each opening post allows eight forwarding hops and 32 target allocations. A new opening post starts another exchange. Existing rooms require their owner policy to be enabled, which never replays older posts. Durable attempt markers, source grants and membership are checked before delivery. Legacy rooms retain two forwarding hops and 16 allocations per human opening post. Discovery itself never broadcasts.

Loaded native targets are not automatically subscribed to turn events by a metadata read. Pending loaded-thread deliveries therefore use bounded native status/history reads to locate only the exact submitted client ID. Other turn text is discarded. Polling stops when the request settles; it never invokes an idle model. Queue waiting is bounded separately from the 90-second requested reply window.

## Automatic native tools

Run node scripts/install-connected-tools.mjs once against the running companion. Setup uses the already granted retrieval scope, detects installed native apps, adds one source-neutral MCP server for each supported host/provider, and preserves existing configuration with private backups. Claude lifecycle hooks identify the native source by its session ID and matching live process. Codex supplies the thread ID in MCP request metadata. The registration device credential cannot retrieve content, post messages or change owner settings; each tool call obtains its own scoped source capability. Unknown sources remain pending until supported native metadata confirms them. Explicit revocation is never undone.

Setup persists across background restarts. Codex’s native MCP refresh is requested for the next active turn where supported. An already running Claude session may need a new native load to obtain newly installed hooks and tools. Installation is distinct from loaded tools and an active inbound channel. Claude’s native channel opt-in remains necessary for unsolicited inbound delivery; setup does not silently approve it or replace an existing controller.

Agents can explicitly identify themselves with `register_native_source`, find connected peers with `discover_permitted_work`, and start a group using `create_group_discussion`. Group creation includes the bound caller automatically and takes a stable delivery ID so uncertain retries do not create duplicate rooms. `discover_joinable_discussions` returns eligible room metadata; `join_group_discussion` adds the calling thread and keeps its alias stable on repeated joins. Agents then read and post through the existing discussion tools. The fixed-source MCP connector and participant CLI also support peer groups and joining.

Preparing a fixed-source fallback connection writes a fresh owner-private `USE.md` beside that connection's `participant.json` and returns `usageGuidePath`. The same current guide is generated locally and on remote, with exact source/account/scope/version provenance and every supported CLI command, including direct and topic/date broadcasts. It contains no credential value. Each connection gets a new guide; preparation never overwrites an older source's file. Read the returned guide rather than an old hash-named CLI example, and use that configuration only for its exact native thread.

New groups created in the app or by an agent permit self-registration within current account/project or workspace sharing boundaries. Existing groups remain closed until the owner enables “Connected agents can join this group.” Eligible agents join an open room on first read/post; current members can invite eligible peers. Joining changes no source grants and starts no model or replay. Source registration on remote reads metadata through the existing native daemon, with a bounded connection and no controller binding or resume. Pending metadata and known registration failures return safe error codes; private provider diagnostics and capabilities remain hidden. `create_native_thread` is the connector's supported empty Codex work-chat creation interface; it does not add or impersonate the native app's `create_thread` tool. Creation starts no model and retains native defaults.

Agents message an exact peer with `message_agent_thread`, or multiple peers through `message_agents` using `sessionIds`, `nativeThreadIds`, `query` and `activeWithinDays`. Human/agent message directives include `@all`, multiple `@thread(UUID)` targets and `@recent(30d) @topic("chillit recipe")`. Current grants are rechecked and omission/coverage is returned. Peers need no manually copied connector or individual owner-add step within standing workspace and room rules. Selection searches the same connected metadata fields as discovery; missing native activity cannot satisfy a date filter. See [agent addressing](agent-addressing.md).

The supported interfaces include source registration/capabilities, native discovery, room create/join/invite/read/post, direct and filtered messaging, empty Codex thread creation, findings, scoped workspace search/artifact reads and worktree comparison. Owner account connections, permissions, room policy, service administration, model budgets and native consent remain owner surfaces. Capability inspection exposes those boundaries. A missing tool in an older session should identify a reload requirement, not send the owner back to manually creating every group membership.

Direct conversation transport does not claim delegated-work leases or completion. AgentSpaces remains work/claim/lease/result authority, and fabric nativeExecution remains false. The earlier Java signed-worker proof is separate bounded evidence, not a deployed worker or qualification of arbitrary existing histories.

## Evidence and limits

Injected native RPCs and real HTTP/MCP/WebSocket transport fixtures test the new existing-thread route. There is no new live-model proof. Five earlier authorized short questions exhausted their allowance; three ran through owned read-only threads in the signed-worker exercise. They do not qualify the new route against arbitrary existing sessions.

Existing-thread headless Codex transport is remote-only. Local Windows supports metadata, native Ask and interactive terminals; its existing-thread daemon controller is unqualified. Windows/Linux package construction is implemented, while Linux desktop/provider parity and macOS acceptance remain unqualified. Provider credentials are never copied into this repository or replaced by application participant capabilities.

A shared work board, fair machine-resource broker, phone decision inbox, complete cross-product/cloud catalog and full interrupted-lane recovery are outstanding. Durable local context and conversation receipts address reopening and delivery safety; they do not establish those larger capabilities.

## Running without the desktop app

The companion service, scoped participant CLI, MCP interfaces and supported native delivery routes operate without launching Electron or keeping a desktop window open. From a configured source checkout, run `npm start` (equivalently, `node app/cli.mjs serve`) and install the native connectors following this guide. The desktop app is an optional owner interface, not the coordination runtime.

Headless operation still needs the companion service, the supported native tools and their own authentication, workspace grants, and any required SSH connection. Claude inbound wake additionally needs its native channel opt-in; a headless service does not bypass that requirement. Existing Windows native wake and cloud-agent limitations still apply.

## Recovering a message connection

The companion reconnects its previously configured reverse SSH bridge on the same
port, with backoff from one second to thirty seconds. It restores only the owned
transport: no source grants, native login or provider sessions are replaced. The
Setup & diagnostics page shows bridge state and pending/uncertain channel counts.
A running SSH process is not proof that a native agent received a message.

A loaded Claude channel keeps its MCP connection to Claude open while its companion
WebSocket reconnects. Messages addressed to a previously connected channel while it
is offline are retained in the existing private delivery receipts. On reconnect,
only messages whose transport write has never started are sent. Original message
hash, source grants, membership and room policy are checked again. An allocated or
uncertain write is never replayed, even after restart. Previously installed channel
modules need a native channel reload to load this behavior; the app does not cancel
or restart a running native turn to update them.

Codex failures known to precede message submission retry connection with backoff
(up to five minutes between attempts, for twenty-four hours). Original request and
message identities are retained. Native receipts and uncertain acceptance exclude
resubmission; completed replies can still be reconciled through the native reader.
The existing three-attempt bound remains for protocol/version qualification errors.

`native_lifecycle_binding_missing` is a different condition: Claude has no matching
local lifecycle observation. Transport reconnection cannot manufacture caller
identity. The installed SessionStart/UserPromptSubmit hook records it before network
admission, so the next native prompt can restore a missing record. If it remains
missing, verify that the managed lifecycle hooks are loaded in that native session.
Never borrow another thread's connection file to work around this error.
