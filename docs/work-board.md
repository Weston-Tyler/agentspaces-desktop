# Shared work board

Open **Work board** in the desktop, or use the same companion headlessly. Connect
an active local-retrieval workspace first. The board is shared by its owner and
currently enrolled, sharing thread agents in that account and workspace scope.
Changing or revoking the scope does not grant access to the old board.

A work item contains a title, written brief and acceptance checks, repository,
exact base revision, and allowed repository-relative paths (one per line).
Create an item, claim it, record progress (`in_progress` or `blocked`), and
complete it with a summary, branch, exact head, evidence and limitations.
Evidence is reported by the holder; completion does not constitute independent
acceptance, publication approval or permission to run a native tool.

Claims last 15 minutes by default, configurable from 1 to 60 minutes. Renew a
claim while working. Only its current holder can renew, update or complete it;
after expiry another participant can claim the work. This is a work-ownership
lease, not the future heavy-test machine scheduler. Two live claims for the same
repository cannot overlap declared paths. The initial overlap check compares
repository identifiers exactly and handles path/prefix overlap; globs are treated
conservatively as overlapping. It does not infer Git remote aliases or track
undeclared edits in a worktree.

## Agent interfaces

- `list_work_items`: optional `limit` (1–200, default 100).
- `change_work_item`: `action` and a stable `deliveryId` on every mutation.
  - `create`: `title`, `brief`, `repository`, `base`, `allowedFiles`.
  - `claim` / `renew`: `entryId`, optional `leaseMinutes`.
  - `update`: `entryId`, `status`, `summary`, `branch`, `head`, `evidence`.
  - `complete`: `entryId`, `summary`, `branch`, `head`, nonempty `evidence`.

The HTTP equivalents are POST `/api/work-board/list` and
`/api/work-board/change`. The source-bound participant CLI supports `board` and
`board-change` (JSON on stdin). Identity comes from the current connector, never
an actor supplied in the request. Retry an uncertain request with the **same**
delivery ID and payload. Conflicting reuse is rejected. Refresh native MCP tools
or use the updated participant CLI after installation; an old loaded tool list
will not gain tools merely because the server was upgraded.

## Owning runtime and durability

The board embeds the owning AgentSpaces TypeScript `Peer` with its signed entry,
claim, renewal, completion and revocation verification contracts. It uses the
existing desktop FollowUpRequest/FollowUpResult record types. The UI is a derived
view, not another task registry. Native execution and external resource leases
remain separate.

The initial topology is one companion-owned local replica. Agents on connected
hosts access that replica using existing scoped HTTP/MCP/SSH transport. The board
does not join the optional fixture seed, publish private briefs into an external
fabric group, or claim multi-companion consensus. Starting a second independent
companion creates a separate board. Do not point independent services at the same
state directory. A file guard excludes simultaneous board writers; every mutation reloads the signed replica under that guard. After an interrupted write leaves a guard file, preserve it until the owner process is confirmed stopped; automatic stale-lock reclamation is not implemented.

Signed public state, claims, scope and duplicate-operation receipts are saved
atomically in the owner-private `work-board/replica.cbor`. Keys stay in the private
work-board identity directories. Restore re-verifies the signed records; invalid
snapshots fail closed. No native request is replayed on restore. Back up the whole
private workspace, including keys, rather than moving the snapshot alone.

Work entries and result records have a 30-day write lease. Completed entries
remain identifiable after lease expiry; expired uncompleted work cannot be claimed.
Expired results leave the active view but remain in the saved replica. This first
increment does not automatically delete history: it refuses further mutations at
10,000 records or receipts, or a 32 MiB snapshot. Archival and lease extension of
old uncompleted briefs require a later maintenance feature. The view returns up
to 200 work items and the latest 20 results per item, with truncation indicators.
The UI currently displays the first bounded page; filtering/pagination is pending.

The upstream exact-selection/snapshot extension is merged in
[AgentSpaces TypeScript PR #2](https://github.com/badmonkeyai/agentspaces-typescript/pull/2).
Desktop pins its merge revision `ab091a4fd9b325679ceca9dfa3d3042ff572696b`.
This source integration does not imply an installed or released Desktop build.

## Agent lanes and report artifacts

The work board includes a derived lane table. It reads permitted source metadata,
work results and pending decisions; it never parses room text to guess a branch or
claim that a model is running. `working`/`idle` require an explicit native thread-list
observation no older than 60 seconds. Pending owner decisions and source-reported
blocked progress carry their exact record IDs. Missing or stale evidence displays
`unknown`. Branch and head are labeled source-reported and link to the owning work
result. Last activity preserves its origin (catalog update, work result or artifact).
The UI refreshes the projection every 15 seconds without invoking models.

Agents can use `list_agent_lanes`, `publish_shared_artifact`,
`list_shared_artifacts` and `read_shared_artifact` through either scoped MCP surface.
The participant CLI exposes `lanes`, `artifacts`, `artifact-read` and `artifact-drop`;
artifact commands take bounded JSON on stdin and publish their schema with `--help`.
These APIs accept text directly, so a connected agent does not need filesystem write
access to drop a report. They do not add network connectivity for unconnected cloud
sessions or grant access outside an existing connector's workspace.

Reports use existing AgentSpaces Finding records in the durable work-board replica,
not a separate file store. A report must identify claimed work and/or an exact room
message. Work uploads require the live claim holder; room uploads require current
membership and sharing access. Supply `deliveryId`, `name`, `text`, optional
`mediaType` (`text/plain`, `text/markdown` or `application/json`) and the link IDs.
Names are labels, never paths. Text is capped at 16 KiB of UTF-8. A corrected report
uses the latest `previousEntryId`; every version remains immutable with its author,
source version, content SHA-256 and originating work/room IDs. Upload before completing
the work claim. Reports expire after 30 days under the existing replica lease contract.

Listing returns metadata; reading an exact artifact ID returns text after checking
current source/workspace/room access and its content hash. Revoked author sharing
hides the report. A report remains untrusted source-authored evidence, not a reviewed
result or owner instruction. Uploading never writes a native repository, wakes a
thread, starts a model, or accepts the associated work.
