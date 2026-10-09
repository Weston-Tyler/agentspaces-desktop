import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../app/store.mjs";
import { Engine } from "../app/engine.mjs";
import { FabricAdapter } from "../app/fabric.mjs";
import { startServer } from "../app/server.mjs";

function make() {
  const root = mkdtempSync(join(tmpdir(), "as-desktop-startup-"));
  const engine = new Engine(new Store(root), new FabricAdapter({ stateRoot: root }));
  engine.probe = async () => { throw new Error("Unexpected real native probe in injected startup test"); };
  const terminals = { closeAll() {}, list: () => [] };
  return { root, engine, terminals };
}
function scope(engine, active = true) {
  engine.workspace.index = {
    schema: 1, fixture: false, observedAt: new Date().toISOString(),
    profile: { id: "scope-native-cache", active, hosts: ["local"], providers: ["codex", "claude"],
      account: "owner", policy: "metadata", indexFiles: false, roots: {}, exclusions: {} },
    nodes: [], edges: [], sessions: [], coverage: [], errors: [], cursors: {}, filesystemCursors: {},
  };
}
function nativeCatalog(engine) {
  engine.store.data.projects["native-project"] = { id: "native-project", account: "owner", metadataGrant: true };
  engine.catalog = [{ id: "native-thread-reference", nativeThreadId: "native-thread-uuid", provider: "codex",
    project: "native-project", account: "owner", host: "local", cwd: process.cwd(), fixture: false,
    title: "Native work", status: "unknown" }];
}
async function owner(app) {
  const page = await fetch(app.address);
  return { Cookie: page.headers.get("set-cookie").split(";")[0], Origin: app.address,
    "X-AgentSpaces": "local-companion", "Content-Type": "application/json" };
}

test("desktop HTTP becomes ready while the default native metadata scan is pending", async t => {
  const { root, engine, terminals } = make();
  let release, scanComplete = false;
  const pending = new Promise(yes => release = yes), calls = [];
  engine.workspace.scan = async input => { calls.push(input); await pending; scope(engine); scanComplete = true; return engine.workspace.view(); };
  let app;
  const starting = startServer({ root, engine, terminals, port: 0, desktopDiscovery: true });
  const timeout = setTimeout(() => release(), 2500);
  try {
    app = await starting; t.after(() => app.close());
    assert.equal(scanComplete, false, "The server must not await a full native scan before accepting UI requests");
    const headers = await owner(app);
    const response = await fetch(app.address + "/api/health", { headers });
    assert.equal(response.status, 200); assert.equal((await response.json()).status, "running");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].hosts, ["local"]);
    assert.deepEqual(calls[0].providers, ["codex", "claude"]);
    assert.equal(calls[0].policy, "metadata"); assert.equal(calls[0].indexFiles, false);
    assert.equal(engine.modelCalls, 0); assert.equal(engine.cache.size, 0);
    assert(app.desktopDiscovery?.promise, "Desktop startup should expose its background discovery promise");
    release(); await app.desktopDiscovery.promise; assert.equal(scanComplete, true);
    assert.equal(app.desktopDiscovery.ready, true); assert.equal(app.desktopDiscovery.status, "native-metadata-ready");
    const state = await fetch(app.address + "/api/state", { headers });
    assert.equal((await state.json()).desktopStartup.ready, true);
  } finally { clearTimeout(timeout); release(); }
});

test("production fixture reset endpoints refuse before replacing native catalog or cached scope", async t => {
  const { root, engine, terminals } = make(); scope(engine); nativeCatalog(engine);
  let scans = 0; engine.workspace.scan = async () => { scans++; throw new Error("Cached source must not scan"); };
  const app = await startServer({ root, engine, terminals, port: 0, desktopDiscovery: true });
  t.after(() => app.close()); const headers = await owner(app);
  const before = JSON.stringify({ catalog: engine.catalog, index: engine.workspace.index, projects: engine.store.data.projects });
  for (const path of ["/api/sample", "/api/workspace/sample"]) {
    const response = await fetch(app.address + path, { method: "POST", headers, body: "{}" });
    assert(response.status >= 400, "Production fixture replacement must be refused");
  }
  assert.equal(JSON.stringify({ catalog: engine.catalog, index: engine.workspace.index, projects: engine.store.data.projects }), before);
  assert.equal(scans, 0); assert.equal(engine.catalog[0].fixture, false);
  const response = await fetch(app.address + "/api/state", { headers });
  assert.equal((await response.json()).sessions[0].id, "native-thread-reference");
});

test("cached active nonfixture native discovery is reused without scanning or native probes", async t => {
  const { root, engine, terminals } = make(); scope(engine); nativeCatalog(engine);
  const index = engine.workspace.index; let scans = 0;
  engine.workspace.scan = async () => { scans++; throw new Error("No automatic cache refresh expected"); };
  const app = await startServer({ root, engine, terminals, port: 0, desktopDiscovery: true });
  t.after(() => app.close()); await app.desktopDiscovery?.promise;
  assert.equal(scans, 0); assert.equal(engine.workspace.index, index);
  assert.equal(engine.catalog[0].nativeThreadId, "native-thread-uuid"); assert.equal(engine.modelCalls, 0);
});

test("a revoked native metadata scope is preserved and never silently reenrolled on desktop startup", async t => {
  const { root, engine, terminals } = make(); scope(engine, false); nativeCatalog(engine);
  const before = JSON.stringify(engine.workspace.index); let scans = 0;
  engine.workspace.scan = async () => { scans++; throw new Error("Revoked lookup must not run"); };
  const app = await startServer({ root, engine, terminals, port: 0, desktopDiscovery: true });
  t.after(() => app.close()); await app.desktopDiscovery?.promise;
  assert.equal(scans, 0); assert.equal(engine.workspace.index.profile.active, false);
  assert.equal(JSON.stringify(engine.workspace.index), before); assert.equal(engine.modelCalls, 0);
});

test("injected test engines remain passive unless desktop discovery is explicitly enabled", async t => {
  const { root, engine, terminals } = make(); let scans = 0;
  engine.workspace.scan = async () => { scans++; throw new Error("Injected engine must remain passive"); };
  const app = await startServer({ root, engine, terminals, port: 0 }); t.after(() => app.close());
  const headers = await owner(app); assert.equal((await fetch(app.address + "/api/state", { headers })).status, 200);
  assert.equal(scans, 0); assert.equal(engine.catalog.length, 0); assert.equal(engine.modelCalls, 0);
});
