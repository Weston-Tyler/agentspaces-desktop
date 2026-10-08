import test from "node:test";
import assert from "node:assert/strict";
import { ensureDesktopDiscovery } from "../app/desktop-discovery.mjs";

function fixture(index = null, handler = null) {
  const calls = [], options = [], engine = {
    mode: "empty", catalog: [],
    workspace: { index, running: false, scan: async (input, scanOptions) => {
      calls.push(input);
      options.push(scanOptions);
      if (handler) await handler(input, engine);
      else engine.workspace.index = { profile: { id: "native-local-scope", active: true }, sessions: [] };
    } },
    nativeFactory: () => { throw new Error("Native models and transcript reads must not be invoked"); },
  };
  return { engine, calls, options };
}
test("restart reuses an active native metadata scope immediately without rescanning", async () => {
  const { engine, calls } = fixture({ profile: { id: "persisted-native", active: true }, sessions: [{ id: "native-source" }], stale: true });
  engine.catalog = [{ id: "native-source", fixture: false }];
  const state = ensureDesktopDiscovery(engine);
  assert.equal(state.ready, true); assert.equal(state.status, "cached-native-metadata");
  assert.equal(state.scopeId, "persisted-native"); assert.equal(engine.mode, "workspace-connected");
  await state.promise; ensureDesktopDiscovery(engine); assert.equal(calls.length, 0);
  assert.equal(engine.workspace.index.stale, true, "cache is not promoted to fresh live discovery");
});
test("explicitly revoked native scope is never automatically reenabled, including retry", async () => {
  const { engine, calls } = fixture({ profile: { id: "revoked-native", active: false } });
  const state = ensureDesktopDiscovery(engine, { retry: true });
  assert.equal(state.ready, false); assert.equal(state.status, "revoked");
  await state.promise; assert.equal(calls.length, 0); assert.equal(engine.workspace.index.profile.active, false);
});
test("fresh startup returns before scanning and invokes only local metadata discovery once", async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const { engine, calls, options } = fixture(null, async (_input, e) => { await gate; e.workspace.index = { profile: { id: "local-native", active: true } }; });
  const state = ensureDesktopDiscovery(engine);
  assert.equal(state.ready, false); assert.equal(state.status, "discovering"); assert.equal(calls.length, 0);
  assert.equal(ensureDesktopDiscovery(engine), state);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { hosts: ["local"], providers: ["codex", "claude"], account: "personal-local", policy: "metadata", indexFiles: false, roots: {}, exclusions: {} });
  assert.deepEqual(options[0], { catalogOnly: true }, "startup does not wait for Git/filesystem inventory");
  release(); await state.promise;
  assert.equal(state.ready, true); assert.equal(engine.mode, "workspace-connected");
  ensureDesktopDiscovery(engine); assert.equal(calls.length, 1);
});
test("fixture cache is ignored and never advertised as a real native connection", async () => {
  const { engine, calls } = fixture({ fixture: true, profile: { id: "workspace-fixture", active: true }, sessions: [{ fixture: true }] });
  engine.catalog = [{ id: "sample", fixture: true }, { id: "retained-native", fixture: false }];
  const state = ensureDesktopDiscovery(engine);
  assert.equal(state.ready, false); assert.equal(state.fixtureCacheIgnored, true);
  assert.equal(engine.workspace.index, null); assert.deepEqual(engine.catalog.map(s => s.id), ["retained-native"]);
  assert.equal(engine.mode, "native-discovery");
  await state.promise; assert.equal(calls.length, 1); assert.equal(state.ready, true);
  assert.notEqual(state.scopeId, "workspace-fixture");
});
test("failure is bounded and sanitized; subsequent checks do not busy-loop or silently retry", async () => {
  let fail = true;
  const { engine, calls } = fixture(null, async (_input, e) => {
    if (fail) throw new Error("PRIVATE TOKEN AND TRANSCRIPT DIAGNOSTIC");
    e.workspace.index = { profile: { id: "explicit-retry", active: true } };
  });
  const state = ensureDesktopDiscovery(engine); await state.promise;
  assert.equal(state.status, "unavailable"); assert.equal(state.retryRequired, true);
  assert.ok(!JSON.stringify(state).includes("PRIVATE"));
  assert.equal(ensureDesktopDiscovery(engine), state); assert.equal(calls.length, 1);
  fail = false; const retry = ensureDesktopDiscovery(engine, { retry: true }); await retry.promise;
  assert.equal(calls.length, 2); assert.equal(retry.ready, true);
});
test("revocation during a discovery pass does not result in connected startup status", async () => {
  const { engine } = fixture(null, async (_input, e) => { e.workspace.index = { profile: { id: "revoked-during-scan", active: false } }; });
  const state = ensureDesktopDiscovery(engine); await state.promise;
  assert.equal(state.ready, false); assert.equal(state.status, "revoked"); assert.equal(state.retryRequired, false);
});
