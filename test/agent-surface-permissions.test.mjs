import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Store } from "../app/store.mjs";
import { Engine } from "../app/engine.mjs";
import { startServer } from "../app/server.mjs";

const CALLER = "00000000-0000-4000-8000-000000000001", CREATED = "00000000-0000-4000-8000-000000000002";
const digest = value => createHash("sha256").update(value).digest("hex");
async function fixture(t, { projectOnly = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "as-agent-permissions-"));
  const engine = new Engine(new Store(root), { diagnostics: () => ({ status: "synthetic-disconnected" }), close() {} }, {
    nativeFactory: () => { throw new Error("External native and model operations are forbidden"); },
  });
  engine.workspace.index = {
    schema: 1, fixture: false,
    profile: { id: "synthetic-permitted-scope", account: "synthetic-owner", active: true, policy: "local-retrieval", hosts: ["local", "remote"], providers: ["codex", "claude"], indexFiles: true, roots: {}, exclusions: {} },
    nodes: [], edges: [], sessions: [], coverage: [], errors: [],
  };
  const source = {
    id: "claude@local:" + CALLER, nativeThreadId: CALLER, provider: "claude", host: "local",
    cwd: join(root, "caller-work"), account: "synthetic-owner", scopeId: projectOnly ? null : "synthetic-permitted-scope",
    fixture: false, status: "unknown", title: "Synthetic calling agent", sourceVersion: "synthetic-1", topics: [],
  };
  engine.workspace.restore([source]); engine.workspace.index.sessions.push(source);
  engine.store.data.grants[source.id] = { enrolled: true, content: true, share: true, retrieve: true };
  engine.tools = ["local", "remote"].map(host => ({ host, provider: "codex", installed: true, adapterCompatible: true }));
  const trees = ["left", "right"].map((name, index) => ({ id: "synthetic-tree-" + name, kind: "worktree", host: "local", path: join(root, "repository", name), head: (index ? "b" : "a").repeat(40), title: name }));
  engine.workspace.index.nodes.push(...trees);
  const effects = { comparisons: 0, comparisonFactories: 0, nativeFactories: 0, nativeCalls: [], metadataObservations: 0 };
  engine.workspace.adapterFactory = () => {
    effects.comparisonFactories++;
    return { compare: async (left, right) => { effects.comparisons++; return { left: left.id, right: right.id, fixture: true }; }, close() {} };
  };
  const app = await startServer({ root, port: 0, engine,
    sourceMetadataResolver: async input => { effects.metadataObservations++; return { ...input, nativeObserved: true, cwd: join(root, "created-work"), sourceVersion: "synthetic-created" }; },
    nativeThreadAdapterFactory: () => {
      effects.nativeFactories++;
      return { open: async () => {}, close() {},
        createEmptyThread: async cwd => { effects.nativeCalls.push({ method: "thread/start", cwd }); return { thread: { id: CREATED, cwd } }; },
        setThreadName: async (threadId, name) => { effects.nativeCalls.push({ method: "thread/name/set", threadId, name }); return {}; },
      };
    },
  });
  const issued = engine.issueConnector(source.id);
  const call = async (path, body = {}, token = issued.token) => {
    const response = await fetch(app.address + path, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => { await app.close(); assert.equal(engine.modelCalls, 0); assert.equal(engine.cache.size, 0); rmSync(root, { recursive: true, force: true }); });
  return { root, engine, source, app, call, trees, effects, token: issued.token };
}

const comparison = f => ({ leftId: f.trees[0].id, rightId: f.trees[1].id });
const creation = f => ({ title: "Synthetic empty work chat", cwd: join(f.root, "created-work"), deliveryId: "agent-permission-create-0001" });

test("agent comparison requires current file-content scope before opening an adapter", async t => {
  const f = await fixture(t);
  f.engine.workspace.index.profile.indexFiles = false;
  const denied = await f.call("/api/workspace/compare", comparison(f));
  assert.equal(denied.status, 400); assert.match(denied.body.error, /content scope/);
  assert.equal(f.effects.comparisonFactories, 0); assert.equal(f.effects.comparisons, 0);
  const capability = await f.call("/api/agent/capabilities");
  assert.equal(capability.status, 200);
  assert.deepEqual(capability.body.workspace, { search: true, inspect: false, compare: false });
  f.engine.workspace.index.profile.indexFiles = true;
  const allowed = await f.call("/api/workspace/compare", comparison(f));
  assert.equal(allowed.status, 200); assert.equal(f.effects.comparisonFactories, 1); assert.equal(f.effects.comparisons, 1);
  assert.equal(f.effects.nativeFactories, 0);
});

