import test from "node:test";
import assert from "node:assert/strict";
import { connectAllOwnedWork } from "../app/connect-all.mjs";

function fixture({ index = null, more = [false], handler } = {}) {
  const calls = [], saves = [], grants = { "revoked-source": { enrolled: false, content: false, share: false, retrieve: false } };
  const engine = { mode: "empty", catalog: [], store: { data: { grants }, save() { saves.push("settings"); } }, modelCalls: 0,
    nativeFactory: () => { throw new Error("No inference or native commands in this fixture"); },
    workspace: { index, running: false, cancelled: false, save() { saves.push("workspace"); }, summary() { return { hasMore: more[Math.min(calls.length - 1, more.length - 1)] }; },
      async scan(profile, options) {
        calls.push({ profile: structuredClone(profile), options: options ? structuredClone(options) : undefined });
        if (handler) await handler(engine, calls.length);
        engine.workspace.index = { profile: { id: "native-scope", ...profile }, nodes: [], edges: [], sessions: [] };
      },
    },
  };
  return { engine, calls, saves, grants };
}
test("explicit connect all upgrades cached scope while preserving account, paths and per-session revocations", async () => {
  const roots = { local: ["C:/owned-work"] }, exclusions = { remote: ["/home/owner/private"] };
  const f = fixture({ index: { profile: { id: "cached", active: true, account: "existing-boundary", hosts: ["local", "remote"], providers: ["codex"], policy: "metadata", indexFiles: false, roots, exclusions }, nodes: [{ id: "visible-cache" }] } });
  const scope = f.engine.workspace.index, revocations = structuredClone(f.grants);
  const state = connectAllOwnedWork(f.engine);
  assert.equal(scope.profile.policy, "local-retrieval"); assert.equal(scope.profile.indexFiles, true);
  assert.equal(scope.profile.account, "existing-boundary"); assert.equal(scope.profile.roots, roots); assert.equal(scope.profile.exclusions, exclusions);
  assert.deepEqual(scope.profile.hosts, ["local", "remote"]);
  assert.equal(f.engine.workspace.index.nodes[0].id, "visible-cache"); assert.equal(state.cachedScopeAvailable, true);
  assert.deepEqual(f.engine.store.data.desktopPreferences, { connectAll: true, hosts: ["local", "remote"], policy: "local-retrieval", indexFiles: true });
  assert.deepEqual(f.grants, revocations); assert.deepEqual(f.saves, ["workspace", "settings"]);
  await state.promise; assert.deepEqual(f.grants, revocations);
});
test("metadata comes first, full owning inventory follows and continuation stops at three batches", async () => {
  const f = fixture({ more: [true, true, true] });
  const state = connectAllOwnedWork(f.engine);
  assert.equal(state.status, "connecting"); assert.equal(f.calls.length, 0);
  assert.equal(connectAllOwnedWork(f.engine), state);
  await state.promise;
  assert.equal(f.calls.length, 3); assert.deepEqual(f.calls[0].options, { catalogOnly: true });
  assert.equal(f.calls[1].options, undefined); assert.deepEqual(f.calls[2].options, { continuePages: true });
  for (const call of f.calls) {
    assert.deepEqual(call.profile.hosts, ["local"]); assert.deepEqual(call.profile.providers, ["codex", "claude"]);
    assert.equal(call.profile.policy, "local-retrieval"); assert.equal(call.profile.indexFiles, true);
  }
  assert.equal(state.status, "partial"); assert.equal(state.hasMore, true); assert.equal(f.engine.modelCalls, 0);
});
test("complete inventory does not request an unnecessary continuation", async () => {
  const f = fixture({ more: [false] }); const state = connectAllOwnedWork(f.engine, { hosts: ["local"] });
  await state.promise;
  assert.equal(f.calls.length, 2); assert.equal(state.status, "ready"); assert.equal(state.partial, false);
  assert.deepEqual(f.calls[0].profile.hosts, ["local"]);
});
test("background indexing continues progressing cursors beyond the initial three batches", async () => {
  const f = fixture({ more: [true, true, true, true, false] });
  const scan = f.engine.workspace.scan.bind(f.engine.workspace);
  f.engine.workspace.scan = async (...args) => { await scan(...args); f.engine.workspace.index.filesystemCursors = { local: "page-" + f.calls.length }; };
  const state = connectAllOwnedWork(f.engine); await state.promise;
  assert.equal(f.calls.length, 5); assert.equal(state.status, "ready");
  assert(f.calls.slice(2).every(call => call.options.continuePages === true));
});
test("background indexing obeys its bound even if the source keeps changing", async () => {
  const f = fixture({ more: [true] }), scan = f.engine.workspace.scan.bind(f.engine.workspace);
  f.engine.workspace.scan = async (...args) => { await scan(...args); f.engine.workspace.index.filesystemCursors = { local: "page-" + f.calls.length }; };
  const state = connectAllOwnedWork(f.engine, { maxBatches: 4 }); await state.promise;
  assert.equal(f.calls.length, 4); assert.equal(state.status, "partial");
});
test("revoked scope and concurrent external scan refuse without reenable or preference mutation", async () => {
  const f = fixture({ index: { profile: { id: "revoked", active: false } } });
  assert.equal(connectAllOwnedWork(f.engine).status, "revoked"); assert.equal(f.calls.length, 0); assert.deepEqual(f.saves, []);
  assert.equal(f.engine.workspace.index.profile.active, false); assert.equal(f.engine.store.data.desktopPreferences, undefined);
  const g = fixture(); g.engine.workspace.running = true;
  assert.equal(connectAllOwnedWork(g.engine).status, "busy"); assert.deepEqual(g.saves, []); assert.equal(g.calls.length, 0);
});
test("failure exposes generic safe status with no loop, provider credentials or diagnostics", async () => {
  const f = fixture({ handler: async () => { throw new Error("PRIVATE TOKEN AND THREAD TITLE"); } });
  const state = connectAllOwnedWork(f.engine); await state.promise;
  assert.equal(state.status, "unavailable"); assert.equal(f.calls.length, 1);
  assert.ok(!JSON.stringify(state).includes("PRIVATE"));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 1);
});
test("external cancellation between batches stops further owning scans", async () => {
  const f = fixture({ handler: async (engine, batch) => { if (batch === 1) engine.workspace.cancelled = true; } });
  const state = connectAllOwnedWork(f.engine); await state.promise;
  assert.equal(state.status, "cancelled"); assert.equal(f.calls.length, 1);
});

test("fresh connect all does not enroll or scan an unconfigured remote host", async () => {
  const f = fixture(); const state = connectAllOwnedWork(f.engine); await state.promise;
  assert.deepEqual(f.engine.store.data.desktopPreferences.hosts, ["local"]);
  assert.ok(f.calls.every(call => call.profile.hosts.length === 1 && call.profile.hosts[0] === "local"));
});
