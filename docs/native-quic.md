# QUIC for native chats and context

The optional native carrier forwards existing native connections over the owning
AgentSpaces 0.4.0 Java QUIC transport. It carries real scoped HTTP tools, Claude
wake WebSockets, OpenSSH native daemon connections and permitted context reads.
It does not copy conversations into a fabric space or replace native identity,
source grants, work claims, scheduling, approval policy or delivery receipts.

Desktop does not start this carrier automatically. Provision it explicitly on
both devices, outside the repository, with the pinned Java runtime and a private
CA-issued channel credential for each existing gateway identity. Every connection
requires both CA attestation and the exact configured remote PeerID. Never expose
the local listeners beyond literal IPv4 loopback. Protect configuration, channel
keys and service files with owner-only permissions. The relay is headless and
independent of the native clients and companion.

## Routing

`scripts/java/NativeTransportRelay.java` is a thin byte adapter over the upstream
`QuicTransport` and `TlsTcpTransport`. It does not implement QUIC, admission to
AgentSpaces groups, a task registry or remote command execution. SSH remains the
remote command and host/user authentication layer; its encrypted bytes travel
inside QUIC. The companion still checks every existing HTTP capability and Host
header. No credential rewriting or source impersonation is performed.

The server listens on operator-selected QUIC/UDP and TLS/TCP addresses. The other
device dials QUIC first, then TLS, with reconnect after disconnect. Either side
can open streams to a **named, fixed loopback target** on its peer. Arbitrary
remote destinations or command strings are never accepted from the wire. DTLS
continues to serve appropriate upstream message traffic, but is deliberately
excluded from this ordered, reliable byte carrier.

A minimal server configuration (illustrative addresses and ports only):

```properties
mode=server
credentials.root=/absolute/owner-private/gateway
remote.peer=EXACT_OTHER_GATEWAY_PEER_ID
listen.quic=192.0.2.10:45044
listen.tls=192.0.2.10:45046
target.ssh=22
forward.agent-api=45051,companion
fallback.agent-api=127.0.0.1,45073,127.0.0.2
```

The client configuration selects `mode=client`, `seed.quic` and `seed.tls` instead
of listeners. It configures `target.companion=COMPANION_PORT` and
`forward.ssh=45052,ssh`; its fixed SSH fallback is configured with
`fallback.ssh=192.0.2.10,22`. Run with Java 21 and the pinned upstream jars:

```text
java -cp CLASSES_AND_UPSTREAM_JARS NativeTransportRelay PRIVATE_PROPERTIES_FILE
```

An exclusive `relay.lock` prevents duplicate owners. A `relay.stop` file requests
graceful carrier shutdown; it does not stop native clients. Credentials must
already exist. Health is atomically written to `relay-health.json` with transport,
active streams and byte counters. A temporarily locked Windows health file is
advisory: publishing retries on the next tick while traffic keeps flowing. A
supervisor must reject stale health. No message bodies, tokens or commands are
logged or persisted by this adapter.

`scripts/native-ssh-carrier.mjs` can be used as a supported OpenSSH `ProxyCommand`.
Its private JSON configuration contains only `relayPort`, `fallbackHost` and
`fallbackPort`. Preserve the existing SSH alias, host-key checks, user and identity
settings. Select the local relay before reading stdin; use direct SSH TCP only
when the local relay connection was never accepted. Its helper closes its own
transport if its OpenSSH parent exits; it never signals native clients. The Java
carrier also chooses
its fixed fallback before reading any local application bytes.

## Live cutover and recovery

Keep the existing SSH bridge listening. Route **new** local agent-tool connections
to the carrier while established bridge connections drain normally. On Linux an
operator may use an isolated, owner-UID-scoped loopback NAT redirect with a short
expiring port set, refreshed only while the relay is healthy. Exclude the fixed
fallback source address to prevent recursion. Expiry must restore the original
bridge if the relay or health supervisor dies. Never flush existing firewall or
conntrack state, kill SSH sessions, or steal a listening port. This routing is
private machine configuration, not a public repository default.

The native Codex SSH adapter uses Windows overlapped child-process handles so
WebSocket input can flow before EOF. An independent handshake deadline detaches
a silent observer without cancelling a native turn.

Already-loaded native tools can keep their original loopback address and Host
header. Existing native daemon proxy connections stay on their established route
until a natural reconnect or an owner-approved companion drain. If a companion
refresh is needed, use its maintenance gate, defer around unacknowledged native
submissions or embedded work, preserve durable receipts, then restart only the
companion. Do not restart Codex/Claude sessions, cancel turns or replay uncertain
deliveries. An update cannot migrate an established TCP stream into QUIC.

The carrier bounds each link to 64 streams, 16 KiB data frames, bounded receive
queues and one acknowledged frame per stream/direction. Native EOF is carried as
a half-close. Heartbeats detect broken idle links. A new connection cannot replace
an active link. QUIC/TLS selection happens before forwarding application bytes;
a broken accepted stream closes without retry. Original native delivery receipts
remain the authority for reconciling uncertain mutations. A functioning TLS
fallback remains on TLS until disconnection; it is not replaced underneath active
work merely because QUIC becomes reachable again.

Validate real, source-bound room and context reads on each route, including the
original SSH fallback, before activating new routing. Check native process/turn
continuity and saved delivery receipts. Tests must not trigger paid inference or
wake peers just to demonstrate transport. Do not publish these private proofs,
room text, source tokens, addresses or local service configurations.
