import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { Engine } from "../app/engine.mjs";
import { Store } from "../app/store.mjs";
import { CodexReadAdapter } from "../app/native.mjs";
import { NativeThreadCreation } from "../app/native-thread-creation.mjs";

const callerId = "00000000-0000-4000-8000-000000000001";
const nativeId = "00000000-0000-4000-8000-000000000002";
const otherId = "00000000-0000-4000-8000-000000000003";
const input = { title: "W8 capability matrix", deliveryId: "create-work-thread-001" };
function fixture(t, { provider = "claude", host = "remote", handler, open, registerSource } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agentspaces-thread-creation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const engine = new Engine(new Store(root), { diagnostics: () => ({ status: "disconnected" }) });
  engine.workspace.index = { schema: 1, fixture: false,
    profile: { id: "owner-scope", active: true, account: "owner", hosts: ["local", "remote"], providers: ["codex", "claude"], policy: "local-retrieval", roots: {}, exclusions: {} },
    nodes: [], edges: [], sessions: [] };
  const source = { id: provider + "@" + host + ":" + callerId, nativeThreadId: callerId, host, provider,
    cwd: host === "remote" ? "/home/owner/work" : process.cwd(), account: "owner", scopeId: "owner-scope", fixture: false,
    status: "current", title: "Calling native thread", sourceVersion: "1" };
  engine.workspace.restore([source]); engine.workspace.index.sessions.push(source);
  engine.tools = ["local", "remote"].map(host => ({ host, provider: "codex", installed: true, adapterCompatible: true }));
  const calls = [], lifecycle = { opens: 0, closes: 0, factories: 0 }, registrations = [];
  const request = async (method, params) => {
    calls.push({ method, params });
    if (handler) return handler(method, params);
    return method === "thread/start" ? { thread: { id: nativeId, cwd: params.cwd } } : {};
  };
  const adapterFactory = context => {
    lifecycle.factories++;
    return { async open() { lifecycle.opens++; if (open) await open(context); },
      close() { lifecycle.closes++; }, request,
      createEmptyThread(cwd) { return request("thread/start", { cwd, ephemeral: false }); },
      setThreadName(threadId, name) { return request("thread/name/set", { threadId, name }); } };
  };
  const service = new NativeThreadCreation(engine, { adapterFactory, registerSource: async identity => {
    registrations.push(identity);
    if (registerSource) return registerSource(identity);
    return { sessionId: "codex@" + identity.host + ":" + identity.nativeThreadId, token: "private-connector", config: { token: "private-connector" } };
  } });
  const binding = { sessionId: source.id, account: source.account, project: source.project, scopeId: source.scopeId };
  return { root, engine, service, source, binding, calls, lifecycle, registrations, adapterFactory };
}

test("empty Codex creation inherits native defaults and links the source without a turn or credential exposure", async t => {
  const f = fixture(t);
  const result = await f.service.create(input, f.binding);
  assert.equal(result.nativeThreadId, nativeId); assert.equal(result.sessionId, "codex@remote:" + nativeId);
  assert.equal(result.naming, "named"); assert.equal(result.registration, "registered");
  assert.equal(result.modelCalls, 0); assert.equal(result.turnStarted, false);
  assert.deepEqual(f.calls, [{ method: "thread/start", params: { cwd: f.source.cwd, ephemeral: false } },
    { method: "thread/name/set", params: { threadId: nativeId, name: input.title } }]);
  assert.deepEqual(f.registrations, [{ nativeThreadId: nativeId, host: "remote", provider: "codex", cwd: f.source.cwd, title: input.title }]);
  assert.ok(!JSON.stringify(result).includes("private-connector"));
  assert.equal(f.lifecycle.closes, 1);
});

test("creation receipt is persisted before mutation and native identity before naming", async t => {
  const f = fixture(t, { handler(method, params) {
    const receipt = Object.values(JSON.parse(readFileSync(f.engine.store.path, "utf8")).nativeThreadCreationReceipts)[0];
    if (method === "thread/start") {
      assert.equal(receipt.state, "dispatching"); assert.equal(receipt.nativeThreadId, undefined);
      return { thread: { id: nativeId, cwd: params.cwd } };
    }
    assert.equal(receipt.state, "created"); assert.equal(receipt.nativeThreadId, nativeId);
    return {};
  } });
  await f.service.create(input, f.binding);
});

