import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Store } from "../app/store.mjs";
import { Engine } from "../app/engine.mjs";
import { FabricAdapter } from "../app/fabric.mjs";
import { startServer } from "../app/server.mjs";
import { routeConversation } from "../app/conversation-routing.mjs";

const CODEX_THREAD = "11111111-2222-4333-8444-555555555555";
const id = (group, message, source) => createHash("sha256").update(group + message + source).digest("hex");
function engineFixture() {
  const root = mkdtempSync(join(tmpdir(), "as-agent-dialogue-"));
  const engine = new Engine(new Store(root), new FabricAdapter({ stateRoot: root }));
  engine.loadSample(); return { root, engine };
}
async function httpSetup(t) {
  const { root, engine } = engineFixture(); const codex = engine.session("sample-codex-old"), claude = engine.session("sample-claude-new");
  Object.assign(codex, { fixture: false, host: "remote", nativeThreadId: CODEX_THREAD, cwd: "/tmp/agentspaces-agent-dialogue", status: "unknown" });
  Object.assign(claude, { fixture: false, host: "local", nativeThreadId: "99999999-2222-4333-8444-555555555555" });
  engine.store.data.projects[codex.project].fixture = false;
  for (const source of [codex, claude]) engine.grant(source.id, { enrolled: true, content: true, share: true, retrieve: true });
  let answers = 0; const nativeCalls = [];
  const factory = callbacks => ({ events: new EventEmitter(), open: async () => {}, close() {},
    async bindExistingThread(input) { return { nativeThreadId: input.threadId, permissionProof: { nativeThreadId: input.threadId } }; },
    async answer(input) {
      answers++; nativeCalls.push(input);
      const turn = "fixture-native-turn-" + answers;
      await callbacks.persistReceipt({ clientId: input.clientId, nativeThreadId: input.threadId, nativeTurnId: turn, status: "completed", retryAllowed: false });
      return { nativeThreadId: input.threadId, nativeTurnId: turn,
        text: answers === 1 ? "@claude1 review my evidence" : "@claude1 continue this conversation",
        usage: { known: false } };
    },
  });
  const app = await startServer({ root, engine, port: 0, codexAdapterFactory: factory }); t.after(() => app.close());
  const page = await fetch(app.address), cookie = page.headers.get("set-cookie").split(";")[0];
  const owner = { Cookie: cookie, Origin: app.address, "X-AgentSpaces": "local-companion", "Content-Type": "application/json" };
  const post = (path, data, headers = owner) => fetch(app.address + path, { method: "POST", headers, body: JSON.stringify(data) });
  const response = await post("/api/discussions/create", { title: "Bounded cross-provider dialogue", sessionIds: [codex.id, claude.id] });
  assert.equal(response.status, 200); const group = await response.json();
  const connector = engine.issueConnector(claude.id), binding = engine.connector(connector.token), notices = [];
  const channel = app.channels.connect(binding, async message => { notices.push(message); }); t.after(channel.close);
  return { app, engine, codex, claude, group, post, connector, notices, nativeCalls, count: () => answers };
}
async function begin(f) {
  const response = await f.post("/api/discussions/post", { id: f.group.id, text: "@codex1 begin the review", deliveryId: "dialogue-owner-0001" });
  assert.equal(response.status, 200); const value = await response.json(), root = value.messages[0];
  await f.app.codexAgents.wait(id(f.group.id, root.id, f.codex.id)); return root;
}

test("one user-started HTTP conversation crosses Codex and Claude and stops after two descendant hops", async t => {
  const f = await httpSetup(t), root = await begin(f);
  assert.equal(f.notices.length, 1); assert.equal(f.count(), 1);
  const notice = f.notices[0], payload = { requestId: notice.meta.request_id, discussionId: f.group.id,
    text: "@codex1 I checked the evidence", nativeTurnId: "fixture-claude-turn-1", deliveryId: "dialogue-claude-reply-0001" };
  const headers = { Authorization: "Bearer " + f.connector.token, "Content-Type": "application/json" };
  const response = await f.post("/api/native/channel/reply", payload, headers); assert.equal(response.status, 200);
  const group = f.engine.discussions.group(f.group.id), claudeReply = group.messages.find(m => m.deliveryId === payload.deliveryId);
  await f.app.codexAgents.wait(id(group.id, claudeReply.id, f.codex.id));
  assert.equal(group.messages.length, 4); assert.equal(f.count(), 2); assert.equal(f.notices.length, 1);
  const [human, firstCodex, nativeClaude, secondCodex] = group.messages;
  assert.equal(human.id, root.id); assert.equal(human.source, null);
  assert.equal(firstCodex.source.sessionId, f.codex.id); assert.equal(firstCodex.replyTo, human.id);
  assert.equal(nativeClaude.source.sessionId, f.claude.id); assert.equal(nativeClaude.replyTo, firstCodex.id);
  assert.equal(secondCodex.source.sessionId, f.codex.id); assert.equal(secondCodex.replyTo, nativeClaude.id);
  assert.equal(firstCodex.source.nativeThreadId, CODEX_THREAD); assert.equal(secondCodex.source.nativeThreadId, CODEX_THREAD);
  assert.equal(firstCodex.turnId, "fixture-native-turn-1"); assert.equal(secondCodex.turnId, "fixture-native-turn-2");
  assert.deepEqual(secondCodex.targets, [], "A third-depth reply must not start another native turn");
  assert(f.nativeCalls.every(call => call.threadId === CODEX_THREAD));
  const repeated = await f.post("/api/native/channel/reply", payload, headers); assert.equal(repeated.status, 200);
  await f.app.codexAgents.wait(id(group.id, claudeReply.id, f.codex.id));
  assert.equal(group.messages.length, 4); assert.equal(f.count(), 2); assert.equal(f.notices.length, 1);
});

