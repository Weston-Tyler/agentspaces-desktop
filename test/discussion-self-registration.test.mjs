import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Engine } from "../app/engine.mjs";
import { Store } from "../app/store.mjs";

const fixtureBindings = new WeakMap();
function fixture(t, count = 202) {
  const root = mkdtempSync(join(tmpdir(), "as-self-registration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const makeEngine = () => new Engine(new Store(root), {
    diagnostics: () => ({ status: "synthetic-disconnected" }), close() {},
  }, { nativeFactory: () => { throw new Error("Native controllers and models are forbidden in this fixture"); } });
  const engine = makeEngine();
  engine.workspace.index = {
    schema: 1, fixture: false,
    profile: {
      id: "synthetic-shared-scope", active: true, account: "synthetic-owner",
      hosts: ["local", "remote"], providers: ["codex", "claude"],
      policy: "local-retrieval", indexFiles: false, roots: {}, exclusions: {},
    }, nodes: [], edges: [], sessions: [], coverage: [], errors: [],
  };
  const sources = Array.from({ length: count }, (_, index) => {
    const nativeThreadId = "00000000-0000-4000-8000-" + String(index + 1).padStart(12, "0");
    const provider = index % 2 ? "claude" : "codex", host = index % 2 ? "remote" : "local";
    return {
      id: provider + "@" + host + ":" + nativeThreadId, nativeThreadId, provider, host,
      cwd: host === "local" ? join(root, "fictional-work") : "/fictional/work",
      account: "synthetic-owner", scopeId: "synthetic-shared-scope", fixture: false,
      title: "PRIVATE-SYNTHETIC-SOURCE-" + index, sourceVersion: "synthetic-1",
      status: "unknown", topics: [],
    };
  });
  engine.workspace.restore(sources);
  engine.workspace.index.sessions = sources;
  engine.workspace.save(); engine.store.save();
  fixtureBindings.set(engine, new Map(sources.map(source => [source.id, engine.connector(engine.issueConnector(source.id).token)])));
  t.after(() => { assert.equal(engine.modelCalls, 0); assert.equal(engine.cache.size, 0); });
  return { engine, root, sources, ids: sources.map(source => source.id), makeEngine };
}

const binding = (engine, sessionId) => fixtureBindings.get(engine).get(sessionId);
function openRoom(engine, ids, extra = {}) {
  return engine.discussions.create({ title: "Shared synthetic workspace", sessionIds: ids, selfRegistration: true, ...extra });
}

test("nonmembers discover only eligible room metadata and obtain context only after joining", t => {
  const { engine, ids } = fixture(t);
  const room = openRoom(engine, ids.slice(0, 2));
  engine.discussions.create({ title: "Closed synthetic room", sessionIds: [ids[0]] });
  engine.discussions.post({ id: room.id, text: "PRIVATE-SYNTHETIC-ROOM-CONTEXT", deliveryId: "owner-opening-0001" });
  const caller = binding(engine, ids[2]), before = engine.discussions.group(room.id), aliases = before.members.map(member => member.alias);
  assert.throws(() => engine.discussions.context(room.id, caller), /participant/);
  assert.deepEqual(engine.discussions.discover({}, caller), []);
  const eligible = engine.discussions.discoverJoinable({ query: "Shared" }, caller);
  assert.deepEqual(eligible, [{ id: room.id, title: room.title, version: before.version }]);
  assert(!JSON.stringify(eligible).includes("PRIVATE-SYNTHETIC"));
  assert(!JSON.stringify(eligible).includes("nativeThreadId"));
  const grants = structuredClone(engine.store.data.grants), version = before.version;
  const result = engine.discussions.join({ id: room.id }, caller);
  assert.equal(result.id, room.id); assert.equal(result.alreadyMember, false);
  assert.equal(result.participantAlias, "codex2"); assert.equal(result.version, version + 1);
  assert(!JSON.stringify(result).includes("PRIVATE-SYNTHETIC"));
  assert.deepEqual(before.members.slice(0, 2).map(member => member.alias), aliases);
  assert.equal(engine.discussions.context(room.id, caller).messages[0].text, "PRIVATE-SYNTHETIC-ROOM-CONTEXT");
  assert.equal(engine.discussions.discover({}, caller)[0].participantAlias, "codex2");
  assert.deepEqual(engine.store.data.grants, grants, "joining never changes source grants");
  const again = engine.discussions.join({ id: room.id }, caller);
  assert.equal(again.alreadyMember, true); assert.equal(again.version, result.version);
  assert.equal(again.participantAlias, result.participantAlias); assert.equal(before.members.length, 3);
});

