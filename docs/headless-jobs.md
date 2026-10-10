# Owner-launched headless jobs

An owner can launch a local Codex or Claude job from explicit brief text or an exact
brief file, without opening the desktop window. The companion must already be
running. This is a native process adapter with durable effect receipts; it does not
add a scheduler or a second work registry.

Create the work item on the existing board first. The launch claims it for the
owner through the owning AgentSpaces contract, or checks the owner's existing
claim. A different agent's claim is refused. Include a permitted discussion ID and
an existing message ID when a room link is desired. Launching does not send a wake
message to room members.

Use `node app/cli.mjs job-launch` with bounded JSON on stdin, under the owner account
that owns the companion state:

```json
{
  "deliveryId": "my-headless-job-0001",
  "provider": "codex",
  "cwd": "/absolute/owned/worktree",
  "workEntryId": "exact-work-board-entry",
  "briefPath": "/absolute/brief.md",
  "budget": { "observationMs": 900000, "maxTurns": 10, "maxCostUsd": 5 }
}
```

Supply either `briefPath` or `briefText`, not both. Briefs are limited to 16 KiB.
Paths and prompts are passed through native process arguments/stdin, never shell
interpolation. Arbitrary arguments and environment overrides are not accepted.
Reusing the exact `deliveryId` returns the original job and never spends again;
changing its inputs requires a new delivery ID. At most three jobs may be active,
and jobs cannot concurrently own the same directory or work item.

`node app/cli.mjs jobs` reads metadata (send `{}` or an exact `id` on stdin).
`node app/cli.mjs job-log` reads a job's private bounded stdout with `{"id":"..."}`.
Agents have a scoped `list_headless_jobs` tool and `jobs` participant CLI command;
launch and raw logs remain owner-only. Agents can use `request_headless_job` with the
same explicit payload (briefText, up to 8 KiB) to file an owner decision containing
launch-ready JSON. This uses the existing decision inbox, not a new grant registry.
Capabilities report `blocked_requires_owner_launch`: answering the decision does
not automatically launch or grant native authority. The owner launches the exact
reviewed payload; an agent-held claim must first be settled through the owning work
flow, and cannot be taken over. Native client permission prompts remain authoritative.
No public network endpoint is added.

Codex uses `exec --json -`; Claude uses print/stream-json with its native maximum
turn and dollar-budget options. Both retain native configuration, repository rules
and tool permissions. No bypass-permission flags, fallback provider or credential
copying are introduced. A headless process cannot answer an interactive permission
prompt on the owner's behalf; unmet native permissions may stop the job.

**Budget limits differ by provider.** Claude receives its native turn/cost limits.
Codex receives those limits in the brief; this adapter does not claim a hard turn or
billing cap for Codex. `observationMs` limits waiting, not execution. A timeout never
kills a native process. It stays active until its actual exit and prevents a safe
companion update while owned. Work claims renew every five minutes while the process
is owned; failed renewal is reported without cancelling the native turn.

The durable receipt tracks running, finalizing, finished or died. The last 64 KiB of
stdout is retained privately; truncation is explicit. Stderr is drained without
retention because diagnostics can contain credentials. Native usage is recorded
only when supplied in known event fields. The final answer, or an explicit missing
answer report, is saved using the existing report-artifact contract, linked to the
work item and optional room message. A failed process is never called completed
work. Artifact publication can fail if the claim or sharing grants changed; its
private job receipt retains that limitation. Jobs do not complete work claims.

After an unexpected companion restart, an outstanding receipt is `outcome-unknown`,
not falsely declared dead and not re-executed. It remains an update/admission blocker
until its native process ownership is reconciled. Automatic restart/resume is not
implemented. Remote launch is unsupported until durable remote process ownership
can distinguish an SSH outage from native process death. Existing native terminals
and room messages are separate routes and cannot cancel a headless job.

## Provider handoffs

If a provider reports a usage limit, the owner can inspect the original process,
its brief, worktree and report, then explicitly authorize a new launch with another
provider and a new delivery ID. Establish that the old process has stopped first;
never run both against the same worktree. Reuse the owning work item and native
client approvals. There is no automatic spending, quota estimate, subscription
balance dashboard or implicit fallback to another provider/account. Observed usage
and unknown limits must remain distinguishable.
