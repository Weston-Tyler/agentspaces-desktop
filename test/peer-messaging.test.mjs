import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Engine } from "../app/engine.mjs";
import { Store } from "../app/store.mjs";
import { PeerMessaging } from "../app/peer-messaging.mjs";
import { routeConversation } from "../app/conversation-routing.mjs";

const uuid = index => "00000000-0000-4000-8000-" + String(index).padStart(12, "0");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "as-peer-message-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const makeEngine = () => new Engine(new Store(root), { diagnostics: () => ({ status: "synthetic-disconnected" }), close() {} }, {
    nativeFactory: () => { throw new Error("Peer message fixtures permit no external native or model operation"); },
  });
  const engine = makeEngine();
  engine.workspace.index = { schema: 1, fixture: false,
    profile: { id: "synthetic-peer-scope", account: "synthetic-owner", active: true, policy: "local-retrieval", hosts: ["local", "remote"], providers: ["codex", "claude"], roots: {}, exclusions: {}, indexFiles: false },
    nodes: [], edges: [], sessions: [], coverage: [], errors: [] };
  const source = (index, extra = {}) => {
    const provider = index % 2 ? "codex" : "claude", host = index % 2 ? "local" : "remote";
    return { id: provider + "@" + host + ":" + uuid(index), nativeThreadId: uuid(index), provider, host,
      cwd: host === "local" ? join(root, "fictional-work") : "/fictional/work",
      account: "synthetic-owner", scopeId: "synthetic-peer-scope", fixture: false,
      title: "Synthetic peer " + index, sourceVersion: "synthetic-1", status: "unknown", topics: [], ...extra };
  };
  const sources = [1, 2, 3].map(index => source(index));
  engine.workspace.restore(sources); engine.workspace.index.sessions = sources;
  engine.workspace.save(); engine.store.save();
  const bindings = sources.map(item => engine.connector(engine.issueConnector(item.id).token));
  const service = new PeerMessaging(engine);
  const input = { sessionId: sources[1].id, text: "Hello, share the relevant finding.", nativeTurnId: "self-reported-sender-turn", deliveryId: "peer-send-0001" };
  t.after(() => { assert.equal(engine.modelCalls, 0); assert.equal(engine.cache.size, 0); });
  return { root, engine, sources, bindings, service, input, makeEngine, source };
}

function resolveUnknown(f, extra = {}) {
  const calls = [];
  f.service.resolveTarget = async request => {
    calls.push(request);
    const observed = f.source(4, { nativeThreadId: request.nativeThreadId, host: request.host, provider: request.provider, ...extra });
    observed.id = observed.provider + "@" + observed.host + ":" + observed.nativeThreadId;
    f.engine.workspace.restore([observed]); f.engine.workspace.index.sessions.push(observed);
    f.engine.workspace.save(); f.engine.store.save();
    return { sessionId: observed.id, token: "PRIVATE-RESOLUTION-CREDENTIAL" };
  };
  return calls;
}

test("a peer without any room receives a bound post in a new two-party group", async t => {
  const f = fixture(t), connectors = structuredClone(f.engine.store.data.connectors), result = await f.service.send(f.input, f.bindings[0]);
  assert.equal(result.createdGroup, true); assert.equal(result.duplicate, false);
  assert.equal(result.targetSessionId, f.sources[1].id);
  const group = f.engine.discussions.group(result.discussionId), message = group.messages[0];
  assert.deepEqual(group.members.map(member => member.sessionId), [f.sources[0].id, f.sources[1].id]);
  assert.equal(group.policy.agentInitiation, true); assert.equal(group.policy.selfRegistration, true);
  assert.equal(group.messages.length, 1); assert.equal(message.id, result.messageId);
  assert.equal(message.text, f.input.text); assert.equal(message.source.sessionId, f.sources[0].id);
  assert.equal(message.turnId, f.input.nativeTurnId); assert.match(message.wire.metadata.attribution, /self-reported/);
  assert.deepEqual(message.targets.map(target => target.sessionId), [f.sources[1].id]);
  assert.deepEqual(f.engine.store.data.connectors, connectors, "a known peer needs no new connector");
  assert(!JSON.stringify(f.engine.store.data.peerMessageReceipts).includes(f.input.text));
});

