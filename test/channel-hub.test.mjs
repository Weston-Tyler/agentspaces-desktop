import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../app/store.mjs";
import { Engine } from "../app/engine.mjs";
import { FabricAdapter } from "../app/fabric.mjs";
import { ChannelHub } from "../app/channel-hub.mjs";
import { startClaudeChannel } from "../app/claude-channel.mjs";
import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "agentspaces-channel-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const engine = new Engine(new Store(root), new FabricAdapter({ stateRoot: root })); engine.loadSample();
  const ids = ["sample-codex-old", "sample-claude-new"];
  for (const id of ids) engine.grant(id, { enrolled: true, content: true, retrieve: true, share: true });
  const group = engine.discussions.create({ title: "Channel review", sessionIds: ids });
  const posted = engine.discussions.post({ id: group.id, text: "Review our permitted work", deliveryId: "owner-message-0001" });
  const binding = engine.connector(engine.issueConnector(ids[1]).token);
  const hub = new ChannelHub(engine), sent = [];
  const connection = hub.connect(binding, async data => { sent.push(data); });
  const args = { sessionId: ids[1], discussionId: group.id, messageId: posted.messages[0].id, text: "Review our permitted work", requestId: "channel-request-0001" };
  return { engine, ids, binding, hub, sent, connection, args };
}
test("channel delivery allocates durable identity before transport and reports only transport acknowledgement", async t => {
  const f = setup(t);
  f.hub.connect(f.binding, async data => {
    assert.equal(f.engine.store.data.channelReceipts[f.args.requestId].status, "dispatch-allocated"); f.sent.push(data);
  });
  const receipt = await f.hub.deliver(f.args);
  assert.equal(receipt.status, "delivered-to-native-transport");
  assert.deepEqual(f.sent[0].meta, { request_id: f.args.requestId, discussion_id: f.args.discussionId, message_id: f.args.messageId });
  assert.ok(!JSON.stringify(receipt).includes(f.args.text));
  assert.equal(f.engine.modelCalls, 0);
  assert.equal((await f.hub.deliver(f.args)).replayed, false); assert.equal(f.sent.length, 1);
  await assert.rejects(f.hub.deliver({ ...f.args, text: "Different question" }), { code: "channel_request_id_collision" });
});
test("source grants, stale boundary, membership and connector revocation are rechecked", async t => {
  const f = setup(t);
  f.engine.grant(f.ids[0], { share: false });
  await assert.rejects(f.hub.deliver(f.args)); assert.equal(f.sent.length, 0);
  f.engine.grant(f.ids[0], { share: true });
  f.engine.store.data.connectors = {};
  assert.equal(f.hub.isConnected(f.ids[1]), false);
  await assert.rejects(f.hub.deliver(f.args));
  const g = setup(t); g.engine.session(g.ids[1]).account = "changed-account";
  await assert.rejects(g.hub.deliver(g.args));
  const h = setup(t);
  const other = h.engine.discussions.create({ title: "Other membership", sessionIds: [h.ids[0]] });
  await assert.rejects(h.hub.deliver({ ...h.args, discussionId: other.id }));
  assert.equal(h.sent.length, 0);
});
test("unknown parent and never-connected native channel never create pending work", async t => {
  const f = setup(t);
  await assert.rejects(f.hub.deliver({ ...f.args, messageId: "unknown" }), { code: "channel_message_parent_unknown" });
  f.connection.close(); assert.equal(f.hub.isConnected(f.ids[1]), false);
  delete f.engine.store.data.channelTransports[f.ids[1]];
  await assert.rejects(f.hub.deliver(f.args), { code: "native_channel_not_connected" });
  assert.equal(Object.keys(f.engine.store.data.channelReceipts).length, 0);
});
test("transport failure retains uncertain receipt with no automatic reconnect or replay", async t => {
  const f = setup(t); let attempts = 0;
  f.hub.connect(f.binding, async () => { attempts++; throw new Error("transport lost"); });
  await assert.rejects(f.hub.deliver(f.args), { code: "channel_transport_delivery_uncertain", uncertainOutcome: true });
  const duplicate = await f.hub.deliver(f.args);
  assert.equal(duplicate.status, "uncertain-native-transport"); assert.equal(duplicate.replayed, false); assert.equal(attempts, 1);
});
test("restart derives prior delivery from private receipts and never replays it", async t => {
  const f = setup(t); await f.hub.deliver(f.args);
  const reopenedStore = new Store(f.engine.store.root);
  f.engine.store.data.channelReceipts = reopenedStore.data.channelReceipts;
  const restarted = new ChannelHub(f.engine); let resent = 0;
  restarted.connect(f.binding, async () => { resent++; });
  const receipt = await restarted.deliver(f.args);
  assert.equal(receipt.duplicate, true); assert.equal(receipt.replayed, false); assert.equal(resent, 0);
});
test("reply is participant-bound, request-scoped, deduplicated and ancestry-preserving", async t => {
  const f = setup(t); await f.hub.deliver(f.args);
  const args = { requestId: f.args.requestId, discussionId: f.args.discussionId, text: "Native participant contribution", deliveryId: "channel-reply-0001" };
  const response = f.hub.reply(args, f.binding);
  const message = response.discussion.messages.at(-1);
  assert.equal(message.source.sessionId, f.ids[1]); assert.equal(message.replyTo, f.args.messageId);
  assert.equal(message.turnId, "unreported"); assert.ok(response.attribution.includes("not verified"));
  assert.equal(f.hub.reply(args, f.binding).discussion.version, response.discussion.version);
  assert.throws(() => f.hub.reply({ ...args, requestId: "another-request" }, f.binding), { code: "channel_reply_request_source_mismatch" });
  f.engine.grant(f.ids[1], { share: false }); assert.throws(() => f.hub.reply(args, f.binding));
});
test("closing an old connection cannot detach its replacement", t => {
  const f = setup(t); const replacement = f.hub.connect(f.binding, () => {});
  f.connection.close(); assert.equal(f.hub.isConnected(f.ids[1]), true);
  replacement.close(); assert.equal(f.hub.isConnected(f.ids[1]), false);
});
test("MCP channel declares only channel capability, authenticates app transport and preserves scoped reply routes", async t => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const sockets = [], calls = [];
  class FakeSocket extends EventEmitter { constructor(url, options) { super(); this.url = url; this.options = options; sockets.push(this); } terminate() { this.emit("close"); } }
  const channel = await startClaudeChannel({ address: "http://127.0.0.1:12345", token: "synthetic-participant-capability", WebSocketClass: FakeSocket, transport: serverTransport,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ accepted: true }) }; } });
  const client = new Client({ name: "native-channel-fixture", version: "1" });
  t.after(async () => { await client.close(); await channel.close(); });
  const received = [];
  client.setNotificationHandler(z.object({ method: z.literal("notifications/claude/channel"), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }) }), event => received.push(event));
  await client.connect(clientTransport);
  assert.match(client.getInstructions(), /next safe boundary/);
  assert.match(client.getInstructions(), /Do not interrupt/);
  const capability = client.getServerCapabilities();
  assert.deepEqual(capability.experimental, { "claude/channel": {} });
  assert.ok(!("claude/channel/permission" in capability.experimental));
  assert.equal(sockets[0].url, "ws://127.0.0.1:12345/api/native/channel");
  const list = await client.listTools(); assert.ok(list.tools.some(tool => tool.name === "reply"));
  await client.callTool({ name: "reply", arguments: { requestId: "request-0001", discussionId: "00000000-0000-4000-8000-000000000001", text: "Reply", deliveryId: "reply-0001" } });
  assert.ok(calls[0].url.endsWith("/api/native/channel/reply"));
  assert.equal(calls[0].options.headers.Authorization, "Bearer synthetic-participant-capability");
  sockets[0].emit("message", JSON.stringify({ content: "Question", meta: { request_id: "request-0001" } }));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(received.length, 1);
  sockets[0].emit("message", JSON.stringify({ content: "Bad metadata", meta: { "bad-key": "ignored" } }));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(received.length, 1);
  await assert.rejects(startClaudeChannel({ address: "http://localhost:12345", token: "synthetic" }));
});

