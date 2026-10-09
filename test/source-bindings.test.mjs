import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { SourceBindings } from "../app/source-bindings.mjs";
import { Engine } from "../app/engine.mjs";
import { Store } from "../app/store.mjs";

const thread = "00000000-0000-4000-8000-000000000001", nativeSessionId = "00000000-0000-4000-8000-000000000002";
function fixture(t, { known = true, resolveMetadata = async () => null } = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "agentspaces-bindings-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const engine = new Engine(new Store(root), { diagnostics: () => ({ status: "disconnected" }) }, { nativeFactory: () => { throw new Error("No native/model call allowed"); } });
  engine.workspace.index = { schema: 1, fixture: false, profile: { id: "owned-scope", active: true, account: "owner-boundary", hosts: ["local", "remote"], providers: ["codex", "claude"], policy: "local-retrieval", indexFiles: true, roots: {}, exclusions: {} }, nodes: [{ id: "host:remote", kind: "host", host: "remote" }], edges: [], sessions: [] };
  const source = { id: "claude@remote:" + thread, nativeThreadId: thread, host: "remote", provider: "claude", cwd: "/home/owner/work", account: "owner-boundary", scopeId: "owned-scope", fixture: false, status: "current", title: "Native metadata", sourceVersion: "1" };
  if (known) { engine.workspace.restore([source]); engine.workspace.index.sessions.push(source); }
  const service = new SourceBindings(engine, { root, address: "http://127.0.0.1:43127", resolveMetadata });
  const issued = service.issueDevice({ host: "remote", provider: "claude" });
  return { root, engine, service, source, device: issued };
}
test("registration device is host/provider-bound and cannot authenticate as any content connector", t => {
  const f = fixture(t); const device = f.service.device(f.device.token);
  assert.equal(device.role, "native-registration-only"); assert.equal(device.host, "remote"); assert.equal(device.provider, "claude");
  assert.ok(!JSON.stringify(f.engine.store.data.nativeRegistrationDevices).includes(f.device.token));
  assert.throws(() => f.engine.connector(f.device.token), /denied/);
  assert.throws(() => f.service.issueDevice({ host: "other", provider: "claude" }));
  f.engine.workspace.index.profile.active = false;
  assert.throws(() => f.service.device(f.device.token), { code: "native_registration_scope_unavailable" });
});
test("known native source creates private source-only configuration and idempotently reuses its connector", async t => {
  const f = fixture(t), input = { nativeThreadId: thread, cwd: f.source.cwd, observedProcess: 123 };
  const first = await f.service.register(f.device.token, input), second = await f.service.register(f.device.token, input);
  assert.equal(first.cached, false); assert.equal(second.cached, true); assert.equal(first.token, second.token); assert.equal(first.configPath, second.configPath);
  assert.equal(Object.keys(f.engine.store.data.connectors).length, 1);
  assert.deepEqual(JSON.parse(readFileSync(first.configPath, "utf8")), first.config);
  assert.equal(first.config.nativeThreadId, thread); assert.equal(first.config.sessionId, f.source.id);
  assert.ok(first.attribution.includes("not cryptographically verified"));
  assert.ok(!JSON.stringify(f.engine.store.data.nativeSourceBindings).includes(first.token));
  const restarted = new SourceBindings(f.engine, { root: f.root, address: "http://127.0.0.1:43127" });
  assert.equal((await restarted.register(f.device.token, input)).token, first.token);
});
test("wrong host/provider/cwd and excluded or account-mismatched sources cannot mint a connector", async t => {
  const f = fixture(t);
  await assert.rejects(f.service.register(f.device.token, { nativeThreadId: thread, host: "local" }));
  await assert.rejects(f.service.register(f.device.token, { nativeThreadId: thread, provider: "codex" }));
  await assert.rejects(f.service.register(f.device.token, { nativeThreadId: thread, cwd: "/different" }), { code: "native_registration_source_cwd_mismatch" });
  f.engine.workspace.index.profile.exclusions.remote = ["/home/owner/work"];
  await assert.rejects(f.service.register(f.device.token, { nativeThreadId: thread }), { code: "native_registration_source_excluded" });
  f.engine.workspace.index.profile.exclusions = {}; f.source.account = "another-account";
  await assert.rejects(f.service.register(f.device.token, { nativeThreadId: thread }), { code: "native_registration_source_scope_denied" });
  assert.equal(Object.keys(f.engine.store.data.connectors).length, 0);
});
test("unknown, missing or client-only observation remains pending with no source/grant promotion", async t => {
  for (const resolveMetadata of [async () => null, async () => ({ nativeThreadId: thread, cwd: "/home/owner/work", host: "remote", provider: "claude" }), async () => { throw new Error("PRIVATE provider diagnostic"); }]) {
    const f = fixture(t, { known: false, resolveMetadata });
    await assert.rejects(f.service.register(f.device.token, { nativeThreadId: thread, cwd: "/home/owner/work" }), { code: "source_pending" });
    assert.equal(f.engine.catalog.length, 0); assert.equal(f.engine.workspace.index.sessions.length, 0); assert.equal(Object.keys(f.engine.store.data.connectors).length, 0); assert.deepEqual(f.engine.store.data.grants, {});
  }
});
test("native observation adds owning derived metadata while retaining current scope and source denials", async t => {
  const observed = { nativeObserved: true, nativeThreadId: thread, cwd: "/home/owner/work", host: "remote", provider: "claude", sourceVersion: "native-revision" };
  const f = fixture(t, { known: false, resolveMetadata: async () => observed });
  const result = await f.service.register(f.device.token, { nativeThreadId: thread });
  assert.equal(f.engine.catalog.length, 1); assert.equal(f.engine.workspace.index.sessions[0].sourceVersion, "native-revision");
  assert.ok(f.engine.workspace.index.nodes.some(node => node.kind === "session" && node.nativeThreadId === thread));
  assert.equal(result.config.nativeThreadId, thread); assert.deepEqual(f.engine.store.data.grants, {}, "registration never overrides explicit grant storage");
  const g = fixture(t, { known: false, resolveMetadata: async () => observed });
  g.engine.store.data.grants["claude@remote:" + thread] = { enrolled: false };
  await assert.rejects(g.service.register(g.device.token, { nativeThreadId: thread }), { code: "native_registration_source_revoked" });
  assert.equal(g.engine.catalog.length, 0); assert.equal(Object.keys(g.engine.store.data.connectors).length, 0);
});
test("native session tree identifier is resolved explicitly and never guessed as a thread UUID", async t => {
  let request;
  const f = fixture(t, { known: false, resolveMetadata: async args => { request = args; return { nativeObserved: true, nativeThreadId: thread, nativeSessionId, host: "remote", provider: "claude", cwd: "/home/owner/work" }; } });
  const result = await f.service.register(f.device.token, { nativeSessionId });
  assert.equal(request.nativeThreadId, undefined); assert.equal(request.nativeSessionId, nativeSessionId);
  assert.equal(result.nativeThreadId, thread); assert.notEqual(result.nativeThreadId, nativeSessionId);
  const g = fixture(t, { known: false, resolveMetadata: async () => ({ nativeObserved: true, nativeThreadId: nativeSessionId, host: "remote", provider: "claude", cwd: "/home/owner/work" }) });
  await assert.rejects(g.service.register(g.device.token, { nativeSessionId }), { code: "source_pending" });
});
test("source/token revocation is honored and registration devices cannot undo it", async t => {
  const f = fixture(t), first = await f.service.register(f.device.token, { nativeThreadId: thread });
  delete f.engine.store.data.connectors[createHash("sha256").update(first.token).digest("hex")];
  await assert.rejects(f.service.register(f.device.token, { nativeThreadId: thread }), { code: "source_connector_revoked" });
  assert.equal(Object.keys(f.engine.store.data.connectors).length, 0);
  const g = fixture(t); g.engine.grant(g.source.id, { enrolled: false });
  await assert.rejects(g.service.register(g.device.token, { nativeThreadId: thread }), { code: "native_registration_source_revoked" });
});
test("scope change during resolution and linked private parents cannot authorize registration", async t => {
  const f = fixture(t, { known: false });
  f.service.resolveMetadata = async () => { f.engine.workspace.index.profile.account = "changed-owner"; return { nativeObserved: true, nativeThreadId: thread, cwd: "/home/owner/work", host: "remote", provider: "claude" }; };
  await assert.rejects(f.service.register(f.device.token, { nativeThreadId: thread }), { code: "native_registration_device_revoked" });
  assert.equal(f.engine.catalog.length, 0);
  const g = fixture(t), outside = join(g.root, "outside"); mkdirSync(outside);
  symlinkSync(outside, join(g.root, "native-connections"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(g.service.register(g.device.token, { nativeThreadId: thread }), /unlinked/); assert.equal(Object.keys(g.engine.store.data.connectors).length, 0);
});
test("changed loopback address cannot recreate a deliberately revoked source connector", async t => {
  const f = fixture(t), first = await f.service.register(f.device.token, { nativeThreadId: thread });
  delete f.engine.store.data.connectors[createHash("sha256").update(first.token).digest("hex")];
  const restarted = new SourceBindings(f.engine, { root: f.root, address: "http://127.0.0.1:43128" });
  await assert.rejects(restarted.register(f.device.token, { nativeThreadId: thread }), { code: "source_connector_revoked" });
  assert.equal(Object.keys(f.engine.store.data.connectors).length, 0);
});
test("concurrent wrong-cwd registration cannot inherit another request's scoped connector", async t => {
  let release, observations = 0; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { known: false, resolveMetadata: async () => { observations++; await gate; return { nativeObserved: true, nativeThreadId: thread, host: "remote", provider: "claude", cwd: "/home/owner/work" }; } });
  const valid = f.service.register(f.device.token, { nativeThreadId: thread, cwd: "/home/owner/work" });
  const wrong = f.service.register(f.device.token, { nativeThreadId: thread, cwd: "/different" });
  const refusal = assert.rejects(wrong, { code: "native_registration_source_cwd_mismatch" });
  release(); await valid; await refusal;
  assert.equal(observations, 2); assert.equal(Object.keys(f.engine.store.data.connectors).length, 1);
});