test("concurrent exact duplicates create one thread and subsequent retries remain cached", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { open: () => gate });
  const first = f.service.create(input, f.binding), second = f.service.create(input, f.binding);
  release(); const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.nativeThreadId === nativeId));
  assert.equal(f.calls.filter(call => call.method === "thread/start").length, 1);
  assert.equal((await f.service.create(input, f.binding)).cached, true);
  assert.equal(f.lifecycle.factories, 1);
});

test("native creation survives a service/store restart without creating or reopening a transport", async t => {
  const f = fixture(t); await f.service.create(input, f.binding);
  const original = f.engine.store;
  f.engine.store = new Store(f.root); f.engine.discussions.store = f.engine.store;
  const restarted = new NativeThreadCreation(f.engine, { adapterFactory: () => { throw new Error("Replay forbidden"); } });
  const result = await restarted.create(input, f.binding);
  assert.equal(result.nativeThreadId, nativeId); assert.equal(result.cached, true);
  assert.notEqual(f.engine.store, original); assert.equal(f.calls.filter(call => call.method === "thread/start").length, 1);
});

test("concurrent helper instances share in-flight deduplication before native dispatch", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { open: () => gate });
  const secondService = new NativeThreadCreation(f.engine, { adapterFactory: f.adapterFactory });
  const first = f.service.create(input, f.binding), second = secondService.create(input, f.binding);
  release();
  assert.ok((await Promise.all([first, second])).every(result => result.nativeThreadId === nativeId));
  assert.equal(f.lifecycle.factories, 1); assert.equal(f.calls.filter(call => call.method === "thread/start").length, 1);
});

test("unknown native acceptance is not replayed on exact retry or after restart", async t => {
  const f = fixture(t, { handler() { throw new Error("PRIVATE native disconnect diagnostic"); } });
  await assert.rejects(f.service.create(input, f.binding), { code: "native_thread_creation_acceptance_unknown_no_retry" });
  await assert.rejects(f.service.create(input, f.binding), error => {
    assert.equal(error.code, "native_thread_creation_acceptance_unknown_no_retry");
    assert.ok(!JSON.stringify(error).includes("PRIVATE")); return true;
  });
  f.engine.store = new Store(f.root);
  const restarted = new NativeThreadCreation(f.engine, { adapterFactory: f.adapterFactory });
  await assert.rejects(restarted.create(input, f.binding), { code: "native_thread_creation_acceptance_unknown_no_retry" });
  assert.equal(f.calls.length, 1); assert.equal(f.lifecycle.closes, 1);
});

test("a dispatching receipt left by a crash cannot be replayed", async t => {
  const f = fixture(t); await f.service.create(input, f.binding);
  const receipt = Object.values(f.engine.store.data.nativeThreadCreationReceipts)[0];
  delete receipt.nativeThreadId; receipt.state = "dispatching"; f.engine.store.save();
  await assert.rejects(new NativeThreadCreation(f.engine, { adapterFactory: f.adapterFactory }).create(input, f.binding), { code: "native_thread_creation_acceptance_unknown_no_retry" });
  assert.equal(f.lifecycle.factories, 1);
});

test("native request timeout or an invalid native identity remains an unknown acceptance", async t => {
  for (const handler of [() => { throw Object.assign(new Error("native_rpc_timeout"), { code: "native_rpc_timeout" }); }, () => ({ thread: { id: "not-a-native-uuid" } })]) {
    const f = fixture(t, { handler });
    await assert.rejects(f.service.create(input, f.binding), { code: "native_thread_creation_acceptance_unknown_no_retry" });
    await assert.rejects(f.service.create(input, f.binding), { code: "native_thread_creation_acceptance_unknown_no_retry" });
    assert.equal(f.calls.length, 1); assert.equal(f.lifecycle.closes, 1);
  }
});