test('disconnected known channel durably queues exact unsent message and sends once on reconnect', async t => {
  const f = setup(t); f.connection.close();
  const pending = await f.hub.deliver(f.args);
  assert.equal(pending.status, 'waiting-for-native-transport'); assert.equal(f.sent.length, 0);
  f.engine.store.data = new Store(f.engine.store.root).data;
  const binding = Object.values(f.engine.store.data.connectors).find(value => value.sessionId === f.ids[1]);
  const recovered = new ChannelHub(f.engine);
  recovered.connect(binding, async data => f.sent.push(data));
  await recovered.flush(f.ids[1]);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].content, f.args.text);
  await recovered.flush(f.ids[1]); assert.equal(f.sent.length, 1);
});
test('queued messages recheck sender grants and refuse changed content at reconnect', async t => {
  for (const mutate of [f => f.engine.grant(f.ids[0], { share: false }), f => { f.engine.discussions.group(f.args.discussionId).messages[0].text += ' changed'; }]) {
    const f = setup(t); f.connection.close(); await f.hub.deliver(f.args); mutate(f);
    f.hub.connect(f.binding, async data => f.sent.push(data)); await f.hub.flush(f.ids[1]);
    assert.equal(f.sent.length, 0);
  }
});
test('MCP survives websocket outage and reconnects without replaying native notifications', async t => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const sockets = [];
  class FakeSocket extends EventEmitter { constructor() { super(); sockets.push(this); } terminate() { this.emit('close'); } }
  const channel = await startClaudeChannel({ address: 'http://127.0.0.1:12345', token: 'synthetic', WebSocketClass: FakeSocket, transport: serverTransport, reconnectMinMs: 5, reconnectMaxMs: 20 });
  const client = new Client({ name: 'reconnect-fixture', version: '1' });
  t.after(async () => { await channel.close(); await client.close(); });
  await client.connect(clientTransport); sockets[0].emit('open'); sockets[0].emit('close');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(sockets.length, 2); sockets[1].emit('open');
  assert.ok((await client.listTools()).tools.length); assert.equal(channel.health().status, 'connected');
  await channel.close(); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(sockets.length, 2);
});

test('pending channel input cannot cross a changed source boundary through a fresh connector', async t => {
  const f = setup(t); f.connection.close(); await f.hub.deliver(f.args);
  f.engine.session(f.ids[1]).account = 'another-owner';
  const replacement = f.engine.connector(f.engine.issueConnector(f.ids[1]).token);
  f.hub.connect(replacement, async data => f.sent.push(data)); await f.hub.flush(f.ids[1]);
  assert.equal(f.sent.length, 0); assert.equal(f.engine.store.data.channelReceipts[f.args.requestId].status, 'channel-access-changed; not dispatched');
});
test('update drain retains known-unsent channel message and resumes exactly once', async t => {
  const f=setup(t); let allowed=false; f.engine.dispatchAllowed=()=>allowed;
  const receipt=await f.hub.deliver(f.args);
  assert.equal(receipt.status,'waiting-for-native-transport');assert.equal(f.sent.length,0);
  await f.hub.flush(f.ids[1]); assert.equal(f.sent.length,0);
  allowed=true; await f.hub.flush(f.ids[1]);await f.hub.flush(f.ids[1]);
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].meta.request_id,f.args.requestId);
});
