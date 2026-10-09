import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../app/store.mjs";
import { Engine } from "../app/engine.mjs";
import { AgentBroadcast } from "../app/agent-broadcast.mjs";

const NOW = Date.parse("2026-10-09T12:00:00Z"), DAY = 86400000;
const uuid = index => "00000000-0000-4000-8000-" + String(index).padStart(12, "0");
const input = { text: "Please share your findings.", nativeTurnId: "self-reported-broadcast-turn", deliveryId: "broadcast-test-0001" };
function fixture(t, count = 5) {
  const root = mkdtempSync(join(tmpdir(), "as-agent-broadcast-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const makeEngine = () => new Engine(new Store(root), { diagnostics: () => ({ status: "synthetic-disconnected" }), close() {} }, {
    clock: () => NOW, nativeFactory: () => { throw new Error("No external native or model operation permitted"); },
  });
  const engine = makeEngine();
  engine.workspace.index = { schema: 1, fixture: false,
    profile: { id: "broadcast-scope", account: "synthetic-owner", active: true, policy: "local-retrieval", hosts: ["local", "remote"], providers: ["codex", "claude"], roots: {}, exclusions: {}, indexFiles: false },
    nodes: [], edges: [], sessions: [], coverage: [], errors: [] };
  const sources = Array.from({ length: count }, (_, offset) => {
    const index = offset + 1, provider = index % 2 ? "codex" : "claude", host = index % 2 ? "local" : "remote";
    return { id: provider + "@" + host + ":" + uuid(index), nativeThreadId: uuid(index), provider, host,
      cwd: host === "local" ? join(root, "synthetic-work") : "/synthetic/work", account: "synthetic-owner", scopeId: "broadcast-scope", fixture: false,
      title: "Chillit recipe peer " + index, topics: ["cooking"], updatedAt: new Date(NOW - 2 * DAY).toISOString(), sourceVersion: "synthetic-1", status: "unknown" };
  });
  engine.workspace.restore(sources); engine.workspace.index.sessions = sources; engine.workspace.save(); engine.store.save();
  const binding = engine.connector(engine.issueConnector(sources[0].id).token), service = new AgentBroadcast(engine);
  t.after(() => { assert.equal(engine.modelCalls, 0); assert.equal(engine.cache.size, 0); });
  return { root, engine, sources, binding, service, makeEngine };
}
const room = (f, members = f.sources.slice(0, 3)) => f.engine.discussions.create({ title: "Existing broadcast room", sessionIds: members.map(source => source.id), agentInitiation: true, selfRegistration: true });

test("room @all snapshots only current peers and strips its selector before posting", async t => {
  const f = fixture(t), origin = room(f);
  const result = await f.service.send({ ...input, text: "@all Please share your findings.", discussionId: origin.id }, f.binding);
  assert.deepEqual(result.selectedSourceIds, f.sources.slice(1, 3).map(source => source.id));
  assert.equal(result.batches.length, 1); assert.equal(result.batches[0].discussionId, origin.id);
  const group = f.engine.discussions.group(origin.id), message = group.messages[0];
  assert.equal(group.members.length, 3); assert.equal(message.text, input.text);
  assert.equal(message.source.sessionId, f.sources[0].id); assert.equal(message.turnId, input.nativeTurnId);
  assert.deepEqual(message.targets.map(target => target.sessionId), result.selectedSourceIds);
  assert.equal(message.wire.metadata.originalSelectorText, "@all Please share your findings.");
});

test("ordinary stable aliases retain room targeting rather than becoming a catalog broadcast", async t => {
  const f = fixture(t), origin = room(f), alias = origin.members[1].alias;
  const result = await f.service.send({ ...input, text: "@" + alias + " Please share your result.", discussionId: origin.id }, f.binding);
  assert.deepEqual(result.selectedSourceIds, [f.sources[1].id]);
  const message = f.engine.discussions.group(origin.id).messages[0];
  assert.equal(message.text, "@" + alias + " Please share your result.");
  assert.deepEqual(message.targets.map(target => target.sessionId), [f.sources[1].id]);
});