test("legacy rooms and owner-disabled admission remain closed", t => {
  const { engine, ids } = fixture(t), caller = binding(engine, ids[1]);
  const legacy = engine.discussions.create({ title: "Legacy room", sessionIds: [ids[0]] });
  assert.equal(legacy.policy.selfRegistration, false);
  assert.deepEqual(engine.discussions.discoverJoinable({}, caller), []);
  assert.throws(() => engine.discussions.join({ id: legacy.id }, caller));
  engine.discussions.setPolicy({ id: legacy.id, selfRegistration: true });
  assert.equal(engine.discussions.discoverJoinable({}, caller).length, 1);
  engine.discussions.setPolicy({ id: legacy.id, selfRegistration: false });
  assert.deepEqual(engine.discussions.discoverJoinable({}, caller), []);
  assert.throws(() => engine.discussions.join({ id: legacy.id }, caller));
  assert.equal(engine.discussions.group(legacy.id).members.length, 1);
});

test("join rechecks caller and existing member grants without promoting a denial", t => {
  for (const position of [0, 2]) for (const permission of ["enrolled", "retrieve", "share"]) {
    const { engine, ids } = fixture(t), room = openRoom(engine, ids.slice(0, 2)), caller = binding(engine, ids[2]);
    engine.grant(ids[position], { [permission]: false });
    const grants = structuredClone(engine.store.data.grants), version = engine.discussions.group(room.id).version;
    if (position === 2) assert.throws(() => engine.discussions.discoverJoinable({}, caller));
    else assert.deepEqual(engine.discussions.discoverJoinable({}, caller), []);
    assert.throws(() => engine.discussions.join({ id: room.id }, caller));
    assert.equal(engine.discussions.group(room.id).members.length, 2);
    assert.equal(engine.discussions.group(room.id).version, version);
    assert.deepEqual(engine.store.data.grants, grants);
  }
});

test("foreign account/scope, excluded host/path and stale identities cannot self-admit", t => {
  const mutations = [
    ({ sources }) => { sources[2].account = "another-account"; },
    ({ sources }) => { sources[2].scopeId = "another-scope"; },
    ({ sources }) => { sources[2].host = "ungranted-host"; },
    ({ sources }) => { sources[2].provider = "ungranted-provider"; },
    ({ sources }) => { sources[2].fixture = true; },
    ({ sources }) => { sources[2].cwd = null; },
    ({ engine }) => { engine.workspace.index.profile.active = false; },
    ({ engine, sources }) => { engine.workspace.index.profile.exclusions.local = [sources[2].cwd]; },
  ];
  for (const mutate of mutations) {
    const f = fixture(t), room = openRoom(f.engine, f.ids.slice(0, 2)), caller = binding(f.engine, f.ids[2]);
    mutate(f);
    assert.throws(() => f.engine.discussions.discoverJoinable({}, caller));
    assert.throws(() => f.engine.discussions.join({ id: room.id }, caller));
    assert.equal(f.engine.discussions.group(room.id).members.length, 2);
  }
  const f = fixture(t), room = openRoom(f.engine, f.ids.slice(0, 2)), caller = binding(f.engine, f.ids[2]);
  f.sources[0].nativeThreadId = "00000000-0000-4000-8000-000000000099";
  assert.deepEqual(f.engine.discussions.discoverJoinable({}, caller), []);
  assert.throws(() => f.engine.discussions.join({ id: room.id }, caller));
  assert.equal(f.engine.discussions.group(room.id).members.length, 2);
});

test("admission stops at two hundred members while repeated membership remains idempotent", t => {
  const { engine, ids } = fixture(t), room = openRoom(engine, ids.slice(0, 200));
  const original = engine.discussions.group(room.id).members.map(member => ({ sessionId: member.sessionId, alias: member.alias }));
  assert.throws(() => engine.discussions.join({ id: room.id }, binding(engine, ids[200])));
  assert.deepEqual(engine.discussions.discoverJoinable({}, binding(engine, ids[200])), []);
  const repeat = engine.discussions.join({ id: room.id }, binding(engine, ids[0]));
  assert.equal(repeat.alreadyMember, true); assert.equal(repeat.version, room.version);
  assert.deepEqual(engine.discussions.group(room.id).members.map(member => ({ sessionId: member.sessionId, alias: member.alias })), original);
});