test("failure to persist a received ID still reports it and never recreates a thread", async t => {
  const f = fixture(t);
  const save = f.engine.store.save.bind(f.engine.store);
  f.engine.store.save = () => {
    const receipt = Object.values(f.engine.store.data.nativeThreadCreationReceipts)[0];
    if (receipt?.nativeThreadId) throw new Error("disk unavailable");
    save();
  };
  const first = await f.service.create(input, f.binding), second = await f.service.create(input, f.binding);
  assert.equal(first.nativeThreadId, nativeId); assert.equal(second.nativeThreadId, nativeId);
  assert.equal(first.metadataError, "native_thread_creation_metadata_incomplete");
  assert.equal(f.calls.length, 1); assert.equal(f.registrations.length, 0); assert.equal(f.lifecycle.closes, 1);
  f.engine.store = new Store(f.root);
  await assert.rejects(new NativeThreadCreation(f.engine, { adapterFactory: f.adapterFactory }).create(input, f.binding), { code: "native_thread_creation_acceptance_unknown_no_retry" });
  assert.equal(f.calls.length, 1);
});

test("naming or registration failure keeps the known native ID and cannot recreate it", async t => {
  const f = fixture(t, { handler(method, params) {
    if (method === "thread/start") return { thread: { id: nativeId, cwd: params.cwd } };
    throw new Error("PRIVATE naming failed");
  }, registerSource() { throw new Error("PRIVATE registration failed"); } });
  const result = await f.service.create(input, f.binding);
  assert.equal(result.nativeThreadId, nativeId); assert.equal(result.naming, "failed"); assert.equal(result.registration, "failed");
  assert.equal((await f.service.create(input, f.binding)).nativeThreadId, nativeId);
  assert.equal(f.calls.filter(call => call.method === "thread/start").length, 1);
  assert.ok(!JSON.stringify(result).includes("PRIVATE")); assert.equal(f.lifecycle.closes, 1);
});

test("incorrect returned cwd preserves known identity while blocking naming and enrollment", async t => {
  const f = fixture(t, { handler() { return { thread: { id: nativeId, cwd: "/different/private" } }; } });
  const result = await f.service.create(input, f.binding);
  assert.equal(result.nativeThreadId, nativeId); assert.equal(result.metadataError, "native_thread_creation_returned_cwd_mismatch");
  assert.equal(result.naming, "blocked"); assert.equal(result.registration, "blocked");
  assert.equal(f.calls.length, 1); assert.equal(f.registrations.length, 0);
});

test("changed payload or another source cannot take ownership of a delivery ID", async t => {
  const f = fixture(t); await f.service.create(input, f.binding);
  await assert.rejects(f.service.create({ ...input, title: "Different work" }, f.binding), { code: "native_thread_creation_delivery_id_conflict" });
  const second = { ...f.source, id: "claude@remote:" + otherId, nativeThreadId: otherId };
  f.engine.workspace.restore([second]);
  await assert.rejects(f.service.create(input, { ...f.binding, sessionId: second.id, project: second.project }), { code: "native_thread_creation_delivery_id_owned_by_another_source" });
  assert.equal(f.lifecycle.factories, 1);
});

test("source grants and connector identity are checked on every request including cached creation", async t => {
  const f = fixture(t); await f.service.create(input, f.binding);
  f.engine.store.data.grants[f.source.id] = { content: false };
  await assert.rejects(f.service.create(input, f.binding), { code: "native_thread_creation_source_denied" });
  f.engine.store.data.grants[f.source.id] = { enrolled: false };
  await assert.rejects(f.service.create(input, f.binding), /Current enrolled/);
  delete f.engine.store.data.grants[f.source.id];
  await assert.rejects(f.service.create(input, { ...f.binding, account: "another-account" }), /Current enrolled/);
  await assert.rejects(f.service.create({ ...input, sourceId: f.source.id }, f.binding), { code: "native_thread_creation_bounded_request_required" });
  assert.equal(f.lifecycle.factories, 1);
});

test("scope revocation while the transport opens prevents any native mutation and closes it", async t => {
  let revoke = true;
  const f = fixture(t, { open() { if (revoke) f.engine.store.data.grants[f.source.id] = { share: false }; } });
  await assert.rejects(f.service.create(input, f.binding), { code: "native_thread_creation_transport_or_scope_unavailable" });
  assert.equal(f.calls.length, 0); assert.equal(f.lifecycle.closes, 1);
  delete f.engine.store.data.grants[f.source.id];
  revoke = false;
  assert.equal((await f.service.create(input, f.binding)).nativeThreadId, nativeId);
});