test("the resulting message wakes only its peer through the existing route, once", async t => {
  const f = fixture(t), result = await f.service.send({ ...f.input, text: "A message mentioning @codex99 still addresses its selected peer." }, f.bindings[0]);
  const group = f.engine.discussions.group(result.discussionId), message = group.messages[0], deliveries = [];
  const adapters = { codexAgents: { dispatch() { throw new Error("No other peer may be dispatched"); } }, channels: {
    isConnected: sessionId => sessionId === f.sources[1].id,
    deliver: async delivery => { deliveries.push(delivery); return { status: "synthetic-delivered" }; },
  } };
  await routeConversation(f.engine, adapters, group, message);
  await routeConversation(f.engine, adapters, group, message);
  assert.equal(deliveries.length, 1); assert.equal(deliveries[0].sessionId, f.sources[1].id);
  assert.equal(deliveries[0].messageId, result.messageId);
});

test("an eligible existing two-party room is reused without replaying its earlier message", async t => {
  const f = fixture(t), room = f.engine.discussions.create({ title: "Existing peer conversation", sessionIds: f.sources.slice(0, 2).map(source => source.id), agentInitiation: true, selfRegistration: true });
  f.engine.discussions.post({ id: room.id, text: "Earlier room context", deliveryId: "earlier-room-post-0001" });
  const previous = structuredClone(f.engine.discussions.group(room.id).messages[0]);
  const result = await f.service.send(f.input, f.bindings[0]);
  assert.equal(result.discussionId, room.id); assert.equal(result.createdGroup, false);
  assert.equal(f.engine.store.data.discussions.length, 1);
  assert.equal(f.engine.discussions.group(room.id).messages.length, 2);
  assert.deepEqual(f.engine.discussions.group(room.id).messages[0], previous);
});

test("closed, disabled and larger rooms do not replace a dedicated peer conversation", async t => {
  const f = fixture(t), pair = f.sources.slice(0, 2).map(source => source.id);
  for (const flags of [{ agentInitiation: false, selfRegistration: true }, { agentInitiation: true, selfRegistration: false }]) f.engine.discussions.create({ title: "Ineligible existing pair", sessionIds: pair, ...flags });
  f.engine.discussions.create({ title: "Three peers", sessionIds: f.sources.map(source => source.id), agentInitiation: true, selfRegistration: true });
  const result = await f.service.send(f.input, f.bindings[0]);
  assert.equal(result.createdGroup, true); assert.equal(f.engine.store.data.discussions.length, 4);
  assert.equal(f.engine.discussions.group(result.discussionId).members.length, 2);
  assert(f.engine.store.data.discussions.filter(group => group.id !== result.discussionId).every(group => group.messages.length === 0));
});

test("exact retries and a store restart preserve group, post, targets and delivery identity", async t => {
  const f = fixture(t), first = await f.service.send(f.input, f.bindings[0]);
  const group = f.engine.discussions.group(first.discussionId), message = group.messages[0], version = group.version;
  message.routing = { allocated: true }; message.targets[0].routingAttempted = true; message.targets[0].status = "synthetic-delivered"; f.engine.store.save();
  const delivery = structuredClone(message.targets);
  const repeated = await f.service.send(f.input, f.bindings[0]);
  assert.equal(repeated.duplicate, true); assert.equal(repeated.messageId, first.messageId);
  assert.equal(group.version, version); assert.deepEqual(message.targets, delivery);
  const restarted = f.makeEngine(), service = new PeerMessaging(restarted, { resolveTarget: () => { throw new Error("No fresh native observation on replay"); } });
  const restored = await service.send(f.input, f.bindings[0]);
  assert.equal(restored.duplicate, true); assert.equal(restored.messageId, first.messageId); assert.equal(restored.discussionId, first.discussionId);
  assert.equal(restarted.store.data.discussions.length, 1); assert.equal(restarted.discussions.group(first.discussionId).messages.length, 1);
  assert.deepEqual(restarted.discussions.group(first.discussionId).messages[0].targets, delivery);
  assert.equal(restarted.modelCalls, 0);
});

test("delivery conflicts include changed recipients, text, turn identity and group title", async t => {
  const f = fixture(t); await f.service.send(f.input, f.bindings[0]);
  for (const extra of [{ sessionId: f.sources[2].id }, { text: "Different text" }, { nativeTurnId: "another-turn" }, { title: "Another conversation" }]) await assert.rejects(f.service.send({ ...f.input, ...extra }, f.bindings[0]), { code: "peer_delivery_id_conflict" });
  assert.equal(f.engine.store.data.discussions.length, 1); assert.equal(f.engine.store.data.discussions[0].messages.length, 1);
});