test("the thirteenth eligible native source joins an open room without manual membership changes", t => {
  const { engine, ids } = fixture(t), room = openRoom(engine, ids.slice(0, 12));
  const joined = engine.discussions.join({ id: room.id }, binding(engine, ids[12]));
  assert.equal(joined.alreadyMember, false); assert.equal(joined.participantAlias, "codex7");
  assert.equal(engine.discussions.group(room.id).members.length, 13);
  assert.equal(engine.discussions.context(room.id, binding(engine, ids[12])).available, true);
});

test("a large native room can post its opening question without counting recipients as synthetic messages", t => {
  const { engine, ids } = fixture(t), room = openRoom(engine, ids.slice(0, 200), { agentInitiation: true });
  const posted = engine.discussions.post({ id: room.id, text: "Please share your current work.", deliveryId: "large-native-opening-0001" });
  assert.equal(posted.messages.length, 1); assert.equal(posted.messages[0].source, null);
  assert.equal(posted.messages[0].targets.length, 200);
  assert.equal(posted.messages[0].text, "Please share your current work.");
  assert.throws(() => engine.discussions.create({ title: "Too many native sources", sessionIds: ids.slice(0, 201) }), /distinct source threads/);
});

test("joining each provider preserves existing aliases and adds unique stable aliases", t => {
  const { engine, ids } = fixture(t), room = openRoom(engine, ids.slice(0, 2));
  const codex = engine.discussions.join({ id: room.id }, binding(engine, ids[2]));
  const claude = engine.discussions.join({ id: room.id }, binding(engine, ids[3]));
  const secondCodex = engine.discussions.join({ id: room.id }, binding(engine, ids[4]));
  assert.deepEqual([codex.participantAlias, claude.participantAlias, secondCodex.participantAlias], ["codex2", "claude2", "codex3"]);
  const members = engine.discussions.group(room.id).members;
  assert.deepEqual(members.slice(0, 2).map(member => member.alias), ["codex1", "claude1"]);
  assert.equal(new Set(members.map(member => member.alias)).size, members.length);
  const repeat = engine.discussions.join({ id: room.id }, binding(engine, ids[2]));
  assert.equal(repeat.version, secondCodex.version); assert.equal(repeat.participantAlias, "codex2");
});

test("self-registration policy changes independently preserve the initiation checkpoint", t => {
  const { engine, ids } = fixture(t);
  const room = engine.discussions.create({ title: "Independent policies", sessionIds: [ids[0]] });
  engine.discussions.post({ id: room.id, text: "Before activation", deliveryId: "policy-opening-0001" });
  engine.discussions.setPolicy({ id: room.id, agentInitiation: true });
  const group = engine.discussions.group(room.id), checkpoint = group.policy.agentInitiationFromMessage;
  engine.discussions.post({ id: room.id, text: "After activation", deliveryId: "policy-opening-0002" });
  const enabled = engine.discussions.setPolicy({ id: room.id, selfRegistration: true });
  assert.equal(enabled.policy.agentInitiation, true); assert.equal(enabled.policy.selfRegistration, true);
  assert.equal(enabled.policy.maxForwardHops, 8); assert.equal(group.policy.agentInitiationFromMessage, checkpoint);
  const version = group.version;
  engine.discussions.setPolicy({ id: room.id, selfRegistration: true });
  assert.equal(group.version, version);
  engine.discussions.setPolicy({ id: room.id, selfRegistration: false });
  assert.equal(group.policy.agentInitiationFromMessage, checkpoint); assert.equal(group.policy.agentInitiation, true);
  engine.discussions.setPolicy({ id: room.id, agentInitiation: false });
  assert.equal(group.policy.selfRegistration, false);
  assert.throws(() => engine.discussions.setPolicy({ id: room.id, selfRegistration: true }, binding(engine, ids[0])), /owner/);
  assert.throws(() => engine.discussions.setPolicy({ id: room.id, agentInitiation: true }, binding(engine, ids[0])), /owner/);
  assert.throws(() => engine.discussions.setPolicy({ id: room.id, selfRegistration: "true" }));
  assert.throws(() => engine.discussions.setPolicy({ id: room.id }));
});

