import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Engine } from "../app/engine.mjs";
import { Store } from "../app/store.mjs";
import { FabricAdapter } from "../app/fabric.mjs";
import { startServer } from "../app/server.mjs";

const THREAD = "11111111-2222-4333-8444-555555555555";
const TURN = "66666666-7777-4888-8999-000000000000";
const requestId = (group, message, source) => createHash("sha256").update(group + message + source).digest("hex");
async function setup(t, { defer = false, policyFailure = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "as-headless-http-"));
  const engine = new Engine(new Store(root), new FabricAdapter({ stateRoot: root }));
  engine.loadSample(); engine.mode = "workspace-connected";
  engine.probe = async () => { throw new Error("No native probe allowed in injected HTTP test"); };
  const source = engine.session("sample-codex-old");
  Object.assign(source, { fixture: false, host: "remote", nativeThreadId: THREAD,
    cwd: "/tmp/agentspaces-headless-server-fixture", status: "unknown" });
  engine.store.data.projects[source.project].fixture = false;
  for (const id of [source.id, "sample-claude-new"])
    engine.grant(id, { enrolled: true, content: true, retrieve: true, share: true });
  let release; const gate = new Promise(yes => release = yes);
  const counts = { open: 0, bind: 0, answer: 0, close: 0, scans: 0 }, bindings = [];
  engine.workspace.scan = async input => {
    counts.scans++;
    engine.workspace.index = { schema: 1, fixture: false, profile: { ...input, id: "scope-http-fixture", active: true },
      nodes: [], edges: [], sessions: [], coverage: [], errors: [], cursors: {}, filesystemCursors: {} };
    return engine.workspace.view();
  };
  const factory = callbacks => ({ events: new EventEmitter(),
    async open() { counts.open++; },
    async bindExistingThread(binding) {
      counts.bind++; bindings.push(binding);
      if (policyFailure) throw Object.assign(new Error("Rejected fixture native policy"), { code: "native_existing_permission_policy_not_qualified" });
      const proof = { nativeThreadId: binding.threadId, cwd: binding.cwd, host: "remote",
        sandbox: { type: "readOnly", networkAccess: false }, approvalPolicy: "on-request",
        source: "existing-native-thread-resume-response" };
      await callbacks.persistPermissionProof(proof);
      return { nativeThreadId: binding.threadId, permissionProof: proof };
    },
    async answer(args) {
      counts.answer++;
      assert(engine.store.data.codexDiscussionDeliveries[args.clientId], "HTTP delivery must allocate a durable identity before execution");
      await callbacks.persistReceipt({ clientId: args.clientId, nativeThreadId: args.threadId,
        nativeTurnId: TURN, status: "running", retryAllowed: false });
      if (defer) await gate;
      const receipt = { clientId: args.clientId, nativeThreadId: args.threadId,
        nativeTurnId: TURN, status: "completed", retryAllowed: false };
      await callbacks.persistReceipt(receipt);
      return { nativeThreadId: args.threadId, nativeTurnId: TURN, text: "HTTP fixture native adapter reply",
        usage: { known: true, inputTokens: 10, outputTokens: 6, totalTokens: 16 }, receipt };
    },
    close() { counts.close++; },
  });
  const app = await startServer({ root, engine, port: 0, codexAdapterFactory: factory });
  t.after(() => { release(); return app.close(); });
  const page = await fetch(app.address), cookie = page.headers.get("set-cookie").split(";")[0];
  const ownerHeaders = { Cookie: cookie, Origin: app.address, "X-AgentSpaces": "local-companion", "Content-Type": "application/json" };
  const post = (path, value, headers = ownerHeaders) => fetch(app.address + path,
    { method: "POST", headers, body: JSON.stringify(value) });
  const create = await post("/api/discussions/create", { title: "HTTP native reply fixture", sessionIds: [source.id, "sample-claude-new"] });
  assert.equal(create.status, 200); const group = await create.json();
  return { app, engine, source, group, counts, bindings, release, post, ownerHeaders };
}
async function currentGroup(app, headers, id) {
  const response = await fetch(app.address + "/api/discussions", { headers });
  assert.equal(response.status, 200); return (await response.json()).find(group => group.id === id);
}

test("owner mention returns immediately and its native reply appears once in the original HTTP discussion", async t => {
  const { app, engine, source, group, counts, release, post, ownerHeaders } = await setup(t, { defer: true });
  const args = { id: group.id, text: "@codex1 explain the work", deliveryId: "http-mention-delivery-0001" };
  const response = await post("/api/discussions/post", args); assert.equal(response.status, 200);
  const immediate = await response.json(); assert.equal(immediate.messages.length, 1);
  assert.match(immediate.messages[0].targets[0].status, /connecting-native-agent|awaiting-native-reply/);
  const id = requestId(group.id, immediate.messages[0].id, source.id);
  release(); await app.codexAgents.wait(id);
  const updated = await currentGroup(app, ownerHeaders, group.id); assert.equal(updated.messages.length, 2);
  const reply = updated.messages[1];
  assert.equal(reply.source.sessionId, source.id); assert.equal(reply.source.nativeThreadId, THREAD);
  assert.equal(reply.turnId, TURN); assert.equal(reply.replyTo, immediate.messages[0].id);
  assert.equal(reply.synthetic, false); assert.equal(reply.text, "HTTP fixture native adapter reply");
  const duplicate = await post("/api/discussions/post", args); assert.equal(duplicate.status, 200);
  await app.codexAgents.wait(id);
  assert.equal(counts.answer, 1); assert.equal(counts.bind, 1);
  assert.equal((await currentGroup(app, ownerHeaders, group.id)).messages.length, 2);
  assert.equal(engine.store.data.codexDiscussionDeliveries[id].status, "native-agent-replied");
});

