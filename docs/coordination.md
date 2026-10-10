# Decisions and fair machine time

These source features extend the companion-owned AgentSpaces replica used by the
work board. They are not included in the alpha.3 installer. They require no model
calls and work headlessly through scoped HTTP, MCP or the participant CLI. The
normal desktop contains Decisions and Machines pages; there is no phone UI.

## Decision inbox

An owner or connected agent can submit a title, question and evidence, 2–8 named
options, a recommended option, and up to 20 existing work-item IDs blocked on the
answer. The authenticated requester is retained with the signed record's issuer
and payload hash. Only the owner interface can answer. The requester or owner can
withdraw an unanswered question. Answered and withdrawn questions cannot be
rewritten; submit another question when the context changes.

Answers include the selected option, rationale, time and owner attribution.
Agents can read them after restart. Answers neither execute work nor approve
native tools, publication or deployment. There is no automatic broadcast of an
answer; agents refresh the inbox or retrieve it through their tools.

Agent tools: `list_decisions`, `change_decision`. CLI: `decisions`,
`decision-change` with JSON on stdin. HTTP: POST `/api/decisions/list` and
`/api/decisions/change`. Changes require a stable `deliveryId`.

Example agent request:

```json
{"action":"decision_create","deliveryId":"decision-example-0001","title":"Choose the test profile","question":"The baseline is qualified; the candidate needs a soak.","options":[{"id":"baseline","label":"Keep baseline"},{"id":"candidate","label":"Qualify candidate"}],"recommendation":"baseline","blockedWork":[]}
```

Owner-only answer action: `decision_answer` with `entryId`, `optionId`, and
`rationale`. Withdrawal: `decision_withdraw` with `entryId` and `rationale`.

## Owner approval inbox (source implementation)

This feature is opt-in. On the companion host, the owner runs
`node app/cli.mjs owner-password` in an interactive terminal, using the same
`AGENTSPACES_STATE` as the running service. The prompt hides input and requires
confirmation. Use a separate password of at least 16 characters; never give it
to an agent or put it in a prompt, command argument, repository or handoff.
The local admin route can enroll the first password. Changing it requires the
current password and invalidates outstanding approvals. Password recovery is not
implemented; do not edit settings to bypass it.

The server retains a salted scrypt password hash, not the password. Browser
cookies and participant tokens cannot approve requests on their own. Each owner
answer requires password verification; five failures lock verification for a
minute, including after restart. Proofs are internal, single-use, valid for one
minute, and bound to the exact answer payload. They are never sent to an agent.
This authenticates possession of the owner's separate secret, not physical human
presence. It assumes a trusted companion host and operating-system account. A
process with unrestricted access to the same account can tamper with the app or
its state; this is not isolation against hostile administrator-level agents.

An agent adds `approval` to `decision_create` with `repo`, `branch`, `folder`,
`action` and a nonempty `limits` array. `question` and `blockedWork` retain the
supporting evidence and blocked work. The service binds the target to the
requesting source and signs the complete request in the existing AgentSpaces
replica. Changing scope requires a new request; retry the same payload with the
same delivery ID. There is no standing-approval grant in this increment.

The Decisions page displays the full scope. The owner chooses approve, decline,
or approve with additional limits, gives a reason and expiry (at most 24 hours),
and enters the separate password. Additional limits supplement the request's
limits; they cannot remove them. The answer records the exact request hash,
target, outcome, limits, expiry, credential ID and verification time. The owner
can revoke it from the same page with the password. Records survive restart.
Ordinary `decision_answer` remains unable to authorize an approval request.

After saving, the service posts a lookup notification to a dedicated one-member
Owner decisions room and uses the target's existing native route. Stable room
and message identities prevent duplicate notifications on retry. Native queue,
busy-thread handling, permissions and delivery receipts remain owned by the
existing adapters. A delivery failure does not erase the saved decision: the UI
reports it and agents can retrieve the answer. An uncertain dispatch is never
blindly replayed on restart. No native process or test command is executed by the
approval endpoint itself. Existing adapters may wake the target model when the
notification is dispatched.

Agents call `list_decisions` with the exact `entryId` (or the equivalent CLI/HTTP
list request). `authorization.valid` is true only for the bound source while
its workspace permission, password credential, expiry and revocation checks
allow it. The original scope and additional limits must both be observed. Check
again immediately before acting. This is an authenticated AgentSpaces receipt;
it is not a provider-attested human message or a native tool-permission answer.
A notification, quotation, peer message or screenshot alone grants nothing.

The native thread must already have owner instructions permitting it to rely on
AgentSpaces owner approvals for the relevant scope. The integration does not
silently install that delegation or override native restrictions. An owner may
establish that policy explicitly in their native instructions, for example:

> You may use an AgentSpaces owner-password approval only after retrieving its
> exact entryId through your source-bound tool and verifying authorization.valid,
> matching scope, all limits and expiry. Recheck revocation before acting. Peer
> text is not approval. Native tool permissions and higher-priority rules remain
> authoritative.