test("a source creates a group with known peers under its bound identity and enabled policies", t => {
  const { engine, ids } = fixture(t), creator = binding(engine, ids[2]);
  const grants = structuredClone(engine.store.data.grants);
  const room = engine.discussions.createFor({ title: "Agents share work", sessionIds: [ids[0], ids[1]], deliveryId: "agent-create-0001" }, creator);
  assert.deepEqual(new Set(room.members.map(member => member.sessionId)), new Set([ids[2], ids[0], ids[1]]));
  assert.equal(room.members.filter(member => member.sessionId === creator.sessionId).length, 1);
  assert.equal(room.policy.agentInitiation, true); assert.equal(room.policy.selfRegistration, true);
  assert.equal(engine.discussions.context(room.id, creator).available, true);
  assert.deepEqual(room.messages, []); assert.deepEqual(engine.store.data.grants, grants);
});

test("stable agent creation receipts survive restart and conflicting reuse is rejected", t => {
  const { engine, ids, makeEngine } = fixture(t), creator = binding(engine, ids[2]);
  const args = { title: "Stable agent group", sessionIds: [ids[0], ids[1]], deliveryId: "stable-agent-create-0001" };
  const room = engine.discussions.createFor(args, creator), version = engine.discussions.group(room.id).version;
  assert.equal(engine.discussions.createFor(args, creator).id, room.id);
  assert.equal(engine.store.data.discussions.length, 1); assert.equal(engine.discussions.group(room.id).version, version);
  const restarted = makeEngine();
  assert.equal(restarted.discussions.createFor(args, creator).id, room.id);
  assert.equal(restarted.store.data.discussions.length, 1);
  for (const extra of [{ title: "Different title" }, { sessionIds: [ids[3]] }]) {
    assert.throws(() => restarted.discussions.createFor({ ...args, ...extra }, creator));
    assert.equal(restarted.store.data.discussions.length, 1);
  }
  assert.equal(restarted.modelCalls, 0); assert.equal(restarted.cache.size, 0);
});

test("creation receipt is durable in the first save when a process stops before returning", t => {
  const { engine, ids, makeEngine } = fixture(t), creator = binding(engine, ids[2]);
  const args = { title: "Interrupted agent group", sessionIds: [ids[0], ids[1]], deliveryId: "interrupted-agent-create-0001" };
  const save = engine.store.save.bind(engine.store);
  let saves = 0;
  engine.store.save = () => {
    save(); saves++;
    throw new Error("Synthetic process stop immediately after first durable save");
  };
  assert.throws(() => engine.discussions.createFor(args, creator), /Synthetic process stop/);
  engine.store.save = save;
  assert.equal(saves, 1);
  const restarted = makeEngine();
  assert.equal(restarted.store.data.discussions.length, 1);
  const persisted = restarted.store.data.discussions[0];
  assert.equal(persisted.creation.sessionId, creator.sessionId);
  assert.equal(persisted.creation.deliveryId, args.deliveryId);
  const recovered = restarted.discussions.createFor(args, creator);
  assert.equal(recovered.id, persisted.id);
  assert.equal(restarted.store.data.discussions.length, 1);
  assert.equal(recovered.version, persisted.version);
  assert.equal(restarted.modelCalls, 0); assert.equal(restarted.cache.size, 0);
});

test("agent creation rejects unknown, revoked, foreign or unbounded peer selections before writing", t => {
  const invalid = [
    ({ ids }) => ({ sessionIds: [] }),
    ({ ids }) => ({ sessionIds: [ids[0], ids[0]] }),
    ({ ids }) => ({ sessionIds: ids.slice(0, 12) }),
    () => ({ sessionIds: ["unknown-source"] }),
    () => ({ title: "" }),
    () => ({ title: "x".repeat(81) }),
    () => ({ deliveryId: "bad" }),
  ];
  for (const override of invalid) {
    const f = fixture(t), args = { title: "Rejected agent group", sessionIds: [f.ids[0]], deliveryId: "rejected-agent-create-0001", ...override(f) };
    assert.throws(() => f.engine.discussions.createFor(args, binding(f.engine, f.ids[13])));
    assert.equal(f.engine.store.data.discussions.length, 0);
  }
  for (const mutate of [
    ({ engine, ids }) => engine.grant(ids[0], { share: false }),
    ({ engine, ids }) => engine.grant(ids[2], { retrieve: false }),
    ({ sources }) => { sources[0].account = "foreign-account"; },
    ({ sources }) => { sources[0].scopeId = "foreign-scope"; },
    ({ sources }) => { sources[0].host = "foreign-host"; },
    ({ sources }) => { sources[0].fixture = true; },
  ]) {
    const f = fixture(t); mutate(f);
    assert.throws(() => f.engine.discussions.createFor({ title: "Denied agent group", sessionIds: [f.ids[0]], deliveryId: "denied-agent-create-0001" }, binding(f.engine, f.ids[2])));
    assert.equal(f.engine.store.data.discussions.length, 0);
  }
});