test("delivery keys are source-bound and input cannot spoof the caller", async t => {
  const f = fixture(t), first = await f.service.send(f.input, f.bindings[0]), second = await f.service.send(f.input, f.bindings[2]);
  assert.notEqual(first.discussionId, second.discussionId); assert.notEqual(first.messageId, second.messageId);
  assert.equal(f.engine.discussions.group(second.discussionId).messages[0].source.sessionId, f.sources[2].id);
  await assert.rejects(f.service.send({ ...f.input, author: f.sources[2].id }, f.bindings[0]), { code: "bounded_peer_message_required" });
  await assert.rejects(f.service.send(f.input, { ...f.bindings[0], account: "foreign-account" }));
  await assert.rejects(f.service.send(f.input, { sessionId: f.sources[0].id }));
  assert.equal(f.engine.store.data.discussions.length, 2);
});

test("unknown UUIDs use metadata resolution, with explicit/default native location and no credential response", async t => {
  const f = fixture(t), calls = resolveUnknown(f);
  const result = await f.service.send({ ...f.input, sessionId: undefined, nativeThreadId: uuid(4) }, f.bindings[0]);
  assert.deepEqual(calls, [{ nativeThreadId: uuid(4), host: "local", provider: "codex" }]);
  assert.equal(result.targetSessionId, "codex@local:" + uuid(4));
  assert(!JSON.stringify(result).includes("PRIVATE-RESOLUTION-CREDENTIAL"));
  assert.equal((await f.service.send({ ...f.input, sessionId: undefined, nativeThreadId: uuid(4) }, f.bindings[0])).duplicate, true);
  assert.equal(calls.length, 1);
});

test("known native UUIDs must be unambiguous, and selectors resolve the exact peer", async t => {
  const f = fixture(t), duplicate = { ...f.sources[1], id: "claude@local:" + f.sources[1].nativeThreadId, host: "local", cwd: join(f.root, "other-work") };
  f.engine.workspace.restore([duplicate]); f.engine.workspace.index.sessions.push(duplicate);
  await assert.rejects(f.service.send({ ...f.input, sessionId: undefined, nativeThreadId: f.sources[1].nativeThreadId }, f.bindings[0]), { code: "peer_native_identity_ambiguous" });
  const result = await f.service.send({ ...f.input, sessionId: undefined, nativeThreadId: f.sources[1].nativeThreadId, host: "remote", provider: "claude" }, f.bindings[0]);
  assert.equal(result.targetSessionId, f.sources[1].id);
});

test("unknown, foreign, revoked and self targets cannot create a room or a post", async t => {
  for (const mutate of [
    f => f.engine.grant(f.sources[1].id, { enrolled: false }),
    f => f.engine.grant(f.sources[1].id, { share: false }),
    f => f.engine.grant(f.sources[1].id, { retrieve: false }),
    f => { f.sources[1].account = "foreign-account"; },
    f => { f.sources[1].scopeId = "foreign-scope"; },
    f => { f.sources[1].nativeThreadId = uuid(99); },
    f => { f.sources[1].fixture = true; },
    f => f.engine.grant(f.sources[0].id, { share: false }),
  ]) {
    const f = fixture(t); mutate(f);
    await assert.rejects(f.service.send(f.input, f.bindings[0]));
    assert.equal(f.engine.store.data.discussions.length, 0); assert.equal(Object.keys(f.engine.store.data.peerMessageReceipts).length, 0);
  }
  const f = fixture(t);
  for (const target of [{ sessionId: "unknown-source" }, { sessionId: f.sources[0].id }, { sessionId: undefined, nativeThreadId: uuid(99) }]) await assert.rejects(f.service.send({ ...f.input, ...target }, f.bindings[0]));
  assert.equal(f.engine.store.data.discussions.length, 0);
});

test("metadata mismatch and private resolver errors fail closed without provider diagnostics", async t => {
  const f = fixture(t);
  f.service.resolveTarget = async () => { throw new Error("PRIVATE PROVIDER DIAGNOSTIC AND TOKEN"); };
  await assert.rejects(f.service.send({ ...f.input, sessionId: undefined, nativeThreadId: uuid(99) }, f.bindings[0]), error => { assert.equal(error.code, "peer_target_unavailable"); assert(!error.message.includes("PRIVATE")); return true; });
  f.service.resolveTarget = async () => ({ sessionId: f.sources[1].id });
  await assert.rejects(f.service.send({ ...f.input, sessionId: undefined, nativeThreadId: uuid(99), host: "remote", provider: "claude" }, f.bindings[0]), { code: "peer_target_identity_mismatch" });
  assert.equal(f.engine.store.data.discussions.length, 0);
});