test("excluded descendants of either worktree refuse comparison before any file adapter call", async t => {
  for (const index of [0, 1]) {
    const f = await fixture(t);
    f.engine.workspace.index.profile.exclusions.local = [join(f.trees[index].path, "private")];
    const response = await f.call("/api/workspace/compare", comparison(f));
    assert.equal(response.status, 400); assert.match(response.body.error, /excluded descendants/);
    assert.equal(f.effects.comparisonFactories, 0); assert.equal(f.effects.comparisons, 0);
    assert.equal(f.effects.nativeFactories, 0);
  }
});

test("comparison exclusions respect path boundaries and reject excluded roots", async t => {
  const f = await fixture(t);
  f.engine.workspace.index.profile.exclusions.local = [f.trees[0].path + "-other/private"];
  assert.equal((await f.call("/api/workspace/compare", comparison(f))).status, 200);
  assert.equal(f.effects.comparisons, 1);
  f.engine.workspace.index.profile.exclusions.local = [f.trees[1].path];
  const denied = await f.call("/api/workspace/compare", comparison(f));
  assert.equal(denied.status, 400); assert.match(denied.body.error, /outside connected scope/);
  assert.equal(f.effects.comparisonFactories, 1); assert.equal(f.effects.comparisons, 1);
});

test("native creation retains its known ID without replacing a revoked saved registration device", async t => {
  const f = await fixture(t), device = f.app.sourceBindings.issueDevice({ host: "local", provider: "codex" });
  f.engine.store.data.nativeAutomaticInstallations["local:codex"] = { device };
  delete f.engine.store.data.nativeRegistrationDevices[digest(device.token)]; f.engine.store.save();
  const count = Object.keys(f.engine.store.data.nativeRegistrationDevices).length;
  const connectors = structuredClone(f.engine.store.data.connectors);
  const result = await f.call("/api/native/thread/create", creation(f));
  assert.equal(result.status, 200); assert.equal(result.body.nativeThreadId, CREATED);
  assert.equal(result.body.state, "created"); assert.equal(result.body.registration, "failed");
  assert.equal(result.body.sessionId, null); assert.equal(result.body.turnStarted, false);
  assert.equal(Object.keys(f.engine.store.data.nativeRegistrationDevices).length, count);
  assert.deepEqual(f.engine.store.data.connectors, connectors);
  assert.equal(f.effects.metadataObservations, 0);
  assert(!f.engine.catalog.some(source => source.nativeThreadId === CREATED));
  const retry = await f.call("/api/native/thread/create", creation(f));
  assert.equal(retry.status, 200); assert.equal(retry.body.nativeThreadId, CREATED);
  assert.equal(retry.body.registration, "failed"); assert.equal(retry.body.cached, true);
  assert.equal(f.effects.nativeCalls.filter(call => call.method === "thread/start").length, 1);
  assert.equal(Object.keys(f.engine.store.data.nativeRegistrationDevices).length, count);
  assert(!JSON.stringify(result.body).includes(device.token)); assert(!JSON.stringify(result.body).includes(f.token));
});

test("project-only connectors advertise no workspace or native creation capability", async t => {
  const f = await fixture(t, { projectOnly: true });
  const response = await f.call("/api/agent/capabilities");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.workspace, { search: false, inspect: false, compare: false });
  assert(response.body.nativeThreads.hosts.every(host => host.available === false));
  assert.equal((await f.call("/api/workspace/compare", comparison(f))).status, 400);
  assert.equal((await f.call("/api/native/thread/create", creation(f))).status, 400);
  assert.equal(f.effects.comparisonFactories, 0); assert.equal(f.effects.nativeFactories, 0);
  f.engine.workspace.index.profile.active = false;
  const revokedProfile = await f.call("/api/agent/capabilities");
  assert.equal(revokedProfile.status, 200);
  assert.deepEqual(revokedProfile.body.workspace, { search: false, inspect: false, compare: false });
  assert(revokedProfile.body.nativeThreads.hosts.every(host => host.available === false));
});