test("creation replay rechecks grants and cannot restore revoked participation", t => {
  const { engine, ids } = fixture(t), creator = binding(engine, ids[2]);
  const args = { title: "Revoked agent group", sessionIds: [ids[0]], deliveryId: "revoked-agent-create-0001" };
  const room = engine.discussions.createFor(args, creator);
  engine.grant(ids[0], { share: false });
  assert.throws(() => engine.discussions.createFor(args, creator));
  assert.throws(() => engine.discussions.context(room.id, creator));
  assert.equal(engine.store.data.discussions.length, 1);
  assert.equal(engine.store.data.grants[ids[0]].share, false);
});

test("bound admission and creation require a source binding and bounded metadata queries", t => {
  const { engine, ids } = fixture(t), room = openRoom(engine, [ids[0]]);
  assert.throws(() => engine.discussions.discoverJoinable({}, null));
  assert.throws(() => engine.discussions.discoverJoinable({ query: "x".repeat(201) }, binding(engine, ids[1])));
  assert.throws(() => engine.discussions.join({ id: room.id }, null));
  assert.throws(() => engine.discussions.join({ id: "unknown-discussion" }, binding(engine, ids[1])));
  assert.throws(() => engine.discussions.createFor({ title: "Unbound creation", sessionIds: [ids[0]], deliveryId: "unbound-create-0001" }, null));
  assert.equal(engine.store.data.discussions.length, 1);
});

test("a room member invites a known peer without minting capabilities or replaying messages", t => {
  const { engine, ids, makeEngine } = fixture(t), room = openRoom(engine, ids.slice(0, 2), { agentInitiation: true });
  engine.discussions.post({ id: room.id, text: "PRIVATE-SYNTHETIC-PRE-INVITATION", deliveryId: "before-invitation-0001" });
  const group = engine.discussions.group(room.id), caller = binding(engine, ids[0]);
  const messages = structuredClone(group.messages), grants = structuredClone(engine.store.data.grants);
  const connectors = structuredClone(engine.store.data.connectors), version = group.version;
  const invited = engine.discussions.invite({ id: room.id, sessionId: ids[2], invitedBy: ids[3] }, caller);
  assert.deepEqual(invited, {
    id: room.id, title: room.title, version: version + 1, participantAlias: "codex2",
    sessionId: ids[2], alreadyMember: false, invitedBy: caller.sessionId,
  });
  assert(!JSON.stringify(invited).includes("PRIVATE-SYNTHETIC"));
  assert.equal(engine.discussions.context(room.id, binding(engine, ids[2])).available, true);
  assert.deepEqual(group.members.slice(0, 2).map(member => member.alias), ["codex1", "claude1"]);
  assert.deepEqual(group.messages, messages, "existing messages and delivery targets are untouched");
  assert.deepEqual(engine.store.data.connectors, connectors, "an invitation mints no target connector");
  assert.deepEqual(engine.store.data.grants, grants);
  const repeat = engine.discussions.invite({ id: room.id, sessionId: ids[2] }, caller);
  assert.equal(repeat.alreadyMember, true); assert.equal(repeat.version, invited.version);
  assert.equal(repeat.participantAlias, invited.participantAlias); assert.equal(group.members.length, 3);
  const restarted = makeEngine(), recovered = restarted.discussions.invite({ id: room.id, sessionId: ids[2] }, caller);
  assert.equal(recovered.alreadyMember, true); assert.equal(recovered.version, invited.version);
  assert.equal(recovered.participantAlias, invited.participantAlias);
  assert.equal(restarted.discussions.group(room.id).members.length, 3);
  assert.equal(restarted.modelCalls, 0); assert.equal(restarted.cache.size, 0);
});

