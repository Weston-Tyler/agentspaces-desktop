# Standing briefs and idle continuation

An owner can approve follow-up work within one exact shared-board brief, with
expiry, required limits, always-ask action kinds and a bounded wake count. Native
Codex and Claude permissions remain authoritative. This is an authenticated
AgentSpaces delegation receipt, not a provider-attested human message. The native
owner must explicitly permit the thread to rely on these receipts first.

## Request and approve

1. Create and claim a work item through the existing work-board tools. Preserve
   its `entryId` and SHA-256 `hash` from `list_work_items`.
2. Submit a scoped `decision_create` request with the usual repository, branch,
   folder, action and limits, adding `approval.standing`:

```json
{
  "workEntryId": "exact-work-record-id",
  "workHash": "exact-64-character-lowercase-sha256",
  "alwaysAsk": ["push", "merge", "deploy", "devices", "provisioning"],
  "maxWakes": 5
}
```

The requester must hold that exact work claim. The complete immutable brief,
repository and requesting source are bound to the approval. A changed brief,
branch, folder or source needs a new request; another thread cannot inherit it.
The owner sees these fields in Decisions and answers using the separate owner
password. The existing expiry limit is at most 24 hours. Revocation and password
rotation invalidate future use. Additional owner limits supplement the original
limits and cannot remove them.

**Automatic wakes are off by default.** The owner must separately check “Wake this
thread when an authorized next step is pending and it is idle”. HTTP owners use
`wakeEnabled: true` on the authenticated `decision_approve` operation. The maximum
is 1–20 wakes per grant. An ordinary standing approval can permit the thread to
continue within its native turn without enabling any background wake.

## Continue and report

After verifying the exact decision using `verify_owner_approval`, the current
claim holder adds `continuation` to a normal work-board progress update:

```json
{
  "state": "pending",
  "stepId": "regression-check-1",
  "summary": "Run the brief's regression checks and record their evidence",
  "kind": "tests",
  "decisionId": "exact-decision-record-id",
  "requestHash": "exact-64-character-lowercase-sha256",
  "receiptId": "exact-owner-answer-record-id"
}
```

The update still includes the exact branch/head, summary and evidence. Step kinds
are `analysis`, `implementation`, `tests`, `documentation`, `push`, `merge`,
`deploy`, `devices`, `provisioning`, and `other`. A listed always-ask kind or `other`
waits for an owner decision. These labels do not classify shell commands or bypass
native permission checks. The receiving agent must observe the full brief and all
limits, not just its self-reported kind.

Use `blocked` or `gate_ready` when appropriate; neither triggers a wake. Completed
work, expired claims, superseded progress and revoked grants also stop wakes.
Claims are never renewed automatically. Reusing a step ID with different work is
rejected; retrying the same step never creates another wake. A new step is an
explicit new operation within the remaining owner-approved budget.

## Observe and recover

`list_work_continuations`, CLI `continuations`, and POST
`/api/work-board/continuations` return the pending step, authorization state,
native idle observation and native delivery state separately. These are derived
from the existing work/decision replica and message delivery receipts, not chat
text or a second job registry. `wake_recorded` is not proof of execution.

Every 30 seconds the companion examines at most four eligible sources, rotating
through the bounded board view. It reads metadata; it does not poll a model for
status. The supported automatic-idle route is a qualified, already-loaded remote
Codex thread with owner opt-in to its existing native client policy. Active
threads receive no idle wake; if activity starts between observation and dispatch,
the native queue handles the message without interruption. Existing queued input
prevents a new wake. Cold, missing and unknown states are left alone. Claude and
other routes without qualified idle observations report `unsupported`; their
standing approvals and explicit board steps still work.

Wakes use native queue insertion only. They never invoke native resume, steer,
interrupt, turn cancellation or queue unpausing. A paused native queue stays
paused. A supported idle/empty-queue observation does not attest that the client
has enabled automatic queue consumption.

The service saves one stable message before dispatch. A restart or update drain
may leave a known-unsent message `ready_to_deliver`; it is retried under the same
identity only after fresh grant/claim/idle checks. Already allocated or uncertain
native sends remain under the owning transport's reconciliation rules and are
never blindly replayed. New wakes stop during an update drain. Grant revocation
prevents future dispatch; it does not cancel native work already started. Each
receiving thread must recheck the exact grant immediately before acting.

Fixture tests cover immutable scope, claim/expiry/revocation, owner wake opt-in,
step deduplication, budgets, update drain, restart and native metadata-only reads.
They do not establish live model compliance or provider usage-limit enforcement.
There is no provider migration, phone UI or automatic tool approval.