test("scope revocation immediately after native creation cannot erase its receipt or enroll the source", async t => {
  const f = fixture(t, { handler(method, params) {
    assert.equal(method, "thread/start"); f.engine.store.data.grants[f.source.id] = { share: false };
    return { thread: { id: nativeId, cwd: params.cwd } };
  } });
  const result = await f.service.create(input, f.binding);
  assert.equal(result.nativeThreadId, nativeId); assert.equal(result.naming, "failed"); assert.equal(result.registration, "failed");
  assert.equal(f.calls.length, 1); assert.equal(f.registrations.length, 0);
  assert.equal(Object.values(new Store(f.root).data.nativeThreadCreationReceipts)[0].nativeThreadId, nativeId);
});

test("excluded paths, unsupported hosts/providers and unqualified tools never open a transport", async t => {
  const f = fixture(t);
  f.engine.workspace.index.profile.exclusions.remote = ["/excluded"];
  for (const cwd of ["/excluded", "/excluded/child", "/a/../excluded", "/patent-foundations/reports"]) {
    await assert.rejects(f.service.create({ ...input, cwd }, f.binding), { code: "native_thread_creation_target_excluded" });
  }
  for (const cwd of ["relative", "C:\\Windows", "/work\nprivate"]) await assert.rejects(f.service.create({ ...input, cwd }, f.binding), { code: "native_thread_creation_absolute_cwd_required" });
  await assert.rejects(f.service.create({ ...input, host: "other" }, f.binding), { code: "native_thread_creation_target_denied" });
  f.engine.workspace.index.profile.providers = ["claude"];
  await assert.rejects(f.service.create(input, f.binding), { code: "native_thread_creation_target_denied" });
  f.engine.workspace.index.profile.providers = ["codex", "claude"];
  f.engine.tools[1].adapterCompatible = false;
  await assert.rejects(f.service.create(input, f.binding), { code: "native_thread_creation_host_capability_unavailable" });
  assert.equal(f.lifecycle.factories, 0);
});

test("cross-host creation needs an explicit host-specific cwd and uses the granted Codex provider", async t => {
  const f = fixture(t, { host: "local" });
  await assert.rejects(f.service.create({ ...input, host: "remote" }, f.binding), { code: "native_thread_creation_cross_host_cwd_required" });
  const result = await f.service.create({ ...input, host: "remote", cwd: "/home/owner/remote-work" }, f.binding);
  assert.equal(result.host, "remote"); assert.equal(result.provider, "codex");
  assert.deepEqual(f.calls[0].params, { cwd: "/home/owner/remote-work", ephemeral: false });
});

test("local creation uses only narrow stdio creation methods while generic rpc remains read-only", async t => {
  const f = fixture(t, { provider: "codex", host: "local" });
  const calls = [], child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => child.emit("exit", 0);
  child.stdin = new Writable({ write(chunk, _encoding, next) {
    const request = JSON.parse(chunk.toString()); calls.push(request);
    if (request.id) setImmediate(() => child.stdout.write(JSON.stringify({ id: request.id,
      result: request.method === "thread/start" ? { thread: { id: nativeId, cwd: request.params.cwd } } : {} }) + "\n"));
    next();
  } });
  let adapter;
  f.service.adapterFactory = () => adapter = new CodexReadAdapter({ spawnProcess: () => child, enableThreadCreation: true });
  const result = await f.service.create(input, f.binding);
  assert.equal(result.nativeThreadId, nativeId);
  assert.deepEqual(calls.map(call => call.method), ["initialize", "initialized", "thread/start", "thread/name/set"]);
  assert.deepEqual(calls.find(call => call.method === "thread/start").params, { cwd: f.source.cwd, ephemeral: false });
  for (const method of ["thread/start", "thread/name/set", "turn/start", "thread/resume", "thread/queue/add", "command/exec"]) assert.throws(() => adapter.rpc(method, {}), /Read-only/);
  const readOnly = new CodexReadAdapter({ spawnProcess: () => { throw new Error("Do not launch"); } });
  assert.throws(() => readOnly.createEmptyThread(f.source.cwd), /not enabled/);
  assert.throws(() => readOnly.setThreadName(nativeId, "name"), /not enabled/);
});