test("topic and date selectors intersect and admit selected nonmembers through invitation", async t => {
  const f = fixture(t), origin = room(f, [f.sources[0], f.sources[1]]);
  f.sources[1].title = "Unrelated transport"; f.sources[1].topics = [];
  f.sources[3].updatedAt = new Date(NOW - 60 * DAY).toISOString();
  const result = await f.service.send({ ...input, text: '@recent(30d) @topic("chillit recipe") Please share your findings.', discussionId: origin.id }, f.binding);
  assert.deepEqual(result.selectedSourceIds, [f.sources[2].id, f.sources[4].id]);
  assert.equal(result.batches[0].discussionId, origin.id);
  assert.equal(f.engine.discussions.group(origin.id).members.length, 4);
  assert.equal(result.omitted.outsideActivityWindow, 1); assert.equal(result.omitted.queryMismatch, 1);
  assert.equal(f.engine.discussions.group(origin.id).messages[0].text, input.text);
  assert.deepEqual(f.engine.discussions.group(origin.id).messages[0].targets.map(target => target.sessionId), result.selectedSourceIds);
});

test("explicit native IDs and full source IDs form a deduplicated eligible selection", async t => {
  const f = fixture(t);
  const result = await f.service.send({ ...input, text: `@thread(${f.sources[1].nativeThreadId}) ${input.text}`, sessionIds: [f.sources[1].id, f.sources[2].id] }, f.binding);
  assert.deepEqual(result.selectedSourceIds, [f.sources[1].id, f.sources[2].id]);
  assert.equal(result.batches.length, 1); assert.equal(result.batches[0].createdGroup, true);
  assert.equal(f.engine.store.data.discussions[0].members.length, 3);
});

test("large selections batch into caller plus at most eleven peers without duplicate recipients", async t => {
  const f = fixture(t, 26), result = await f.service.send({ ...input, query: '"chillit recipe"' }, f.binding);
  assert.equal(result.selectedSourceIds.length, 25); assert.equal(result.batches.length, 3);
  assert.deepEqual(result.batches.map(batch => batch.targetSessionIds.length), [11, 11, 3]);
  assert.equal(new Set(result.batches.flatMap(batch => batch.targetSessionIds)).size, 25);
  for (const batch of result.batches) {
    const group = f.engine.discussions.group(batch.discussionId);
    assert(group.members.length <= 12); assert.equal(group.members[0].sessionId, f.sources[0].id);
    assert.equal(group.messages.length, 1); assert.deepEqual(group.messages[0].targets.map(target => target.sessionId), batch.targetSessionIds);
  }
});

test("selection beyond two hundred candidates reports lookup truncation and bounded delivery", async t => {
  const f = fixture(t, 206), result = await f.service.send({ ...input, query: "recipe" }, f.binding);
  assert.equal(result.selectedSourceIds.length, 200); assert.equal(result.batches.length, 19);
  assert.equal(result.coverage.lookedUp, 200); assert.equal(result.coverage.lookupTruncated, true);
  assert.equal(result.coverage.catalogCompleteness, "not-established"); assert.equal(result.omitted.lookupLimit, 5);
  assert.equal(result.batches.flatMap(batch => batch.targetSessionIds).length, 200);
});

test("retry and store restart retain the original snapshot despite new peers and activity changes", async t => {
  const f = fixture(t), request = { ...input, sessionIds: [f.sources[1].id, f.sources[2].id] };
  const first = await f.service.send(request, f.binding), groups = f.engine.store.data.discussions.length;
  f.sources[3].title = "A newly relevant recipe";
  const repeated = await f.service.send(request, f.binding);
  assert.equal(repeated.duplicate, true); assert.deepEqual(repeated.selectedSourceIds, first.selectedSourceIds);
  assert.deepEqual(repeated.batches, first.batches); assert.equal(f.engine.store.data.discussions.length, groups);
  const restarted = f.makeEngine(), restored = await new AgentBroadcast(restarted).send(request, f.binding);
  assert.equal(restored.duplicate, true); assert.deepEqual(restored.batches, first.batches);
  assert.equal(restarted.store.data.discussions[0].messages.length, 1); assert.equal(restarted.modelCalls, 0);
  for (const extra of [{ text: "Changed text" }, { sessionIds: [f.sources[3].id] }, { nativeTurnId: "changed-turn" }]) await assert.rejects(f.service.send({ ...request, ...extra }, f.binding), { code: "agent_broadcast_delivery_id_conflict" });
});

test("caller-only @all does not expand into catalog selection and empty topic matches stay empty", async t => {
  const f = fixture(t), origin = room(f, [f.sources[0]]);
  const all = await f.service.send({ ...input, text: "@all Please respond.", discussionId: origin.id }, f.binding);
  assert.deepEqual(all.selectedSourceIds, []); assert.deepEqual(all.batches, []);
  assert.equal(all.matchedCount, 0); assert.equal(all.coverage.lookedUp, 0);
  const none = await f.service.send({ ...input, query: "missing-topic", deliveryId: "empty-selection-0002" }, f.binding);
  assert.deepEqual(none.selectedSourceIds, []); assert.deepEqual(none.batches, []);
  assert.equal(f.engine.store.data.discussions.length, 1); assert.equal(f.engine.store.data.discussions[0].messages.length, 0);
});

