import {
  Identity,
  Peer,
  cbor,
  spaceIdLocal,
  verifySignedGroupAd,
} from "@agentspaces/client";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { protectStateDirectory } from "./state-security.mjs";
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
  async connect({ host, port, groupId }) {
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
    const identity = Identity.loadOrCreate(`${this.stateRoot}/fabric-keys`);
    this.peer = new Peer(identity, groupId, this.clock);
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
      this.status = "connected";
      this.reason =
        "Verified founding document and loopback TCP connection; admission/liveness not independently acknowledged";
    } catch (e) {
      this.close();
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
      const key = Identity.agentKeys(
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
    this.status = "disconnected";
    this.agents.clear();
  }
  diagnostics() {
    return {
      status: this.status,
      reason: this.reason,
      binding: "be025e7aba72e1837e0ccb3999bb76098d012fe0",
      capabilities: {
        signedEntries: true,
        claims: "upstream LEASE_RACE",
        sealedSpaces: false,
        remoteAssetExchange: false,
        nativeExecution: false,
      },
    };
  }
}
