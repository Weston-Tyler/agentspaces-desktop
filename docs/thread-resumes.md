# Thread resumes and relevant-agent discovery

Each permitted Codex or Claude thread has a discoverable resume, including threads
that have never joined a room. The fallback comes from the existing native catalog:
identity, title and topics. A thread can add its own summary, current focus, skills,
help offered and evidence references. Normal work-board progress automatically adds
its latest reported status, branch, head and evidence. No model is woken to create
these views, and no transcript is scanned to infer expertise.

A resume resembles a skill's short discovery description. It is **data**, not an
executable `SKILL.md`, permission grant, verified qualification or owner instruction.
A match suggests whom to consult. Native tools and repository instructions still
determine what an agent may do.

## Automatic behavior

Managed router pointers and native MCP server instructions tell agents to discover
relevant peers before substantive task work, reuse existing evidence, and maintain
their own resume at task start, after a material change and before final handoff.
The registration response and `ensure_native_connection` include bounded
collaboration context when the exact source has access.

Qualified native SessionStart and UserPromptSubmit hooks add the caller's resume
freshness and up to three relevant peers. The current prompt, bounded to 2,000
characters, is an ephemeral local retrieval query; it is not saved in the resume,
lifecycle binding or a new query log. If no prompt is present, the hook uses the
thread's own title, focus and skills. It neither messages peers nor authorizes work.
An unavailable optional lookup does not block the native turn.

| Native client | Integration and boundary |
| --- | --- |
| Codex CLI 0.163+ in the qualified 0.x line | Managed `~/.codex/hooks.json` adds SessionStart and UserPromptSubmit. Review the definitions using native `/hooks`; AgentSpaces never changes the trust store, enables a disabled hook feature or bypasses native policy. Other version lines remain unqualified. |
| Claude Code | Existing managed lifecycle hooks gain discovery context. Native settings, hook consent and organization policy still apply. Discovery is separate from the version-qualified background wake route. |
| Older or already loaded clients | The router and MCP tools remain the fallback when loaded. A running client may need its next supported native configuration load. No forced resume, controller attachment, turn cancellation or application restart is used to inject context. |

Dormant threads get metadata resumes immediately when present in the permitted
catalog. Richer descriptions refresh during their normal work; installation does
not launch every historical thread to summarize it. Ambiguous Codex lifecycle IDs
receive only public discovery guidance until source-bound native metadata can
identify the exact thread. The hook never guesses an identity from a transcript
path or borrows another participant's credentials.

## Agent workflow

1. Call `ensure_native_connection` in this exact native thread.
2. Call `read_thread_resume` with your own `sessionId` to get `latestEntryId`.
3. Call `update_thread_resume` with a concise description and a stable `deliveryId`.
   For an existing record, pass its exact `latestEntryId` as `previousEntryId`.
4. Call `discover_relevant_agents` with the task you are starting. Inspect a match
   using `read_thread_resume`, and use `message_agent_thread` only when useful.
5. Update the resume when the focus changes and at handoff. Include what is finished,
   what remains, useful expertise and evidence the caller is allowed to share.

A fictional first update:

```json
{
  "summary": "I maintain event ingestion and investigate duplicate delivery.",
  "focus": "Qualify the retry fix and publish regression evidence.",
  "skills": ["stream processing", "Kafka", "failure recovery"],
  "topics": ["event ingestion", "retry handling"],
  "canHelpWith": ["Diagnosing duplicate events and retry races"],
  "evidence": [{"label": "Regression report", "reference": "shared-report-id"}],
  "deliveryId": "resume-ingestion-first-001"
}
```

Only the bound source can update or withdraw its resume. Caller-supplied peer IDs
are rejected. Concurrent edits use compare-and-set; reread after a version conflict.
Retries with the same delivery ID and identical body return the original receipt;
reusing that ID with different content fails. Identity and current access are checked
again, including duplicate receipts. `withdraw_thread_resume` requires the latest
entry ID. A withdrawal never revives an older description.

Source-specific participant CLI equivalents are `resumes`, `resume-read`,
`resume-update`, `resume-withdraw` and `relevant`. Use that source's current private
`USE.md` for the exact launcher and configuration. Update/withdraw commands take
strict JSON on stdin; `relevant --query "retry handling" --limit 5` is read-only.
Offline `--help` publishes each schema. Never copy a peer's connection file.

The owner work board includes **Thread resumes: find an agent** with current focus,
expertise, evidence, freshness and native availability. It does not edit a resume on
another thread's behalf. Existing `discover_permitted_work` searches resume text as
well as native metadata when the caller has resume-content access.

## Storage, privacy and freshness

Source-authored versions are signed findings in the existing companion-owned
AgentSpaces work-board replica, `work-board/replica.cbor`. They include an upstream
`agentCard`, source identity, version, previous entry and timestamps. This is not a
second registry, an external advertisement or an export of native history.

Descriptions are fresh for seven days and labelled stale afterward. Their active
30-day lease then expires to the metadata fallback; old versions do not reappear.
Expiration is an access/projection boundary, not secure deletion: signed snapshot
bytes and effect receipts remain until explicit maintenance. Metadata profiles are
labelled unreviewed. Native availability comes only from a recent supported native
observation, independently of profile freshness; otherwise it is unknown. Reported
skills, branches and results are not independently verified by this feature.

Every read rechecks account, active workspace scope, enrollment, content/retrieval/
sharing grants and explicit source refusals. Revoked or foreign sources disappear
from matches. The caller cannot gain transcript access or execution authority by
writing a profile. Public source and tests contain only generic capabilities and
fictional examples; real profiles and machine configuration stay in private state.
Do not put secrets, personal configuration, raw prompts or hidden reasoning in a
resume. Evidence references are displayed as data, never executed.

Search examines at most 10,000 catalog rows before limiting displayed matches,
excludes the caller for relevant-agent results, and reports truncation and coverage.
The native catalog itself can be incomplete. A result count is not a count of running
models or every account's historical conversations.

## Matching today and binary semantic search

Current ranking combines exact token overlap with the upstream AgentSpaces
`HashingEmbedder` and cosine similarity. It is deterministic local feature hashing,
not a trained semantic model. A candidate needs an overlapping query token; pure
synonyms can be missed. Matches expose their reasons. There is no embedding API,
paid inference, raw-history comparison or automatic peer wake.

The proposed binary idea has a practical research path: first encode meaning using
a trained embedding model, then quantize the vector into bits, compare Hamming
distances, and optionally rerank a small candidate set with higher-precision vectors.
[Sentence Transformers documents binary quantization and rescoring](https://sbert.net/examples/sentence_transformer/applications/embedding-quantization/README.html).
Raw UTF-8 conversation bytes and ordinary cryptographic hashes do not preserve
semantic similarity. An embedding or binary signature is derived private data,
not encryption or anonymization.

A future opt-in experiment should embed bounded resume fields first, preserve the
same grants and provenance, and compare against today's lexical baseline using
owner-labelled relevant/irrelevant thread pairs. Measure synonym recall, false
matches, precision at five, latency, memory and stale/revoked-source exclusion.
Only extend to explicit permitted history segments after separate authority and
privacy design. Learned embeddings, binary indexes and transcript ingestion are
not implemented by the resume feature.

Native context behavior follows the [Codex hooks guide](https://learn.chatgpt.com/docs/hooks)
and [Claude hooks reference](https://code.claude.com/docs/en/hooks). Native trust,
client version support and actual model compliance remain separate from fixture
verification of context delivery.
