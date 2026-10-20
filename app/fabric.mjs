import { loadOrCreateIdentity, agentKeys } from "./agentspaces-node.mjs";
import {
  Peer,
  cbor,
  spaceIdLocal,
  verifySignedGroupAd,
  wire,
} from "@agentspaces/client";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { discoverFabricCards } from "./fabric-discovery.mjs";
import { protectStateDirectory } from "./state-security.mjs";
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const bindingVersion = JSON.parse(readFileSync(new URL(import.meta.resolve('@agentspaces/client/package.json')), 'utf8')).version;
const declaredBinding = /#([a-f0-9]{40})$/.exec(manifest.dependencies?.["@agentspaces/client"] ?? "")?.[1] ?? "unknown";
const counter = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function ignoredKindCounters(kinds) {
  const total = kinds instanceof Map ? kinds.size : 0;
  const entries = [];
  let inspected = 0;
  for (const [kind, count] of kinds instanceof Map ? kinds : []) {
    if (inspected++ >= 100) break;
    // Frame-kind text is remote input. Omit oversized keys instead of shortening
    // them into collisions, and bound iteration as well as the returned payload.
    if (typeof kind !== "string" || kind.length > 128) continue;
    entries.push([kind, counter(count)]);
  }
  return { ignoredKinds: Object.fromEntries(entries), ignoredKindsTotal: total,
    ignoredKindsOmitted: total - entries.length, ignoredKindsTruncated: total > entries.length };
}
export const TYPES = Object.freeze({
  finding: "agentspaces.desktop.Finding#v1",
  request: "agentspaces.desktop.FollowUpRequest#v1",
  result: "agentspaces.desktop.FollowUpResult#v1",
});
// Uses the owning binding. No local task registry, lease algorithm or scheduler.
export class FabricAdapter {
  constructor({ stateRoot, clock = Date.now } = {}) {
    this.stateRoot = stateRoot;
    this.clock = clock;
    this.peer = null;
    this.status = "disconnected";
    this.reason = "No fabric seed configured";
    this.agents = new Map();
  }
  get status() {
    if (this._status === "connected" && !this.peer?.connected()) return "disconnected";
    return this._status;
  }
  set status(value) { this._status = value; }
  async connect({ host, port, groupId, scheme = 'tcp' }) {
    if (scheme !== 'tcp')
      throw new Error('Desktop qualifies loopback TCP to an upstream gateway. DTLS/QUIC belong on the Java gateway links; they are not direct TypeScript dialers.');
    if (!["127.0.0.1", "::1"].includes(host))
      throw new Error("This alpha qualifies literal-loopback seeds only.");
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      typeof groupId !== "string" ||
      !groupId
    )
      throw new Error("Invalid seed configuration.");
    protectStateDirectory(this.stateRoot);
    this.close();
    const identity = loadOrCreateIdentity(`${this.stateRoot}/fabric-keys`);
    this.peer = new Peer(identity, groupId, this.clock);
    this.status = "connecting";
    try {
      const path = join(this.stateRoot, "founding.cbor");
      const saved = existsSync(path) ? cbor.loads(readFileSync(path)) : null;
      if (saved && verifySignedGroupAd(saved) === groupId) {
        // A verified cached founding document is the existing configured-group contract.
        // Reconnect need not bootstrap while a seed still holds the old member route.
        this.peer.founding = saved;
        await this.peer.connect(host, port);
      } else {
        await this.peer.joinByGroupId(host, port, groupId, 10000);
        const temp = path + ".tmp";
        writeFileSync(temp, cbor.dumps(this.peer.founding), { mode: 0o600 });
        renameSync(temp, path);
      }
      this.peer.pullAds();
      this.status = "connected";
      this.reason =
        "Verified founding document and loopback TCP connection; admission/liveness not independently acknowledged";
    } catch (e) {
      this.close();
      this.status = "disconnected";
      this.reason = "Seed connection or group verification failed";
      throw e;
    }
  }
  participant(sessionId) {
    if (!this.peer) throw new Error("Fabric is disconnected");
    const name = createHash("sha256")
      .update(sessionId)
      .digest("hex")
      .slice(0, 60);
    if (!this.agents.has(sessionId)) {
      const key = agentKeys(
        `${this.stateRoot}/agent-keys`,
        this.peer.identity.peerId,
        name,
      );
      this.agents.set(
        sessionId,
        this.peer.identity.renewingSubordinate(name, "PT24H", key),
      );
    }
    return this.agents.get(sessionId);
  }
  write(space, type, value, sessionId) {
    if (this.status !== "connected") throw new Error("Fabric disconnected");
    const a = this.participant(sessionId);
    return this.peer.writeEntry(space, type, value, "desktop", 600000, a);
  }
  read(space, type) {
    if (this.status !== "connected") throw new Error("Fabric disconnected");
    this.peer.pullSpace(space);
    // find() is broad by type and does not enforce space/freshness. Filter the verified derived view.
    const rows = [];
    for (const [entryId, dto] of this.peer.states) {
      const r = dto.record;
      if (
        !r ||
        r.type !== type ||
        (r.group !== undefined && r.group !== this.peer.group) ||
        dto.completed
      )
        continue;
      if (r.spaceId !== spaceIdLocal(`${this.peer.group}/${space}`)) continue;
      if (
        Number(dto.leaseValue?.expiresAtMillis ?? r.lease?.expiresAtMillis) <=
        this.clock()
      )
        continue;
      rows.push({
        entryId,
        issuer: r.issuer,
        value: cbor.loads(Buffer.from(r.payload)),
      });
    }
    return rows;
  }
  close() {
    this.peer?.close();
    this.peer = null;
    this.status = "closed";
    this.reason = "Fabric closed by the owner; automatic reconnect is stopped";
    this.agents.clear();
  }
  discovery(options = {}) {
    return discoverFabricCards(this.peer, { ...options, now: this.clock() });
  }
  diagnostics() {
    const disconnected = this.status === "disconnected" && !!this.peer;
    return {
      status: this.status,
      reason: disconnected ? "Seed socket disconnected; upstream manages bounded reconnect attempts, but exposes no in-progress/exhausted signal" : this.reason,
      binding: declaredBinding,
      bindingVersion,
      bindingSource: "package.json declared dependency pin",
      wireVersion: wire.WIRE_VERSION,
      transport: { desktop: 'loopback-tcp', gatewaySchemes: ['dtls', 'quic'],
        gatewayManagedBy: 'upstream Java PeerNode', gatewayConnected: null,
        nativeDelivery: 'separate native channel / SSH routes' },
      recovery: { managedBy: "upstream Peer", inProgress: disconnected ? null : false, reconnectWindowMillis: counter(this.peer?.reconnectWindowMs) },
      counters: {
        reconnects: counter(this.peer?.reconnects ?? 0),
        staleFrames: counter(this.peer?.frames?.stale ?? 0),
        futureFrames: counter(this.peer?.frames?.ahead ?? 0),
        replayedFrames: counter(this.peer?.frames?.replayed ?? 0),
        malformedFrames: counter(this.peer?.malformedFrames ?? 0),
        ...ignoredKindCounters(this.peer?.ignoredKinds),
      },
      capabilities: {
        signedEntries: true,
        signedDiscovery: true,
        nativeIdentityFromAgentCards: false,
        claims: "upstream LEASE_RACE",
        sealedSpaces: false,
        remoteAssetExchange: false,
        nativeExecution: false,
      },
    };
  }
}