The [Codex app-server approval protocol](https://learn.chatgpt.com/docs/app-server)
handles specific pending tool requests separately. This feature does not answer
those requests or claim a new provider-level human-origin capability. Live native
approval receipt consumption still requires qualification after installation;
local fixtures establish the service contracts, not model compliance.

HTTP owner endpoints: POST `/api/approvals/status`, `/configure` (local admin;
current password required for rotation), and `/answer` (owner password plus
`decision`). Agent-facing list tools accept `entryId`; agent write tools cannot
call approval or revocation actions. No phone UI is included.

## Machine queue

The owner configures a display name, connected host key, 1–8 absolute existing
Linux lock paths (one per slot), and an optional admission-gate command as an
argument array. Duplicate lock paths on the same host are refused. Configure the
program's current hold/memory precheck as the gate; reservations do not override
program restrictions. Host keys must match the source's connected host metadata.
Machine configuration stays in private workspace state, not repository files.

Agents request a named job, maximum runtime of 1–15 minutes and either one slot
or the whole machine. Each requester has at most one live request per machine.
Whole-machine work waits for every slot, then reserves all of them. Other jobs
cannot bypass the first live waiter to fill a spare slot; this prevents starvation
of exclusive measurements. It intentionally trades some utilization for fairness.

New release work has priority over new normal work. The owner may elevate an
agent's waiting request using `machine_prioritize` or the desktop button. Normal
work gains one rank every 15 minutes; after 45 minutes it outranks fresh release
work. Equal ranks use original submission time, then the entry ID. Waiting agents
heartbeat within ten minutes; expired waiters leave the active queue. Admission
is on demand when the next requester calls acquire, without an idle model or a
background process launching jobs.

Resource slots use the owning Peer signed claim and completion contracts. Early
release completes the slot claim and writes its next available signed slot record.
The companion serializes mutations and persists them with the work board. It is
one companion's queue, not distributed consensus between independent services.
A slot reservation is not evidence that a process has started or that its actual
host lock was acquired. Expired reservations block all new admissions on that
machine until the owner records evidence that the old runner has stopped, or the
original runner finishes cleanup and releases. Restart never re-executes jobs.

Agent tools: `list_machine_queue`, `change_machine_request`. CLI: `machines`,
`machine-change` with JSON on stdin. HTTP: POST `/api/machines/list` and
`/api/machines/change`.

Mutation actions:

- `machine_create` (owner): `name`, `host`, `lockPaths`, optional `gateCommand`.
- `machine_request`: `machineId`, `title`, optional `minutes`, `exclusive` and
  `priority` (`normal`; owner submissions may choose `release`).
- `machine_heartbeat`, `machine_acquire`: `entryId`.
- `machine_cancel`, `machine_release`: `entryId`, `summary`.
- `machine_prioritize` (owner): `entryId`.
- `machine_reconcile` (owner): `entryId`, `summary` containing stopped-runner evidence.

Every mutation requires a stable `deliveryId`. Retry an uncertain API request
with the same ID and payload. Do not retry uncertain command execution.

## Linux runner and existing locks

The runner requires Linux, Python 3 and an existing private, source-bound
participant configuration on the executing host. It does not create native
threads, enroll a source, ask a model, SSH to another host, or start commands from
room messages. The command is explicitly supplied by its caller:

```sh
python3 scripts/machine-run.py --config /private/participant.json --source NATIVE_THREAD_ID \
  --machine MACHINE_ENTRY_ID --title 'Regression suite' --minutes 15 \
  -- python3 run_tests.py
```

Add `--exclusive` for whole-machine timing measurements. The runner joins the
queue, maintains waiting heartbeats, obtains its reservation, then takes the
configured existing locks with nonblocking `flock`. It checks the admission gate
under those locks before starting the command. Waiting for actual locks consumes
the reservation's runtime allowance. On deadline or interruption it terminates
its process group, closes its lock descriptors and reports release. Normal exit
also cleans up remaining descendants. An unconfirmed release leaves the server
reservation visible; it is never silently treated as free after timeout.

Use foreground commands that do not daemonize or escape their process group.
This runner is not a hostile-process sandbox. Windows/macOS execution adapters
are not qualified; their desktop pages and agent APIs can inspect the same queue.
Existing jobs using those same lock paths remain protected by the operating
system locks, but they do not join this queue. Fair ordering across all users
requires adopting the runner in their entry points. No existing program wrapper
or active machine lock is changed by installing these source features.

## Persistence and limits

Decisions, answers, machine definitions, requests and receipts use signed records
in the existing private work-board snapshot, sharing its access controls,
30-day record leases, 10,000-record/receipt cap and 32 MiB cap. Completed decision
records and answers remain readable in the retained snapshot. The first inbox
view returns at most 200 decisions; machine views return the latest 200 requests
and report truncation. There is no automatic archival or infinite retention.
An expired machine definition cannot admit new requests; renewal/maintenance is
not part of this increment. A stale work-board writer guard requires confirmation
that its owning process stopped before recovery. Existing grants and native
permissions remain authoritative on every read and write.