test("invitations require a current room member and owner-enabled admission", t => {
  const { engine, ids } = fixture(t), open = openRoom(engine, ids.slice(0, 2));
  const closed = engine.discussions.create({ title: "Closed invitations", sessionIds: [ids[0]] });
  const caller = binding(engine, ids[0]);
  assert.throws(() => engine.discussions.invite({ id: open.id, sessionId: ids[2] }, binding(engine, ids[3])), /participant/);
  assert.throws(() => engine.discussions.invite({ id: open.id, sessionId: ids[2] }, null));
  assert.throws(() => engine.discussions.invite({ id: closed.id, sessionId: ids[2] }, caller), /self-registration/);
  engine.discussions.setPolicy({ id: open.id, selfRegistration: false });
  assert.throws(() => engine.discussions.invite({ id: open.id, sessionId: ids[2] }, caller), /self-registration/);
  assert.equal(engine.discussions.group(open.id).members.length, 2);
  assert.equal(engine.discussions.group(closed.id).members.length, 1);
  engine.discussions.setPolicy({ id: open.id, selfRegistration: true });
  engine.grant(ids[0], { share: false });
  assert.throws(() => engine.discussions.invite({ id: open.id, sessionId: ids[2] }, caller));
  assert.equal(engine.discussions.group(open.id).members.length, 2);
});

test("invitation preserves target refusals and rejects foreign or noncanonical native identities", t => {
  const mutations = [
    ({ engine, ids }) => engine.grant(ids[2], { enrolled: false }),
    ({ engine, ids }) => engine.grant(ids[2], { retrieve: false }),
    ({ engine, ids }) => engine.grant(ids[2], { share: false }),
    ({ sources }) => { sources[2].account = "foreign-account"; },
    ({ sources }) => { sources[2].scopeId = "foreign-scope"; },
    ({ sources }) => { sources[2].host = "foreign-host"; },
    ({ sources }) => { sources[2].provider = "foreign-provider"; },
    ({ sources }) => { sources[2].fixture = true; },
    ({ sources }) => { sources[2].nativeThreadId = "00000000-0000-4000-8000-000000000099"; },
    ({ sources }) => { sources[2].cwd = null; },
    ({ engine, sources }) => { engine.workspace.index.profile.exclusions.local = [sources[2].cwd]; },
  ];
  for (const mutate of mutations) {
    const f = fixture(t), room = openRoom(f.engine, f.ids.slice(0, 2)), caller = binding(f.engine, f.ids[0]);
    mutate(f);
    const grants = structuredClone(f.engine.store.data.grants), connectors = structuredClone(f.engine.store.data.connectors);
    assert.throws(() => f.engine.discussions.invite({ id: room.id, sessionId: f.ids[2] }, caller));
    assert.equal(f.engine.discussions.group(room.id).members.length, 2);
    assert.equal(f.engine.discussions.group(room.id).version, room.version);
    assert.deepEqual(f.engine.store.data.grants, grants); assert.deepEqual(f.engine.store.data.connectors, connectors);
  }
  const { engine, ids, sources } = fixture(t), room = openRoom(engine, ids.slice(0, 2)), caller = binding(engine, ids[0]);
  for (const sessionId of ["unknown-source", sources[2].nativeThreadId, "", "x".repeat(301)]) {
    assert.throws(() => engine.discussions.invite({ id: room.id, sessionId }, caller));
  }
  assert.equal(engine.discussions.group(room.id).members.length, 2);
});

test("invitations refuse a two-hundred-and-first source but preserve repeat membership at capacity", t => {
  const { engine, ids } = fixture(t), room = openRoom(engine, ids.slice(0, 200)), caller = binding(engine, ids[0]);
  assert.throws(() => engine.discussions.invite({ id: room.id, sessionId: ids[200] }, caller));
  const repeated = engine.discussions.invite({ id: room.id, sessionId: ids[1] }, caller);
  assert.equal(repeated.alreadyMember, true); assert.equal(repeated.participantAlias, "claude1");
  assert.equal(repeated.sessionId, ids[1]); assert.equal(repeated.version, room.version);
  assert.equal(engine.discussions.group(room.id).members.length, 200);
});

