import test from "node:test";
import assert from "node:assert/strict";
import { resolveNativeSourceMetadata } from "../app/native-source-metadata.mjs";

const thread = "00000000-0000-4000-8000-000000000001", tree = "00000000-0000-4000-8000-000000000002";
function codex(handler) {
  const calls = []; let closed = false;
  return { calls, closed: () => closed, factory: () => ({ open: async () => {}, close: () => { closed = true; }, rpc: async (method, params) => { calls.push({ method, params }); return handler(method, params); } }) };
}
test("exact Codex observation reads metadata only and preserves native tree/thread distinction", async () => {
  const f = codex(() => ({ thread: { id: thread, sessionId: tree, cwd: "/home/owner/work", updatedAt: 1, name: "Fixture source" } }));
  const result = await resolveNativeSourceMetadata({ host: "remote", provider: "codex", nativeThreadId: thread }, { codexFactory: f.factory });
  assert.equal(result.nativeThreadId, thread); assert.equal(result.nativeSessionId, tree); assert.equal(result.nativeObserved, true);
  assert.deepEqual(f.calls, [{ method: "thread/read", params: { threadId: thread, includeTurns: false } }]); assert.equal(f.closed(), true);
});
test("shared native session tree ambiguity never guesses parent or active child", async () => {
  const f = codex(() => ({ data: [{ id: thread, sessionId: tree, cwd: "/home/owner/work" }, { id: "00000000-0000-4000-8000-000000000003", sessionId: tree, cwd: "/home/owner/work" }], nextCursor: null }));
  const result = await resolveNativeSourceMetadata({ host: "remote", provider: "codex", nativeSessionId: tree }, { codexFactory: f.factory });
  assert.equal(result, null); assert.equal(f.calls[0].method, "thread/list"); assert.equal(f.closed(), true);
});
test("bounded incomplete catalog cannot qualify a session-tree binding", async () => {
  const f = codex(() => ({ data: [], nextCursor: "still-more" }));
  assert.equal(await resolveNativeSourceMetadata({ host: "remote", provider: "codex", nativeSessionId: tree }, { codexFactory: f.factory }), null);
  assert.equal(f.calls.length, 32); assert.ok(f.calls.every(call => call.method === "thread/list" && call.params.limit === 100)); assert.equal(f.closed(), true);
});
test("Claude observes only session info and rejects metadata/native identity mismatch", async () => {
  const calls = []; let closed = 0;
  const factory = () => ({ open: async () => {}, close: () => { closed++; }, call: async request => { calls.push(request); return { nativeThreadId: thread, cwd: "/home/owner/work", sourceVersion: "1" }; } });
  const result = await resolveNativeSourceMetadata({ host: "remote", provider: "claude", nativeThreadId: thread }, { claudeFactory: factory });
  assert.equal(result.nativeObserved, true); assert.equal(calls.length, 1); assert.equal(calls[0].action, "info"); assert.equal(closed, 1);
  assert.equal(await resolveNativeSourceMetadata({ host: "remote", provider: "claude", nativeSessionId: tree }, { claudeFactory: factory }), null); assert.equal(calls.length, 1);
  const wrong = codex(() => ({ thread: { id: tree, sessionId: tree, cwd: "/home/owner/work" } }));
  assert.equal(await resolveNativeSourceMetadata({ host: "remote", provider: "codex", nativeThreadId: thread }, { codexFactory: wrong.factory }), null);
});