test("cached broadcasts recheck current recipient grants rather than replaying withdrawn targets", async t => {
  const f = fixture(t), request = { ...input, sessionIds: [f.sources[1].id] };
  await f.service.send(request, f.binding);
  f.engine.grant(f.sources[1].id, { share: false });
  await assert.rejects(f.service.send(request, f.binding));
  assert.equal(f.engine.store.data.discussions.length, 1); assert.equal(f.engine.store.data.discussions[0].messages.length, 1);
});

test("crash after a batch group save resumes through stable creation IDs without duplicate groups", async t => {
  const f = fixture(t, 15), request = { ...input, query: "recipe" }, save = f.engine.store.save.bind(f.engine.store); let crashed = false;
  f.engine.store.save = () => { save(); if (!crashed && f.engine.store.data.discussions.length) { crashed = true; throw new Error("Synthetic stop after batch group save"); } };
  await assert.rejects(f.service.send(request, f.binding), /Synthetic stop/); f.engine.store.save = save;
  const restarted = f.makeEngine(), result = await new AgentBroadcast(restarted).send(request, f.binding);
  assert.equal(result.batches.length, 2); assert.equal(restarted.store.data.discussions.length, 2);
  assert(restarted.store.data.discussions.every(group => group.messages.length === 1)); assert.equal(restarted.modelCalls, 0);
});

test("crash after a message append repairs the owned input hash and resumes remaining batches once", async t => {
  const f = fixture(t, 15), request = { ...input, query: "recipe" }, save = f.engine.store.save.bind(f.engine.store); let crashed = false;
  f.engine.store.save = () => { save(); if (!crashed && f.engine.store.data.discussions.some(group => group.messages.some(message => !message.inputHash))) { crashed = true; throw new Error("Synthetic stop after broadcast append"); } };
  await assert.rejects(f.service.send(request, f.binding), /Synthetic stop/); f.engine.store.save = save;
  const restarted = f.makeEngine(), firstMessage = restarted.store.data.discussions[0].messages[0].id;
  const result = await new AgentBroadcast(restarted).send(request, f.binding);
  assert.equal(result.batches[0].messageId, firstMessage); assert.equal(restarted.store.data.discussions.length, 2);
  assert(restarted.store.data.discussions.every(group => group.messages.length === 1)); assert.equal(restarted.modelCalls, 0);
});

test("invalid selectors, missing room @all and forged caller bindings create no broadcast effects", async t => {
  const f = fixture(t);
  for (const request of [null, [], { ...input, text: "@all Please respond." }, input, { ...input, text: "@recent(bad) Please respond." }, { ...input, query: "x".repeat(501) }, { ...input, sessionIds: [] }, { ...input, nativeThreadIds: ["not-a-uuid"] }, { ...input, callerId: f.sources[1].id }]) await assert.rejects(f.service.send(request, f.binding));
  await assert.rejects(f.service.send({ ...input, query: "recipe" }, { ...f.binding, account: "another-owner" }));
  assert.equal(f.engine.store.data.discussions.length, 0); assert.equal(Object.keys(f.engine.store.data.agentBroadcastReceipts).length, 0);
});

test("human @all preserves user authorship and selects every eligible current native member", async t => {
  const f = fixture(t), origin = room(f);
  f.engine.discussions.participant = () => { throw new Error("Human posting must never fabricate a native participant"); };
  const posted = await f.engine.discussions.postAddressed({ id: origin.id, text: "@all Please respond.", deliveryId: "human-all-0001" });
  assert.deepEqual(posted.broadcast.selectedSourceIds, f.sources.slice(0, 3).map(source => source.id));
  assert.equal(posted.batches.length, 1);
  const message = f.engine.discussions.group(origin.id).messages[0];
  assert.equal(message.author, "You"); assert.equal(message.source, null); assert.equal(message.turnId, null);
  assert.equal(message.wire.role, "user"); assert.equal(message.wire.metadata.attribution, "local owner");
  assert.equal(message.wire.metadata.nativeTurnId, ""); assert.equal(message.text, "Please respond.");
  assert.deepEqual(message.targets.map(target => target.sessionId), posted.broadcast.selectedSourceIds);
});