test("invitations and self-joins allocate stable aliases through the same admission path", t => {
  const { engine, ids } = fixture(t), room = openRoom(engine, ids.slice(0, 2)), caller = binding(engine, ids[0]);
  const invitedCodex = engine.discussions.invite({ id: room.id, sessionId: ids[2] }, caller);
  const invitedClaude = engine.discussions.invite({ id: room.id, sessionId: ids[3] }, caller);
  const joinedCodex = engine.discussions.join({ id: room.id }, binding(engine, ids[4]));
  assert.deepEqual([invitedCodex.participantAlias, invitedClaude.participantAlias, joinedCodex.participantAlias], ["codex2", "claude2", "codex3"]);
  const group = engine.discussions.group(room.id);
  assert.equal(new Set(group.members.map(member => member.alias)).size, group.members.length);
  engine.grant(ids[2], { retrieve: false });
  assert.throws(() => engine.discussions.invite({ id: room.id, sessionId: ids[2] }, caller));
  assert.equal(group.members.length, 5); assert.equal(group.version, joinedCodex.version);
});

test("an eligible first context request joins its open room and repeated reads do not mutate it", t => {
  const { engine, ids } = fixture(t), room = openRoom(engine, ids.slice(0, 2), { agentInitiation: true });
  engine.discussions.post({ id: room.id, text: "PRIVATE-SYNTHETIC-CONTEXT-BEFORE-FIRST-READ", deliveryId: "before-first-read-0001" });
  const group = engine.discussions.group(room.id), caller = binding(engine, ids[2]);
  const messages = structuredClone(group.messages), grants = structuredClone(engine.store.data.grants);
  const connectors = structuredClone(engine.store.data.connectors), version = group.version;
  assert.throws(() => engine.discussions.context(room.id, caller), /participant/);
  assert.deepEqual(engine.discussions.discover({}, caller), []);
  assert.equal(engine.discussions.discoverJoinable({}, caller).length, 1);
  assert.equal(group.members.length, 2, "discovery and ordinary context never silently join rooms");
  const context = engine.discussions.contextOrJoin(room.id, caller);
  assert.equal(context.available, true); assert.equal(context.version, version + 1);
  assert.equal(context.messages[0].text, messages[0].text);
  assert.equal(context.members.find(member => member.sessionId === ids[2]).alias, "codex2");
  assert.equal(group.members.length, 3);
  assert.deepEqual(group.messages, messages, "reading creates no new message or delivery allocation");
  assert.deepEqual(engine.store.data.grants, grants); assert.deepEqual(engine.store.data.connectors, connectors);
  const repeated = engine.discussions.contextOrJoin(room.id, caller);
  assert.equal(repeated.version, context.version); assert.equal(group.members.length, 3);
  assert.deepEqual(group.messages, messages);
});

test("first context requests leave closed, full and ineligible rooms unchanged", t => {
  const { engine, ids } = fixture(t), caller = binding(engine, ids[2]);
  const closed = engine.discussions.create({ title: "Closed first read", sessionIds: ids.slice(0, 2) });
  assert.throws(() => engine.discussions.contextOrJoin(closed.id, caller), /participant/);
  assert.equal(engine.discussions.group(closed.id).members.length, 2);
  const full = openRoom(engine, ids.slice(0, 200));
  assert.throws(() => engine.discussions.contextOrJoin(full.id, binding(engine, ids[200])));
  assert.equal(engine.discussions.group(full.id).members.length, 200);
  for (const mutate of [
    ({ engine, ids }) => engine.grant(ids[2], { enrolled: false }),
    ({ engine, ids }) => engine.grant(ids[2], { retrieve: false }),
    ({ engine, ids }) => engine.grant(ids[2], { share: false }),
    ({ engine, ids }) => engine.grant(ids[0], { share: false }),
    ({ sources }) => { sources[2].account = "foreign-account"; },
    ({ sources }) => { sources[2].scopeId = "foreign-scope"; },
    ({ sources }) => { sources[0].nativeThreadId = "00000000-0000-4000-8000-000000000099"; },
    ({ engine }) => { engine.workspace.index.profile.active = false; },
  ]) {
    const f = fixture(t), room = openRoom(f.engine, f.ids.slice(0, 2)), bound = binding(f.engine, f.ids[2]);
    mutate(f);
    const grants = structuredClone(f.engine.store.data.grants), connectors = structuredClone(f.engine.store.data.connectors);
    assert.throws(() => f.engine.discussions.contextOrJoin(room.id, bound));
    assert.equal(f.engine.discussions.group(room.id).members.length, 2);
    assert.equal(f.engine.discussions.group(room.id).version, room.version);
    assert.deepEqual(f.engine.store.data.grants, grants); assert.deepEqual(f.engine.store.data.connectors, connectors);
  }
});