test("explicit owner-selected native source routes through its exact UUID and parent message", async t => {
  const { app, source, group, counts, bindings, post, ownerHeaders } = await setup(t);
  const response = await post("/api/discussions/post", { id: group.id, text: "Compare the latest evidence",
    targets: [source.id], deliveryId: "http-explicit-delivery-0001" });
  assert.equal(response.status, 200); const posted = await response.json();
  await app.codexAgents.wait(requestId(group.id, posted.messages[0].id, source.id));
  assert.equal(counts.answer, 1); assert.equal(bindings[0].threadId, THREAD);
  assert.equal(bindings[0].cwd, "/tmp/agentspaces-headless-server-fixture");
  const final = await currentGroup(app, ownerHeaders, group.id);
  assert.equal(final.messages[1].source.nativeThreadId, THREAD);
  assert.equal(final.messages[1].replyTo, posted.messages[0].id);
});

test("participant bearer capabilities cannot connect all work or invoke owner model wake", async t => {
  const { engine, source, group, counts, post } = await setup(t);
  const connector = engine.issueConnector(source.id);
  const headers = { Authorization: "Bearer " + connector.token, "Content-Type": "application/json" };
  const before = JSON.stringify(engine.store.data.desktopPreferences ?? null);
  for (const [path, data] of [
    ["/api/desktop/connect-all", { nativePolicyGranted: true }],
    ["/api/discussions/post", { id: group.id, text: "@codex1 wake", deliveryId: "denied-wake-delivery-0001" }],
  ]) {
    const response = await post(path, data, headers); assert.equal(response.status, 400);
    assert.match((await response.json()).error, /capability denied/);
  }
  assert.equal(JSON.stringify(engine.store.data.desktopPreferences ?? null), before);
  assert.equal(counts.scans, 0); assert.equal(counts.open, 0); assert.equal(counts.answer, 0);
  assert.equal(engine.discussions.group(group.id).messages.length, 0);
});

test("native full-access policy is recorded only for the exact owner boolean grant", async t => {
  const { engine, post, group, source, app, bindings } = await setup(t);
  for (const value of ["true", 1, false, null]) {
    const response = await post("/api/desktop/connect-all", { nativePolicyGranted: value, hosts: ["local"] });
    assert.equal(response.status, 200); assert.notEqual(engine.store.data.desktopPreferences?.allowNativeFullAccess, true);
  }
  const response = await post("/api/desktop/connect-all", { nativePolicyGranted: true, hosts: ["local", "remote"] });
  assert.equal(response.status, 200); assert.equal(engine.store.data.desktopPreferences.allowNativeFullAccess, true);
  const submitted = await post("/api/discussions/post", { id: group.id, text: "@codex1 reply under the existing policy",
    deliveryId: "http-owner-policy-delivery-0001" });
  assert.equal(submitted.status, 200); const value = await submitted.json();
  await app.codexAgents.wait(requestId(group.id, value.messages[0].id, source.id));
  assert.deepEqual(bindings[0].grant, { execution: true, allowFullAccess: true });
});

test("native policy refusal stays visible in the HTTP group without a manufactured response", async t => {
  const { app, engine, source, group, counts, post, ownerHeaders } = await setup(t, { policyFailure: true });
  const response = await post("/api/discussions/post", { id: group.id, text: "@codex1 reply",
    deliveryId: "http-policy-refusal-delivery-0001" });
  assert.equal(response.status, 200); const posted = await response.json();
  const id = requestId(group.id, posted.messages[0].id, source.id); await app.codexAgents.wait(id);
  const final = await currentGroup(app, ownerHeaders, group.id);
  assert.equal(final.messages.length, 1); assert.equal(final.messages[0].targets[0].status, "native-agent-unavailable");
  assert.equal(counts.bind, 1); assert.equal(counts.answer, 0);
  assert.equal(engine.store.data.codexDiscussionDeliveries[id].retryAllowed, false);
});

test('HTTP recent history preserves uncertain native receipts when errors omit an outcome flag', async t => {
  const { engine, post } = await setup(t);
  const deliveryId = 'http-uncertain-history-0001';
  engine.ask.answer = async () => {
    engine.store.data.askReceipts ??= {};
    engine.store.data.askReceipts[deliveryId] = { state: 'uncertain', dispatchCounted: true };
    engine.store.save();
    throw new Error('Synthetic invalid bounded answer response');
  };
  const failed = await post('/api/ask/answer', { deliveryId, question: 'Synthetic question' });
  assert.equal(failed.status, 400);
  const history = await (await post('/api/ask/history', {})).json();
  assert.equal(history.entries[0].status, 'uncertain');
  const attempt = await post('/api/ask/history', { record: { deliveryId, question: 'Synthetic question', status: 'failed' } });
  assert.equal(attempt.status, 200);
  assert.equal((await attempt.json()).entries[0].status, 'uncertain');
  assert.equal(engine.store.data.askReceipts[deliveryId].state, 'uncertain');
});