test("human date/topic selectors select and invite nonmembers without changing their source grants", async t => {
  const f = fixture(t), origin = room(f, [f.sources[0]]);
  f.sources[0].title = "Origin transport"; f.sources[0].topics = [];
  f.sources[3].updatedAt = new Date(NOW - 60 * DAY).toISOString();
  const grants = structuredClone(f.engine.store.data.grants), connectors = structuredClone(f.engine.store.data.connectors);
  const posted = await f.engine.discussions.postAddressed({ id: origin.id, text: '@recent(30d) @topic("chillit recipe") Please update the table.', deliveryId: "human-recipe-0001" });
  assert.deepEqual(posted.broadcast.selectedSourceIds, [f.sources[1].id, f.sources[2].id, f.sources[4].id]);
  assert.equal(f.engine.discussions.group(origin.id).members.length, 4);
  assert.equal(f.engine.discussions.group(origin.id).messages[0].source, null);
  assert.deepEqual(f.engine.store.data.grants, grants); assert.deepEqual(f.engine.store.data.connectors, connectors);
});

test("human large selections use eleven-peer rooms and leave a nonbroadcasting origin notice", async t => {
  const f = fixture(t, 15), origin = room(f, [f.sources[0]]);
  const posted = await f.engine.discussions.postAddressed({ id: origin.id, text: '@topic("chillit recipe") Please respond.', deliveryId: "human-large-0001" });
  assert.equal(posted.broadcast.selectedSourceIds.length, 15); assert.equal(posted.batches.length, 3);
  assert.deepEqual(posted.batches.map(batch => batch.targetSessionIds.length), [0, 11, 4]);
  const marker = f.engine.discussions.group(origin.id).messages[0];
  assert.equal(marker.source, null); assert.deepEqual(marker.targets, []);
  for (const batch of posted.batches.slice(1)) {
    const group = f.engine.discussions.group(batch.discussionId);
    assert(group.members.length <= 11); assert.equal(group.messages[0].source, null); assert.equal(group.messages[0].wire.role, "user");
  }
});

test("human retries and store restart retain exact recipients and message identity", async t => {
  const f = fixture(t), origin = room(f), request = { id: origin.id, text: "@all Please respond.", deliveryId: "human-stable-0001" };
  const first = await f.engine.discussions.postAddressed(request);
  f.engine.discussions.inviteOwner({ id: origin.id, sessionId: f.sources[3].id });
  const second = await f.engine.discussions.postAddressed(request);
  assert.equal(second.broadcast.duplicate, true); assert.deepEqual(second.broadcast.selectedSourceIds, first.broadcast.selectedSourceIds);
  assert.equal(f.engine.discussions.group(origin.id).messages.length, 1);
  const restarted = f.makeEngine(), restored = await restarted.discussions.postAddressed(request);
  assert.deepEqual(restored.batches, first.batches); assert.equal(restarted.discussions.group(origin.id).messages.length, 1);
  await assert.rejects(f.engine.discussions.postAddressed({ ...request, text: "@all Different message" }), { code: "agent_broadcast_delivery_id_conflict" });
  assert.equal(restarted.modelCalls, 0);
});

test("human selection omissions leave a visible question without accidental default room targeting", async t => {
  const f = fixture(t), origin = room(f);
  const posted = await f.engine.discussions.postAddressed({ id: origin.id, text: '@topic("nonexistent phrase") Please respond.', deliveryId: "human-empty-0001" });
  assert.deepEqual(posted.broadcast.selectedSourceIds, []);
  const message = f.engine.discussions.group(origin.id).messages[0];
  assert.equal(message.text, "Please respond."); assert.deepEqual(message.targets, []); assert.equal(message.source, null);
});

test("human append crash recovery retains user attribution and original room member ordering", async t => {
  const f = fixture(t), origin = room(f, [f.sources[2], f.sources[0], f.sources[1]]);
  const request = { id: origin.id, text: "@all Please respond.", deliveryId: "human-crash-0001" }, save = f.engine.store.save.bind(f.engine.store); let crashed = false;
  f.engine.store.save = () => { save(); if (!crashed && f.engine.store.data.discussions.some(group => group.messages.some(message => !message.inputHash))) { crashed = true; throw new Error("Synthetic human append stop"); } };
  await assert.rejects(f.engine.discussions.postAddressed(request), /Synthetic human append stop/); f.engine.store.save = save;
  const restarted = f.makeEngine(), originalId = restarted.discussions.group(origin.id).messages[0].id;
  const restored = await restarted.discussions.postAddressed(request);
  assert.equal(restored.batches[0].messageId, originalId);
  assert.equal(restarted.discussions.group(origin.id).messages.length, 1);
  assert.equal(restarted.discussions.group(origin.id).messages[0].source, null); assert.equal(restarted.modelCalls, 0);
});
