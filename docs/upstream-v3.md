# Upstream wire v3 integration

This guide describes the 2026-10-16 source integration. It does not claim that a
published installer or an existing companion has been upgraded.

## Exact compatibility tuple

- TypeScript binding: [`3996234b6d8323538ad806671bd55a4f76cd1e07`](https://github.com/badmonkeyai/agentspaces-typescript/tree/3996234b6d8323538ad806671bd55a4f76cd1e07).
- Java interoperability reference: [`c47758ac6c253bcb2ad31c264291bee5ed16c7cf`](https://github.com/badmonkeyai/AgentSpaces/tree/c47758ac6c253bcb2ad31c264291bee5ed16c7cf).
- Model-wire contract reference: [`8546c3c4ca3dd323d5b29a296db8b406aa13b752`](https://github.com/badmonkeyai/agentspaces-model-wire/tree/8546c3c4ca3dd323d5b29a296db8b406aa13b752).

Both selected peer implementations use wire version 3. The previous Desktop pin
`ab091a4fd9b325679ceca9dfa3d3042ff572696b` uses version 2. Their frame decoders reject
one another's versions. A v2 seed is not compatible with this client; coordinate
an upgrade of any configured seed before relying on that fabric connection.
Native SSH/channel connections and the embedded board are separate surfaces.

Runtime wire version and the manifest's exact declared binding hash are exposed in
fabric diagnostics. The declared hash is packaging provenance, not a runtime
source attestation. Upstream package version labels and some README text lag the
actual protocol; use the pinned implementations and checks.

## Health and discovery

The fabric view reports current seed-socket state, reconnect count and stale,
future, replayed, malformed and ignored frame counters. An explicit close stops
upstream reconnect. After socket loss, recovery is upstream-managed: the public
client API does not expose a definitive in-progress or exhausted signal, so the
view reports this as unknown rather than claiming recovery completed.

The adapter pulls signed advertisements after a verified group connection.
Discovery revalidates stored signature bytes, issuer, group, card identity,
issue/expiry times and known peer/agent revocations. Returned metadata is bounded.
It does not accept a mutable display cache as signature evidence.

An AgentCard identifies a fabric peer and agent capability. It does not identify a
native Codex/Claude thread, grant access to a history or establish wake readiness.
The dial-only peer can know about members it cannot address directly. A current
seed connection and cached reachable peer are reported separately from native
identity and wake access. Native recipient selection retains its exact source
bindings and grants. No local native metadata is advertised by these read paths.

## Optional fleet observations

Only the owner can establish the loopback fabric connection. Desktop currently
admits a fixture project, not a private native-content project. The owner may add
runtime-only `observationSpaces` to the existing `/api/fabric/connect` body:

```json
{
  "project": "fixture-project",
  "host": "127.0.0.1",
  "port": 7500,
  "groupId": "verified-group-id",
  "observationSpaces": {
    "usage": "fixture-usage",
    "advisory": "fixture-advisory",
    "semantic": true
  }
}
```

These are fictional example names, not a ready-made group or machine
configuration. `usage` and `advisory` name explicitly selected spaces; `semantic`
is a boolean enabling local card ranking. All three are optional and disabled by
default. Unknown options are rejected. Disconnecting or restarting discards the
options; reconnecting requires opting in again.

`/api/fabric/observations` returns health, signed discovery and the enabled
observations. It accepts `query` (up to 500 characters) and `limit` (1–100, default 100). Responses are bounded to 512 KiB with explicit truncation. MCP exposes `read_fabric_observations`; the participant CLI exposes `fabric-observations --query TEXT --limit N`, with offline `--help`. The Usage page has a separate refreshable Fleet observations panel. Owner access or an enrolled,
retrieval-enabled participant of the exact connected fixture project is required.
A participant cannot use this read path to connect another seed or select new
spaces. Missing, expired, disconnected and unobserved publishers are explicit
coverage limits.

| Observation | Meaning | Boundary |
| --- | --- | --- |
| Usage | Live signed `ModelUsageTotal#v1` records in the owning `ai.badmonkey.agentspaces.springai.model.wire` namespace | Issuer checked against signed identity; current reset epoch and monotone counters selected. Different windows, ambiguity or truncated coverage suppress a combined value. No billing, weekly quota or combined native total. |
| Advisory | Signed upstream proposals and ballots, with peer-level tallying | Not human approval, native permission or a machine reservation. Incomplete observations and duplicate proposals cannot establish a qualified winner. |
| Semantic | Upstream hashing/cosine ranking over locally verified AgentCards | Query stays local; no embedding/model service, provider calls, native execution or recipient substitution. |

Active aggregation exchange is not enabled. These views never create model work,
cast votes, request human approval on a peer's behalf, export private source
metadata or bypass the fair machine queue and actual host locks.

## Work-board activity

The shared board still stores one companion-owned signed AgentSpaces replica.
Source-bound agent tools, HTTP/MCP and SSH access this same board. New activity
uses upstream `Space.watch` to observe written, taken, completed, expired and
reappeared entries. It retains at most 100 observations for the current process.
Restarted state is a silent baseline; it does not manufacture new work or replay
native effects. Intermediate transitions between observations may be absent.

The authoritative board projection uses verified effective leases. The pinned
upstream event sweep can use an original write lease after renewal; Desktop filters
false expiry events but may omit the later effective expiry. Treat the activity
feed as an observation aid, not an audit ledger or scheduler. The upstream Space
API lacks dispatcher disposal: subscriptions and callbacks close, while its
unref'd sweep timer remains inert. Desktop reuses one observer per open board
instead of allocating a watcher on each read.

## Migration and verification

Before applying an update, run the existing private-copy update preflight against
the same saved workspace. Retain source rollback material outside the state root.
Do not replace current work records with an older snapshot after new work has
arrived. An incompatible or failed preflight blocks the update. Preserve pending
and uncertain delivery receipts; a transport restart is not permission to replay
an effect.

The repository includes synthetic v2 signed-state fixtures covering active claims,
renewed leases, completed work, revoked history and receipts, plus tampered-state
rejection and mixed-version frame refusal. Those fixtures establish bounded schema
compatibility; they do not qualify every production state or a live rolling
multi-peer migration.

The opt-in `scripts/fabric-v3-proof.mjs` uses the existing `test/java/LoopbackSeed.java`
and a separately built upstream Java classpath. Set `AGENTSPACES_TEST_JAVA` and
`AGENTSPACES_TEST_CLASSPATH` locally, then run the script. Java 21 loopback checks
at the pinned tuple exercised signed entries, signed AgentCard discovery, leased
claim/completion and stable participant identity after reconnect. Socket recovery
and final owner close are separately covered by fixture tests. No provider model,
private native history or production configuration is needed for these proofs.

Keep platform CI, packaging, private-copy preflight and deployment acceptance
separate. No unattended upgrade or native-turn cancellation is introduced.

## Adopting an external service or federation later

These are prerequisites for future work, not capabilities delivered by this change:

1. Choose an explicit topology and owning seed/group policy. Identify which
   companion owns each space and qualify reachability; a dial-only connection is
   not a relay to every discovered peer.
2. Grant only the intended identities, spaces and content. Define retention,
   revocation and artifact access; do not enroll private rooms or histories by
   default.
3. Pin the complete peer tuple, test version refusal and coordinate upgrades.
   Exercise partitions, reconnect, concurrent claims and duplicate-effect fencing.
4. If a native thread must receive work, retain an exact authenticated native
   source binding, supported wake route and native permission checks. A matching
   generic fleet worker is insufficient proof of exact-thread delivery.
5. Connect a separately managed JVM/Python/Clojure worker only for an explicit
   service requirement, with budgets and effect limits. Desktop does not bundle
   Spring AI, LangChain4j, Micronaut or Groovy runtimes.
6. Qualify fleet-wide coordination before enabling it. Ordered take/reduce,
   fleet-wide leased/ordered joins and sealed-space decryption are not supplied
   by the selected TypeScript integration. Keep actual machine locks and owner
   decision authentication independent of advisory capability results.
