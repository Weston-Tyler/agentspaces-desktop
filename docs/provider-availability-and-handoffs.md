# Provider availability and handoff proposals

The **Usage** page shows scoped observed metrics, availability reports and a form for proposing a provider change. All operations also work headlessly. None starts a model, cancels a turn, wakes a target or takes/releases a work claim.

## Availability is evidence with an expiry

The local owner may report `unknown`, `available`, `limited` or `unavailable` for Codex or Claude. Each report includes its origin, workspace/account scope, observation time, expiry and hash. Expiry is 1–1,440 minutes (default 15). The effective state returns to `unknown` on expiry; a report is not a verified provider quota, native login check or billing statement.

A source-bound participant cannot submit owner availability settings or arbitrary error text. It may reference its own exact persisted failed native delivery receipt. The service checks current source/room grants, source identity, timestamp, terminal failure status and a bounded code whitelist. It copies only the safe error code and provenance, never native diagnostics. A native receipt report applies to that source alone, never the entire provider. Its lifetime is at most 30 minutes from the original error. A recovered or changed receipt invalidates the report.

The current receipt adapter supports Codex's persisted native delivery errors. Claude channel receipts and headless process exit codes do not establish a classified quota error, so they are not treated as quota evidence. The owner can report a Claude limitation. Actual weekly allowance, remaining quota and provider billing are always `null`/unknown here.

Owner POST `/api/providers/availability`:

```json
{"provider":"claude","state":"limited","minutes":60}
```

Source POST to the same endpoint:

```json
{"nativeRequestId":"EXACT_SAVED_REQUEST_ID","minutes":5}
```

POST `/api/providers/status` with `{}` reads the dashboard. Source-bound usage is limited to that source's native identity; permission-eligible destination metadata and owner reports remain shared within the connected workspace.

## Observed usage

New session usage records retain which metric fields were actually supplied. A known zero differs from an omitted field. Legacy records without this coverage information remain unknown in this view. Explicit cumulative coverage replaces only the native turns it names.

Each metric includes `value` (or `null`), `knownRecords` and `unknownRecords`. Session records and native discussion receipts can describe overlapping work, so their totals stay separate and `combinedTotal` remains `null`. This view does not reconstruct token usage from transcript length or infer a plan's allowance. Existing Ask receipts keep their separate dashboard and attribution.

## Exact handoff, then a decision

1. Pick an existing work brief, an observed worktree and a permission-eligible thread using the alternate provider.
2. Preview the proposal. A source-bound caller must be the current claim holder; the owner may also propose. Both sources must currently permit sharing and point into the same observed worktree on the same host. The current work brief hash, latest reported branch/head and indexed worktree head must agree. Expired/completed work and truncated progress histories are refused.
3. Review the returned proposal and hash. It contains the existing brief ID/hash, declared repository/base, indexed repository evidence when present, exact progress ID/hash, worktree path/host/branch/head, current claim, target availability evidence and bounded artifact references from the owning artifact store when installed.
4. File that exact preview into the existing decision inbox. The service recomputes and checks the proposal hash before creating the request. Reuse `deliveryId` when retrying an unchanged request. If the evidence changed, preview it again.
5. The owner answers in the decision inbox. That answer does not start a job or transfer ownership. The current holder must finish/release its work through the owning workflow, or its lease must expire, before another source claims it. The target must obtain the required native authority and recheck the repository, current worktree and evidence before execution.

A provider reported limited/unavailable, or a target with a current failed-source report, cannot be selected until the report is resolved or expires. Unknown provider availability may be proposed but is explicitly labeled unknown. Scope eligibility does not establish transport readiness or provider quota. Cross-host relocation and automatic provider failover are not performed.

The worktree inventory must be no more than 15 minutes old and not marked stale. This is timestamped index evidence, not a new Git read: files or refs can change after indexing. The declared repository and indexed repository fields are retained separately for review; no identity equivalence or clean working tree is inferred. Preview output is capped at 10,000 characters to fit the owning decision contract. The bounded work view includes at most 200 briefs and 20 results per brief; artifact references include at most 20 rows and disclose truncation.

POST `/api/providers/handoff/preview`:

```json
{
  "workEntryId":"EXISTING_WORK_ENTRY",
  "workHash":"EXACT_64_CHARACTER_SHA256",
  "worktreeId":"EXISTING_WORKTREE_NODE",
  "targetSessionId":"EXISTING_ALTERNATE_PROVIDER_SOURCE"
}
```

POST the same fields plus the returned `proposalHash` and a stable `deliveryId` to `/api/providers/handoff/request`. The resulting decision is a coordination proposal, not an approval receipt for native execution. No second work registry or transferable claim is created.

MCP tools: `read_provider_status`, `report_native_availability`, `preview_provider_handoff`, `request_provider_handoff`. Participant CLI: `provider-status`, `availability-report`, `handoff-preview`, `handoff-request`. The last three read bounded JSON from stdin and expose offline `--help`. Native MCP/CLI installations must be refreshed to load new commands.
