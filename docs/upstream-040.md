# AgentSpaces 0.4.0 compatibility and transports

Desktop pins the owning [TypeScript 0.4.0 client](https://github.com/badmonkeyai/agentspaces-typescript/tree/fa20e215a002a7085f9f8f526be1af6bb8b82304).
The Java interoperability reference is [AgentSpaces 0.4.0](https://github.com/badmonkeyai/AgentSpaces/tree/b43a02291852cafb4b45671b1df422f707ef73e2).
Both still use wire v3, as did Desktop's previous `3996234b` client.
Network version compatibility does not imply unchanged APIs or blanket rolling-upgrade safety.

## Desktop migration

The Node adapter imports the upstream `/node` entry, registers its TCP dialer,
uses its persistent key-store functions and selects the documented OpenSSL crypto
port. It retains existing PKCS8/public key files and agent identities. Canonical
CBOR comparisons use the upstream byte helper with `Uint8Array`. The dependency
build removes obsolete `baseUrl` from a temporary runtime-only compiler config;
it does not edit the pinned upstream source. The public lockfile resolves over
HTTPS and does not require a GitHub account or SSH key.

Existing signed snapshots, claims, renewed leases, completions, revocations and
operation receipts are verified without resigning them. Corrupt material blocks
the private-copy preflight. No migration clears delivery receipts, retries an
uncertain effect, starts a provider turn or cancels native work.

## Where DTLS and QUIC fit

| Link | Choice | Reason / qualification |
| --- | --- | --- |
| Desktop to local fabric gateway | Loopback TCP | Supported by the pinned Node dialer; fixture-project admission remains in force. |
| Native Codex/Claude thread delivery | Existing native channel / SSH | Separate protocol and source identity. Fabric UDP bindings do not replace native delivery. |
| Java gateway to Java gateway over lossy or mobile IP links | Prefer upstream QUIC when its native library is available and UDP is permitted | Encrypted transport with loss recovery, congestion control and migration. Qualify the deployed platform, trust policy and network. |
| Managed Java links requiring pure Java or lacking a supported QUIC native library | Upstream DTLS | DTLS 1.2 plus AgentSpaces' reliable, ordered recovery sublayer; no native library. Fixed window, no general congestion controller; use operator-managed links. |
| UDP blocked or unsuitable | Upstream TLS fallback | Configure and test endpoint priorities in the owning Java node. Never downgrade to plaintext Internet TCP/UDP. |

Use the upstream `PeerNode` with its `QuicTransport`, `DtlsTransport` and
`TlsTcpTransport`. Desktop does not implement another gateway service, install a
JVM, open a UDP listener or configure remote endpoints automatically. Its local
TCP seed can belong to an explicitly managed Java node whose other links use
DTLS/QUIC. Direct `dtls`/`quic` Desktop requests return a clear error before
detaching an existing connection. Diagnostics expose client version and this
boundary; they do not infer that a downstream gateway is connected.

For gateway setup, see the owning [QUIC](https://github.com/badmonkeyai/AgentSpaces/blob/b43a02291852cafb4b45671b1df422f707ef73e2/agentspaces-transport-quic/README.md)
and [DTLS](https://github.com/badmonkeyai/AgentSpaces/blob/b43a02291852cafb4b45671b1df422f707ef73e2/agentspaces-transport-dtls/README.md)
guides. Use identity-attested transports and the intended group/CA admission
policy. DTLS 1.2 exposes certificates during the handshake; prefer QUIC/TLS when
identity privacy matters. One ordered QUIC stream is currently shared by frames;
multiple streams and faster application work are not implied by selecting QUIC.

Keep endpoint addresses, identities, keys, CA material and host configuration in
private operator configuration. They are not repository examples or release assets.
No production transport switch is made by this source upgrade.

## Reproducible qualification

`npm ci`, `npm run check` and `npm test` exercise the Node API migration, persistent
identity, signed-state retention, malformed-state refusal, socket recovery,
source grants, duplicate delivery and non-cancelling update contracts.

The opt-in `scripts/fabric-transports-proof.mjs` connects two real Desktop
adapters to separate upstream Java nodes. The Java nodes communicate over DTLS,
then QUIC. The fixture refuses all outbound Java TCP to prevent a shortcut.
Each path verifies signed findings, signed discovery, an exact leased claim,
completion and stable identity after reconnect. It uses synthetic identities and
ephemeral loopback sockets; it reads no private configuration or native history
and calls no model. This is interoperability evidence, not Internet performance
or production network acceptance.

To reproduce, build the pinned Java checkout with Java 21 and Maven:

```sh
mvn -pl agentspaces-transport-dtls,agentspaces-transport-quic,agentspaces-space -am -DskipTests install
mvn -pl agentspaces-transport-dtls dependency:build-classpath -Dmdep.outputFile=target/desktop-classpath.txt
mvn -pl agentspaces-transport-quic dependency:build-classpath -Dmdep.outputFile=target/desktop-classpath.txt
```

Combine those two classpaths with the two transport modules' `target/classes`
directories and a separate fixture output directory. Compile
`test/java/LoopbackSeed.java` and `test/java/TransportSeed.java` into that directory.
Set `AGENTSPACES_TEST_JAVA` to Java 21 and `AGENTSPACES_TEST_CLASSPATH` to the
combined classpath locally, then run:

```sh
node scripts/fabric-v3-proof.mjs
node scripts/fabric-transports-proof.mjs
```

At the pinned Java revision, selected upstream DTLS recovery, transport,
hardening, CA trust and mixed-fleet fallback tests plus QUIC CA/listener tests
were also run. These cover simulated loss/duplication/reordering, bounded
unreachable-peer failure, attestation and DTLS-to-TLS fallback. They do not prove
fault tolerance on every host or qualify an unattended gateway rollout.

Run the [private-copy update preflight](maintenance.md#updates-without-cancelling-native-work)
against the actual saved workspace before installation. Stage the new client and
its locked pure-JavaScript dependencies separately; an old `node_modules` junction
alone cannot qualify this upgrade. Retain code/dependency rollback material,
leave native processes running, and release the companion update gate only at a
safe boundary. Never restore an older work snapshot over new work.
