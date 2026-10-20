# AgentSpaces ecosystem reuse assessment

Reviewed 2026-10-16 against the exact upstream revisions below. Desktop owns the
companion, UI and native adapters; AgentSpaces owns identity, peering, discovery,
signed work, claims and leases. This assessment describes source integration and
bounded qualification, not an installer release or deployment.

| Repository and inspected revision | Role | Desktop disposition |
| --- | --- | --- |
| [AgentSpaces `b43a0229`](https://github.com/badmonkeyai/AgentSpaces/tree/b43a02291852cafb4b45671b1df422f707ef73e2) | Java identity, peering, discovery, replicated spaces and capabilities | Owning runtime; Java 21 loopback interoperability tested. Not bundled into Desktop. |
| [TypeScript `fa20e215`](https://github.com/badmonkeyai/agentspaces-typescript/tree/fa20e215a002a7085f9f8f526be1af6bb8b82304) | Node peer, signed entries, targeted claims, snapshots, Space events and optional capabilities | Exact dependency pin. Wire v3, health/discovery, work activity and optional observation projections integrated. |
| [Specification `bdba7424`](https://github.com/badmonkeyai/agentspaces-spec/tree/bdba742418c162c4b6456d1fe6803c2a9ccd2e04) | Owning wire and identity contracts | Contract reference; no new Desktop protocol implementation. |
| [Model-wire `8546c3c4`](https://github.com/badmonkeyai/agentspaces-model-wire/tree/8546c3c4ca3dd323d5b29a296db8b406aa13b752) | Shared conversation, model request/result and `ModelUsageTotal` records | Preserve the owning namespace; optional observed usage projection. No billing/quota authority. |
| [Spring AI `03610170`](https://github.com/badmonkeyai/agentspaces-springai/tree/036101702d10712c02aea3380d3ec91b795e6110) | JVM chat memory, model workers, fleet tools, optional capability tools and MCP export | Optional external service integration; not installed or invoked by this change. |
| [LangChain4j `94c51a77`](https://github.com/badmonkeyai/agentspaces-langchain4j/tree/94c51a770f45b62f539c35e99192318df10ad5b0) | Host-neutral fleet runtime, shared model-wire and worker integrations | Optional JVM application integration. |
| [Micronaut `f2d8bb22`](https://github.com/badmonkeyai/agentspaces-micronaut/tree/f2d8bb22565b5e1ade990004a788ada72013568e) | Framework wiring and MCP import/export around the JVM runtime | Optional bridge for a separately qualified external service. |
| [Groovy `17482c77`](https://github.com/badmonkeyai/agentspaces-groovy/tree/17482c77e1cc41f9b69b7a8b96d66605079f0821) | DSL and compile-time validation for AgentSpaces applications | Application authoring option; no Electron dependency. |
| [Python `04799e3a`](https://github.com/badmonkeyai/agentspaces-python/tree/04799e3ad3adc5e14250264c3e8b472f3999ab1a) | Python workers on the owning fabric | Optional external worker; no Python peer dependency added here. |
| [Clojure `c55fd2af`](https://github.com/badmonkeyai/agentspaces-clj/tree/c55fd2af8102ae4cd704d9bcaa5ed17e4127e7a2) | Clojure access to the Java fabric | Optional application integration; no other product altered. |
| [Performance suite `0486cfe8`](https://github.com/badmonkeyai/agentspaces-perf/tree/0486cfe87dea0c47a9b46c2088ddcd4174196dd9) | Owning JMH benchmarks | Future scale qualification; no Desktop performance claim. |
| [Partybus `e9f55a9f`](https://github.com/badmonkeyai/agentspaces-partybus/tree/e9f55a9f5cd29996b6c31982120d1228eff905bf) | Example application composition | Pattern reference, not the native chat backend. |

## How the layers apply

Identity and admission establish who signed a record. Peering transports it.
Discovery describes available capabilities. Spaces hold work, leases and results.
Capability services can propose votes, aggregate contributions or rank discovery
results. Framework integrations expose those layers to particular JVM applications.
Desktop consumes the Node binding instead of packaging every framework.

The new client changes the wire version from 2 to 3; old and new peers reject one
another's frames. Package labels alone are insufficient: the selected TypeScript
manifest still says `0.2.0`, while its runtime wire constant is 3. Both dependency
hash and runtime wire version are shown in diagnostics. See [the v3 integration
and migration guide](upstream-v3.md).

The board remains one companion-owned, persisted AgentSpaces replica. Source-bound
HTTP/MCP calls and the SSH bridge access that companion. They do not create a
federation of independent Desktop replicas. Native room delivery remains separate
from optional loopback fabric discovery and observations.

Signed AgentCards are capability descriptions, not native thread bindings or wake
permissions. Framework fleet tools can choose a matching task taker rather than
the specific agent named by a card. Exact native recipients must continue through
the supported native delivery adapters and their grants.

## Implemented and deferred reuse

Source integrates verified cached AgentCard discovery, actual seed-socket health,
upstream robustness counters, bounded work-board Space activity and optional
read-only usage/advisory/semantic observations. Observations require an explicitly
configured loopback connection for a fixture project; no private native metadata
is advertised. Semantic ranking is local hashing/cosine over verified cards and
starts no model. Advisory votes never become owner approval or machine reservations.

Active aggregate exchange, gossip-learning exchange, sealed-space decryption,
ordered take/reduce and multi-companion federation are not enabled here. Keep the
fair machine queue and actual host locks. The current TypeScript peer is dial-only:
hearing about another member does not prove a route to that member. Peer reconnect
also does not repair the separate SSH, HTTP or native-channel delivery paths.

Use a JVM connector only for a concrete external worker or service requirement.
Its admission, scopes, exact targeting, model budget and failure recovery require
separate qualification. Replicated framework chat memory does not transfer native
conversation ownership, and an MCP tool connection alone cannot wake a dormant
native thread.