test("revoking a peer after targeted notification prevents its HTTP reply and subsequent native dispatch", async t => {
  const f = await httpSetup(t); await begin(f); const notice = f.notices[0];
  f.engine.grant(f.claude.id, { share: false });
  const response = await f.post("/api/native/channel/reply", { requestId: notice.meta.request_id,
    discussionId: f.group.id, text: "@codex1 continue", nativeTurnId: "fixture-claude-turn", deliveryId: "revoked-peer-reply-0001" },
    { Authorization: "Bearer " + f.connector.token, "Content-Type": "application/json" });
  assert.equal(response.status, 400); assert.equal(f.engine.discussions.group(f.group.id).messages.length, 2);
  assert.equal(f.count(), 1); assert.equal(f.notices.length, 1);
});

function routingFixture() {
  const { engine } = engineFixture(), template = engine.session("sample-claude-new");
  engine.catalog = Array.from({ length: 12 }, (_, i) => ({ ...template, id: "routing-source-" + i }));
  for (const source of engine.catalog) engine.grant(source.id, { enrolled: true, content: true, share: true, retrieve: true });
  const created = engine.discussions.create({ title: "Bounded routing fixture", sessionIds: engine.catalog.map(s => s.id) });
  const group = engine.discussions.group(created.id), deliveries = new Map();
  const transports = { codexAgents: { dispatch() { throw new Error("No Codex transport expected"); } },
    channels: { isConnected: () => true, async deliver(value) {
      if (!deliveries.has(value.requestId)) deliveries.set(value.requestId, value);
      await Promise.resolve(); return { status: "delivered-to-native-transport" };
    } } };
  const contribute = (number, text, replyTo, suffix) => {
    const source = engine.catalog[number];
    engine.discussions.contribute({ id: group.id, text, replyTo, nativeTurnId: "fixture-turn-" + suffix,
      deliveryId: "routing-contribution-" + suffix }, { sessionId: source.id });
    return group.messages.at(-1);
  };
  return { engine, group, transports, deliveries, contribute };
}

test("parallel descendant mentions share a sixteen-target budget and repeated routing has no new effects", async () => {
  const f = routingFixture();
  f.engine.discussions.post({ id: f.group.id, text: "Start bounded review", deliveryId: "routing-human-root-0001",
    targets: f.engine.catalog.slice(1).map(s => s.id) });
  const root = f.group.messages[0]; assert.equal(root.targets.length, 11);
  const aliases = f.group.members.map(m => "@" + m.alias).join(" ");
  const A = f.contribute(0, aliases, root.id, "budget-A"), B = f.contribute(1, aliases, root.id, "budget-B");
  await Promise.all([routeConversation(f.engine, f.transports, f.group, A), routeConversation(f.engine, f.transports, f.group, B)]);
  assert.equal(root.targets.length + A.targets.length + B.targets.length, 16);
  assert.equal(f.deliveries.size, 5); assert.equal(A.targets.some(t => t.sessionId === A.source.sessionId), false);
  await routeConversation(f.engine, f.transports, f.group, A); assert.equal(f.deliveries.size, 5);
});

test("orphan contributions, self mentions and third-depth replies never start another native conversation", async () => {
  const f = routingFixture();
  const orphan = f.contribute(0, "@claude2 wake", null, "orphan");
  await routeConversation(f.engine, f.transports, f.group, orphan); assert.equal(f.deliveries.size, 0);
  f.engine.discussions.post({ id: f.group.id, text: "User root", deliveryId: "routing-human-root-0001" });
  const root = f.group.messages.at(-1);
  const self = f.contribute(0, "@claude1 continue", root.id, "self");
  await routeConversation(f.engine, f.transports, f.group, self); assert.equal(f.deliveries.size, 0);
  const depth2 = f.contribute(1, "No routing requested", self.id, "depth2");
  const depth3 = f.contribute(0, "@claude2 wake", depth2.id, "depth3");
  await routeConversation(f.engine, f.transports, f.group, depth3); assert.equal(f.deliveries.size, 0);
  assert.deepEqual(depth3.targets, []);
});