test("concurrent identical requests resolve and post once while changed concurrent input is refused", async t => {
  const f = fixture(t), resolve = resolveUnknown(f); let release;
  const gate = new Promise(done => { release = done; }), observe = f.service.resolveTarget;
  f.service.resolveTarget = async input => { await gate; return observe(input); };
  const input = { ...f.input, sessionId: undefined, nativeThreadId: uuid(4) };
  const first = f.service.send(input, f.bindings[0]), second = f.service.send(input, f.bindings[0]);
  await assert.rejects(f.service.send({ ...input, text: "Concurrent conflicting text" }, f.bindings[0]), { code: "peer_delivery_id_conflict" });
  release(); const results = await Promise.all([first, second]);
  assert.equal(results[0].messageId, results[1].messageId); assert.equal(resolve.length, 1);
  assert.equal(f.engine.store.data.discussions.length, 1); assert.equal(f.engine.store.data.discussions[0].messages.length, 1);
});

test("restart after the first group save neither recreates it nor allows a changed-target retry", async t => {
  const f = fixture(t), save = f.engine.store.save.bind(f.engine.store); let crashed = false;
  f.engine.store.save = () => { save(); if (!crashed && f.engine.store.data.discussions.length) { crashed = true; throw new Error("Synthetic stop after group persistence"); } };
  await assert.rejects(f.service.send(f.input, f.bindings[0]), /Synthetic stop/);
  f.engine.store.save = save;
  const restarted = f.makeEngine(), service = new PeerMessaging(restarted);
  await assert.rejects(service.send({ ...f.input, sessionId: f.sources[2].id }, f.bindings[0]), { code: "peer_delivery_id_conflict" });
  const result = await service.send(f.input, f.bindings[0]);
  assert.equal(result.createdGroup, true); assert.equal(restarted.store.data.discussions.length, 1);
  assert.equal(restarted.store.data.discussions[0].messages.length, 1); assert.equal(restarted.modelCalls, 0);
});

test("restart after contribution append recovers its input hash without duplicating the post", async t => {
  const f = fixture(t), save = f.engine.store.save.bind(f.engine.store); let crashed = false;
  f.engine.store.save = () => { save(); if (!crashed && f.engine.store.data.discussions.some(group => group.messages.some(message => !message.inputHash))) { crashed = true; throw new Error("Synthetic stop after message append"); } };
  await assert.rejects(f.service.send(f.input, f.bindings[0]), /Synthetic stop/);
  f.engine.store.save = save;
  const restarted = f.makeEngine(), existingId = restarted.store.data.discussions[0].messages[0].id;
  const result = await new PeerMessaging(restarted).send(f.input, f.bindings[0]);
  assert.equal(result.messageId, existingId); assert.equal(result.duplicate, true);
  assert.equal(restarted.store.data.discussions.length, 1); assert.equal(restarted.store.data.discussions[0].messages.length, 1);
  assert(restarted.store.data.discussions[0].messages[0].inputHash);
  assert.deepEqual(restarted.store.data.discussions[0].messages[0].targets.map(target => target.sessionId), [f.sources[1].id]);
  assert.equal(restarted.modelCalls, 0);
});

test("later joined peers and user mentions cannot broaden a direct post's selected recipient", async t => {
  const f = fixture(t), input = { ...f.input, text: "Keep this peer-directed even if @codex2 joins later." };
  const first = await f.service.send(input, f.bindings[0]);
  f.engine.discussions.join({ id: first.discussionId }, f.bindings[2]);
  const repeated = await f.service.send(input, f.bindings[0]);
  assert.equal(repeated.messageId, first.messageId);
  assert.deepEqual(f.engine.discussions.group(first.discussionId).messages[0].targets.map(target => target.sessionId), [f.sources[1].id]);
});

test("request bounds and identity forms are validated before any peer effect", async t => {
  const f = fixture(t);
  for (const input of [null, [], { ...f.input, callerId: f.sources[2].id }, { ...f.input, nativeThreadId: uuid(2) }, { ...f.input, sessionId: undefined }, { ...f.input, host: "other" }, { ...f.input, provider: "other" }, { ...f.input, text: "" }, { ...f.input, text: "x".repeat(8001) }, { ...f.input, nativeTurnId: "" }, { ...f.input, nativeTurnId: "x".repeat(201) }, { ...f.input, deliveryId: "bad" }, { ...f.input, title: "x".repeat(81) }]) await assert.rejects(f.service.send(input, f.bindings[0]), { code: "bounded_peer_message_required" });
  assert.equal(f.engine.store.data.discussions.length, 0); assert.equal(Object.keys(f.engine.store.data.peerMessageReceipts).length, 0);
});
