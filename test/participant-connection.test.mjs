import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { ParticipantConnections } from "../app/participant-connection.mjs";

function fixture(t, { host = "local", installRemote, tunnelFactory, verifyLocal } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agentspaces-participant-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = { id: "participant-source", nativeThreadId: "00000000-0000-4000-8000-000000000001", provider: "claude", host, account: "own", project: "own-project", status: "current", fixture: false };
  const grant = { enrolled: true, retrieve: true, share: true }, store = { data: { connectors: {} }, save() {} };
  let issued = 0; const tokens = [], installs = [], tunnels = [], local = [];
  const engine = { store, session: () => source, permissions: () => grant, issueConnector() {
    const token = createHash("sha256").update("synthetic-app-capability-" + ++issued).digest("hex"); tokens.push(token); store.data.connectors[createHash("sha256").update(token).digest("hex")] = { sessionId: source.id, account: source.account }; return { token };
  }, connector(token) {
    const binding = store.data.connectors[createHash("sha256").update(token).digest("hex")]; if (!binding || !grant.enrolled || !grant.retrieve || !grant.share) throw new Error("Revoked"); return binding;
  }, nativeFactory: () => { throw new Error("No native resume or model permitted"); } };
  const service = new ParticipantConnections(engine, { root, address: "http://127.0.0.1:43127",
    verifyLocal: verifyLocal ?? (async args => { local.push(args); return "verified-http-200"; }),
    installRemote: installRemote ?? (async payload => { installs.push(payload); return { configPath: "/home/owner/.agentspaces-desktop-native/connections/" + payload.connectionId + "/participant.json", cliPath: "/home/owner/.agentspaces-desktop-native/participant-runtime/participant-cli.mjs", transportStatus: "verified-http-200" }; }),
    tunnelFactory: tunnelFactory ?? (async options => { const handle = { child: new EventEmitter(), options, closes: 0, close() { this.closes++; this.child.emit("close"); } }; tunnels.push(handle); return handle; }),
  });
  t.after(() => service.close());
  return { engine, service, root, source, grant, store, tokens, installs, tunnels, local, issued: () => issued };
}
test("active native source prepares a private scoped CLI config without resume, model or public credentials", async t => {
  const f = fixture(t); const result = await f.service.prepare({ sessionId: f.source.id });
  const config = JSON.parse(readFileSync(result.configPath, "utf8"));
  assert.equal(config.schema, 1); assert.equal(config.nativeThreadId, f.source.nativeThreadId); assert.equal(config.sessionId, f.source.id);
  assert.equal(config.authority, "127.0.0.1:43127"); assert.equal(config.address, "http://127.0.0.1:43127");
  assert.deepEqual(Object.keys(config).sort(), ["address", "authority", "host", "nativeThreadId", "provider", "schema", "sessionId", "token"]);
  assert.equal(config.token, f.tokens[0]); assert.ok(!JSON.stringify(result).includes(config.token));
  assert.deepEqual(result.usageCommand.slice(-3), ["--source", f.source.nativeThreadId, "discover"]); assert.equal(f.local.length, 1); assert.equal(f.tunnels.length, 0);
});
test("fixture, unknown identity, unsupported host and revoked grants refuse before capability allocation", async t => {
  const f = fixture(t); f.source.fixture = true; await assert.rejects(f.service.prepare({ sessionId: f.source.id }));
  f.source.fixture = false; f.source.nativeThreadId = "unknown"; await assert.rejects(f.service.prepare({ sessionId: f.source.id }));
  f.source.nativeThreadId = "00000000-0000-4000-8000-000000000001"; f.source.host = "other-machine"; await assert.rejects(f.service.prepare({ sessionId: f.source.id }));
  f.source.host = "local"; f.grant.share = false; await assert.rejects(f.service.prepare({ sessionId: f.source.id }));
  assert.equal(f.issued(), 0); assert.equal(f.local.length, 0);
});
test("local linked parent is refused before issuing a capability or writing outside state", async t => {
  const f = fixture(t); const target = join(f.root, "other"); mkdirSync(target);
  symlinkSync(target, join(f.root, "native-connections"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.service.prepare({ sessionId: f.source.id }), /unlinked/);
  assert.equal(f.issued(), 0); assert.deepEqual(readdirSync(target), []);
});
test("remote participants share one owned tunnel while retaining separate scoped capabilities", async t => {
  const f = fixture(t, { host: "remote" });
  const first = await f.service.prepare({ sessionId: f.source.id }); const second = await f.service.prepare({ sessionId: f.source.id });
  assert.equal(f.tunnels.length, 1); assert.equal(f.installs.length, 2); assert.notEqual(f.tokens[0], f.tokens[1]);
  const config = f.installs[0].config;
  assert.match(config.address, /^http:\/\/127\.0\.0\.1:\d+$/); assert.equal(config.authority, "127.0.0.1:43127");
  assert.notEqual(new URL(config.address).port, "43127"); assert.equal(f.tunnels[0].options.localPort, 43127);
  assert.ok(!JSON.stringify([first, second]).includes(f.tokens[0])); assert.ok(f.installs[0].source.includes("runParticipantCli"));
  f.service.close(); assert.equal(f.tunnels[0].closes, 1);
});
test("concurrent participant preparations allocate only one pending reverse tunnel", async t => {
  let release, created = 0; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { host: "remote", tunnelFactory: async () => { created++; await gate; return { child: new EventEmitter(), close() {} }; } });
  const first = f.service.prepare({ sessionId: f.source.id }), second = f.service.prepare({ sessionId: f.source.id });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(created, 1); release();
  await Promise.all([first, second]); assert.equal(f.service.tunnels.size, 1);
});
test("failed remote copy revokes new capability and closes an unused owned tunnel", async t => {
  const f = fixture(t, { host: "remote", installRemote: async () => { throw new Error("PRIVATE TOKEN DIAGNOSTIC"); } });
  await assert.rejects(f.service.prepare({ sessionId: f.source.id }), error => !error.message.includes("PRIVATE") && /revoked/.test(error.message));
  assert.equal(Object.keys(f.store.data.connectors).length, 0); assert.equal(f.tunnels[0].closes, 1); assert.equal(f.service.tunnels.size, 0);
});
test("post-install grant changes or transport exit fail verification and revoke the new capability", async t => {
  const f = fixture(t, { host: "remote" });
  const install = f.service.installRemote;
  f.service.installRemote = async payload => { const result = await install(payload); f.grant.retrieve = false; return result; };
  await assert.rejects(f.service.prepare({ sessionId: f.source.id })); assert.equal(Object.keys(f.store.data.connectors).length, 0);
  const g = fixture(t, { host: "remote" }); const original = g.service.installRemote;
  g.service.installRemote = async payload => { const result = await original(payload); g.tunnels[0].child.emit("close"); return result; };
  await assert.rejects(g.service.prepare({ sessionId: g.source.id })); assert.equal(Object.keys(g.store.data.connectors).length, 0);
});
test("local discovery verification failure revokes capability and never becomes a ready connection", async t => {
  const f = fixture(t, { verifyLocal: async () => { throw new Error("Unavailable"); } });
  await assert.rejects(f.service.prepare({ sessionId: f.source.id })); assert.equal(Object.keys(f.store.data.connectors).length, 0);
  f.service.close(); await assert.rejects(f.service.prepare({ sessionId: f.source.id }), /closed/);
});
test("successful remote preparation persists transport metadata only and restart restores exact port without reenrollment", async t => {
  const f = fixture(t, { host: "remote" }); await f.service.prepare({ sessionId: f.source.id });
  const record = structuredClone(f.store.data.participantBridge), count = f.issued(), connectors = structuredClone(f.store.data.connectors);
  assert.deepEqual(Object.keys(record).sort(), ["authority", "host", "remotePort"]);
  assert.equal(record.remotePort, f.tunnels[0].options.remotePort); assert.equal(record.authority, "127.0.0.1:43127");
  f.service.close(); assert.deepEqual(f.store.data.participantBridge, record);
  const restored = [];
  const manager = new ParticipantConnections(f.engine, { root: f.root, address: "http://127.0.0.1:43127", tunnelFactory: async options => { const handle = { options, child: new EventEmitter(), closed: false, close() { this.closed = true; } }; restored.push(handle); return handle; } });
  t.after(() => manager.close()); await manager.restorePromise;
  assert.equal(restored.length, 1); assert.equal(restored[0].options.remotePort, record.remotePort);
  assert.equal(f.issued(), count); assert.deepEqual(f.store.data.connectors, connectors); assert.equal(manager.bridgeRestore.status, "owned-tunnel-started");
  manager.close(); assert.equal(restored[0].closed, true); assert.deepEqual(f.store.data.participantBridge, record);
});
test("malformed or changed-authority bridge records never spawn a restored tunnel", async t => {
  for (const record of [{ host: "other", remotePort: 45000, authority: "127.0.0.1:43127" }, { host: "remote", remotePort: "45000", authority: "127.0.0.1:43127" }, { host: "remote", remotePort: 45000, authority: "127.0.0.1:9999" }, { host: "remote", remotePort: 45000, authority: "127.0.0.1:43127", token: "forbidden-extra" }]) {
    const f = fixture(t); f.store.data.participantBridge = record; let starts = 0;
    const manager = new ParticipantConnections(f.engine, { root: f.root, address: "http://127.0.0.1:43127", tunnelFactory: async () => { starts++; throw new Error("Must not spawn"); } });
    await manager.restorePromise; assert.equal(starts, 0); assert.equal(manager.bridgeRestore.status, "ignored-invalid-record"); assert.equal(f.issued(), 0); manager.close();
  }
});
test("failed bridge restore is generic and explicit prepare retries the recorded port without a loop", async t => {
  const f = fixture(t, { host: "remote" }); const record = { host: "remote", remotePort: 45678, authority: "127.0.0.1:43127" }; f.store.data.participantBridge = record;
  let attempts = 0;
  const manager = new ParticipantConnections(f.engine, { root: f.root, address: "http://127.0.0.1:43127", installRemote: f.service.installRemote,
    tunnelFactory: async options => { attempts++; assert.equal(options.remotePort, 45678); if (attempts === 1) throw new Error("PRIVATE diagnostic"); return { child: new EventEmitter(), close() {} }; } });
  t.after(() => manager.close()); await manager.restorePromise;
  assert.equal(manager.bridgeRestore.status, "unavailable"); assert.ok(!JSON.stringify(manager.bridgeRestore).includes("PRIVATE")); assert.equal(attempts, 1); assert.equal(f.issued(), 0);
  await manager.prepare({ sessionId: f.source.id }); assert.equal(attempts, 2); assert.deepEqual(f.store.data.participantBridge, record); assert.equal(manager.bridgeRestore.status, "verified-http-200");
});