test("native creation availability reflects content, provider, policy and installed compatibility", async t => {
  for (const deny of [
    f => { f.engine.store.data.grants[f.source.id].content = false; },
    f => { f.engine.workspace.index.profile.providers = ["claude"]; },
    f => { f.engine.workspace.index.profile.policy = "metadata"; },
    f => { for (const tool of f.engine.tools) tool.installed = false; },
    f => { for (const tool of f.engine.tools) tool.adapterCompatible = false; },
  ]) {
    const f = await fixture(t);
    const permitted = await f.call("/api/agent/capabilities");
    assert.equal(permitted.status, 200); assert(permitted.body.nativeThreads.hosts.every(host => host.available === true));
    deny(f);
    const response = await f.call("/api/agent/capabilities");
    assert.equal(response.status, 200); assert(response.body.nativeThreads.hosts.every(host => host.available === false));
    assert.equal((await f.call("/api/native/thread/create", creation(f))).status, 400);
    assert.equal(f.effects.nativeFactories, 0); assert.equal(f.effects.nativeCalls.length, 0);
  }
});

test('work board exposes headless lifecycle only to current sharing sources', async t => {
  const f = await fixture(t);
  const create = { action: 'create', deliveryId: 'http-board-create-0001', title: 'Synthetic work', brief: 'Test scoped work lifecycle', repository: 'https://example.invalid/synthetic', base: 'a'.repeat(40), allowedFiles: 'src/fixture.js' };
  const made = await f.call('/api/work-board/change', create);
  assert.equal(made.status, 200);
  const list = await f.call('/api/work-board/list');
  assert.equal(list.status, 200); assert.equal(list.body.items[0].entryId, made.body.entryId);
  assert.equal(list.body.items[0].value.createdBy, f.source.id);
  const claim = await f.call('/api/work-board/change', { action: 'claim', entryId: made.body.entryId, deliveryId: 'http-board-claim-0001' });
  assert.equal(claim.status, 200);
  const complete = await f.call('/api/work-board/change', { action: 'complete', entryId: made.body.entryId, deliveryId: 'http-board-finish-0001', summary: 'Synthetic checks passed', branch: 'test/synthetic', head: 'b'.repeat(40), evidence: 'HTTP fixture; no native execution' });
  assert.equal(complete.status, 200);
  f.engine.store.data.grants[f.source.id].share = false;
  assert.equal((await f.call('/api/work-board/list')).status, 400);
  assert.equal((await f.call('/api/work-board/change', create)).status, 400);
  assert.equal(f.effects.nativeFactories, 0);
});

test('coordination HTTP surfaces deny agent owner powers and revoked reads',async t=>{
 const f=await fixture(t);
 const create={action:'decision_create',deliveryId:'http-decision-0001',title:'Choose',question:'Which?',options:[{id:'a',label:'A'},{id:'b',label:'B'}],recommendation:'a'};
 const made=await f.call('/api/decisions/change',create);assert.equal(made.status,200);
 assert.equal((await f.call('/api/decisions/list')).body.items.length,1);
 assert.equal((await f.call('/api/decisions/change',{action:'decision_answer',deliveryId:'http-answer-0001',entryId:made.body.entryId,optionId:'a',rationale:'Forged owner answer'})).status,400);
 assert.equal((await f.call('/api/machines/change',{action:'machine_create',deliveryId:'http-machine-0001',name:'Synthetic',host:'remote',lockPaths:['/tmp/synthetic-lock']})).status,400);
 assert.equal((await f.call('/api/machines/list')).status,200);
 f.engine.store.data.grants[f.source.id].share=false;
 assert.equal((await f.call('/api/decisions/list')).status,400);assert.equal((await f.call('/api/machines/list')).status,400);
 assert.equal((await f.call('/api/decisions/change',create)).status,400);
 assert.equal(f.effects.nativeFactories,0);
});
