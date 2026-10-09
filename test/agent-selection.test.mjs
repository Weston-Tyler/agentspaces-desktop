import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../app/store.mjs";
import { Engine } from "../app/engine.mjs";
import { parseAgentSelectors, selectAgents, selectAgentsForOwner } from "../app/agent-selection.mjs";

const uuid = index => "00000000-0000-4000-8000-" + String(index).padStart(12, "0");
const NOW = Date.parse("2026-10-09T14:00:00Z"), DAY = 86400000;
function fixture(t, count = 5) {
  const root = mkdtempSync(join(tmpdir(), "as-agent-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const engine = new Engine(new Store(root), { diagnostics: () => ({ status: "synthetic-disconnected" }), close() {} }, {
    clock: () => NOW, nativeFactory() { throw new Error("Selector fixtures permit no native or model call"); },
  });
  engine.workspace.index = { schema: 1, fixture: false,
    profile: { id: "synthetic-selection-scope", account: "synthetic-owner", active: true, policy: "local-retrieval", hosts: ["local", "remote"],
      providers: ["codex", "claude"], roots: {}, exclusions: {}, indexFiles: false },
    nodes: [], edges: [], sessions: [], coverage: [], errors: [] };
  const makeSource = (index, extra = {}) => {
    const provider = index % 2 ? "codex" : "claude", host = index % 2 ? "local" : "remote";
    return { id: provider + "@" + host + ":" + uuid(index), nativeThreadId: uuid(index), provider, host,
      account: "synthetic-owner", scopeId: "synthetic-selection-scope", fixture: false, cwd: "/fictional/work",
      title: "Chillit recipe " + index, topics: ["cooking", "synthetic"], status: "unknown", sourceVersion: "synthetic-v1",
      updatedAt: new Date(NOW - index * DAY).toISOString(), ...extra };
  };
  const sources = Array.from({ length: count }, (_, index) => makeSource(index + 1));
  engine.workspace.restore(sources); engine.workspace.index.sessions = sources;
  const caller = sources[0], binding = { sessionId: caller.id, account: caller.account, project: caller.project, scopeId: caller.scopeId };
  t.after(() => { assert.equal(engine.modelCalls, 0); assert.equal(engine.cache.size, 0); });
  return { engine, sources, binding, makeSource };
}

test("metadata selector finds topical peers, preserves provenance and changes no records", t => {
  const { engine, binding, sources } = fixture(t);
  sources[1].title = "A CHILLIT RECIPE review";
  sources[2].title = "An unrelated soup recipe";
  sources[3].title = "Chillit deployment";
  sources[4].title = "Something else"; sources[4].topics = ["chillit recipe"];
  const before = JSON.stringify({ catalog: engine.catalog, data: engine.store.data, workspace: engine.workspace.index });
  const result = selectAgents(engine, binding, { query: '"chillit recipe"' });
  assert.deepEqual(result.matches.map(source => source.id), [sources[1].id, sources[4].id]);
  assert.equal(result.matchedCount, 2); assert.equal(result.omitted.caller, 1); assert.equal(result.omitted.queryMismatch, 2);
  assert.deepEqual(result.matches[0], sources[1]); assert.notEqual(result.matches[0], sources[1]);
  assert.equal(result.matches[0].sourceVersion, "synthetic-v1"); assert.equal(result.coverage.metadataOnly, true);
  assert.equal(JSON.stringify({ catalog: engine.catalog, data: engine.store.data, workspace: engine.workspace.index }), before);
});

test("keyword terms intersect, quoted phrases are exact, and native IDs/cwd/topics can match", t => {
  const { engine, binding, sources } = fixture(t);
  sources[1].title = "Recipe for chillit";
  assert(selectAgents(engine, binding, { query: "chillit recipe" }).matches.some(source => source.id === sources[1].id));
  assert(!selectAgents(engine, binding, { query: '"chillit recipe"' }).matches.some(source => source.id === sources[1].id));
  assert.equal(selectAgents(engine, binding, { query: sources[2].nativeThreadId }).matches[0].id, sources[2].id);
  assert.equal(selectAgents(engine, binding, { query: "fictional cooking" }).matchedCount, 4);
  assert.equal(selectAgents(engine, binding, { query: "recipe totally-absent" }).matchedCount, 0);
});

test("recency uses the engine clock, includes the boundary and intersects topics", t => {
  const { engine, binding, sources } = fixture(t, 6);
  sources[1].updatedAt = new Date(NOW - 30 * DAY).toISOString();
  sources[2].updatedAt = new Date(NOW - 30 * DAY - 1).toISOString();
  sources[3].updatedAt = new Date(NOW + 1).toISOString();
  delete sources[4].updatedAt;
  sources[5].title = "Something unrelated";
  const result = selectAgents(engine, binding, { activeWithinDays: 30, query: "chillit" });
  assert.deepEqual(result.matches.map(source => source.id), [sources[1].id]);
  assert.equal(result.omitted.outsideActivityWindow, 1); assert.equal(result.omitted.futureActivity, 1);
  assert.equal(result.omitted.unknownActivity, 1); assert.equal(result.omitted.queryMismatch, 1);
  assert.equal(result.coverage.asOf, "2026-10-09T14:00:00.000Z");
});

test("native activity accepts epoch seconds/milliseconds and ISO source versions with offsets", t => {
  const { engine, binding, sources } = fixture(t, 7);
  for (const source of sources.slice(1)) delete source.updatedAt;
  sources[1].sourceVersion = String((NOW - 2 * DAY) / 1000);
  sources[2].sourceVersion = NOW - 3 * DAY;
  sources[3].sourceVersion = "2026-10-09T07:00:00-04:00";
  sources[4].sourceVersion = "revision-1717171717171";
  sources[5].sourceVersion = "1";
  sources[6].updatedAt = "2026-10-09 12:00:00";
  const result = selectAgents(engine, binding, { activeWithinDays: 30 });
  assert.deepEqual(result.matches.map(source => source.id), sources.slice(1, 4).map(source => source.id));
  assert.equal(result.omitted.unknownActivity, 3);
  assert.equal(selectAgents(engine, binding).matchedCount, 6, "Unknown activity is excluded only for a requested date filter");
});

test("native IDs and source IDs union, deduplicate, omit the caller and intersect filters", t => {
  const { engine, binding, sources } = fixture(t);
  engine.catalog.push({ ...sources[1] });
  sources[3].title = "An unrelated thread";
  const result = selectAgents(engine, binding, { sessionIds: [sources[0].id, sources[1].id, sources[1].id],
    nativeThreadIds: [sources[1].nativeThreadId, sources[2].nativeThreadId.toUpperCase(), sources[3].nativeThreadId], query: "chillit", activeWithinDays: 30 });
  assert.deepEqual(result.matches.map(source => source.id), [sources[1].id, sources[2].id]);
  assert.equal(result.omitted.duplicates, 1); assert.equal(result.omitted.caller, 1);
  assert.equal(result.omitted.queryMismatch, 1);
});

test("ambiguous native UUIDs require a precise provider/host source identity", t => {
  const { engine, binding, sources } = fixture(t);
  const duplicate = { ...sources[1], provider: "codex", host: "local", id: "codex@local:" + sources[1].nativeThreadId };
  engine.workspace.restore([duplicate]);
  const result = selectAgents(engine, binding, { nativeThreadIds: [sources[1].nativeThreadId] });
  assert.deepEqual(result.matches, []); assert.equal(result.omitted.ambiguousNativeThreadIds, 1);
  assert.deepEqual(selectAgents(engine, binding, { sessionIds: [sources[1].id] }).matches.map(source => source.id), [sources[1].id]);
});

test("current grants and account/scope identity are checked without exposing denied source records", t => {
  const { engine, binding, sources } = fixture(t, 8);
  engine.store.data.grants[sources[1].id] = { enrolled: false };
  engine.store.data.grants[sources[2].id] = { share: false };
  engine.store.data.grants[sources[3].id] = { retrieve: false };
  sources[4].scopeId = "outside-scope"; sources[4].project = "outside-project";
  sources[5].account = "another-account";
  sources[6].id = "forged-native-id";
  sources[7].fixture = true;
  const result = selectAgents(engine, binding);
  assert.deepEqual(result.matches, []); assert.equal(result.omitted.unavailable, 3);
  assert.equal(result.omitted.outsideBoundary, 2); assert.equal(result.omitted.nonNative, 2);
  assert(!JSON.stringify(result).includes("another-account")); assert(!JSON.stringify(result).includes("outside-project"));
});

test("scope revocation, exclusions and connector drift are never repaired by selection", t => {
  for (const change of [
    f => { f.engine.workspace.index.profile.active = false; },
    f => { f.engine.store.data.grants[f.sources[0].id] = { share: false }; },
    f => { f.binding.account = "forged-account"; },
    f => { f.sources[0].nativeThreadId = uuid(99); },
  ]) {
    const f = fixture(t); change(f);
    const before = JSON.stringify(f.engine.store.data);
    assert.throws(() => selectAgents(f.engine, f.binding));
    assert.equal(JSON.stringify(f.engine.store.data), before);
  }
  const f = fixture(t); f.sources[1].cwd = "/fictional/excluded";
  f.engine.workspace.index.profile.exclusions.remote = ["/fictional/excluded"];
  assert(!selectAgents(f.engine, f.binding).matches.some(source => source.id === f.sources[1].id));
});

test("project-only participants select only currently permitted sources in that project", t => {
  const { engine, binding, sources } = fixture(t);
  for (const source of sources) {
    delete source.scopeId; source.project = sources[0].project;
    engine.store.data.grants[source.id] = { enrolled: true, share: true, retrieve: true };
  }
  delete binding.scopeId;
  sources[3].project = "different-project";
  const result = selectAgents(engine, binding);
  assert.deepEqual(result.matches.map(source => source.id), [sources[1].id, sources[2].id, sources[4].id]);
});

test("lookup/result caps report omissions and never imply complete inventory", t => {
  const { engine, binding, sources } = fixture(t, 206);
  let lookups = 0;
  const originalSession = engine.session.bind(engine);
  engine.session = id => { lookups++; return originalSession(id); };
  engine.workspace.index.stale = true;
  const result = selectAgents(engine, binding, { limit: 11 });
  assert.equal(result.matches.length, 11); assert.equal(result.matchedCount, 200);
  assert.equal(result.omitted.lookupLimit, 5); assert.equal(result.omitted.resultLimit, 189);
  assert.equal(result.coverage.lookedUp, 200); assert.equal(result.coverage.lookupTruncated, true);
  assert.equal(result.coverage.resultTruncated, true); assert.equal(result.coverage.snapshotStale, true);
  assert.equal(result.coverage.catalogCompleteness, "not-established");
  assert(lookups <= 401, "At most 200 candidates checked through existing source and sharing checks, plus caller");
  assert.equal(selectAgents(engine, binding, { sessionIds: [sources[205].id] }).matches[0].id, sources[205].id,
    "Explicit targets beyond a broad selection page remain addressable");
});

test("invalid selector options cannot broaden recipient sets", t => {
  const { engine, binding } = fixture(t);
  for (const input of [null, [], { requesterId: "forged" }, { sessionIds: [] }, { nativeThreadIds: ["bad-id"] }, { limit: 201 },
    { limit: 0 }, { activeWithinDays: -1 }, { activeWithinDays: 0.5 }, { query: '"broken phrase' }, { query: "x".repeat(501) }]) {
    assert.throws(() => selectAgents(engine, binding, input), { code: "bounded_agent_selection_required" });
  }
});

test("topic/date filtering searches beyond the first catalog page before checking source grants", t => {
  const { engine, binding, sources } = fixture(t, 260);
  for (const source of sources) { source.title = "Unrelated historical work"; source.updatedAt = new Date(NOW - 40 * DAY).toISOString(); }
  for (const source of sources.slice(251)) { source.title = "Chillit recipe review"; source.updatedAt = new Date(NOW - DAY).toISOString(); }
  engine.store.data.grants[sources[253].id] = { share: false };
  const result = selectAgents(engine, binding, { query: '"chillit recipe"', activeWithinDays: 30 });
  assert.deepEqual(result.matches.map(source => source.id), sources.slice(251).filter(source => source !== sources[253]).map(source => source.id));
  assert.equal(result.coverage.catalogCandidateCount, 259); assert.equal(result.coverage.candidateCount, 9);
  assert.equal(result.coverage.lookedUp, 9); assert.equal(result.coverage.lookupTruncated, false);
  assert.equal(result.omitted.unavailable, 1); assert.equal(result.omitted.outsideActivityWindow, 250);
});

test("authenticated owner selection keeps native peers as recipients without impersonating one", t => {
  const { engine, sources } = fixture(t);
  engine.discussions.participant = () => { throw new Error("An owner selection must never fabricate a native participant binding"); };
  engine.store.data.grants[sources[2].id] = { share: false };
  sources[3].updatedAt = new Date(NOW - 40 * DAY).toISOString();
  const boundary = { account: sources[0].account, scopeId: sources[0].scopeId, project: sources[0].project };
  const result = selectAgentsForOwner(engine, { query: "chillit recipe", activeWithinDays: 30 }, boundary);
  assert.deepEqual(result.matches.map(source => source.id), [sources[0].id, sources[1].id, sources[4].id]);
  assert.equal(result.omitted.caller, 0); assert.equal(result.omitted.unavailable, 1); assert.equal(result.omitted.outsideActivityWindow, 1);
  for (const changed of [undefined, {}, { account: "forged", scopeId: boundary.scopeId }, { ...boundary, callerId: sources[0].id }, { account: boundary.account, scopeId: "revoked-scope" }])
    assert.throws(() => selectAgentsForOwner(engine, {}, changed), { code: "current_owner_selection_boundary_required" });
  engine.workspace.index.profile.active = false;
  assert.throws(() => selectAgentsForOwner(engine, {}, boundary), { code: "current_owner_selection_boundary_required" });
});

test("owner project-only selection respects account and source grant boundaries", t => {
  const { engine, sources } = fixture(t);
  const project = sources[0].project;
  for (const source of sources) {
    delete source.scopeId; source.project = project;
    engine.store.data.grants[source.id] = { enrolled: true, share: true, retrieve: true };
  }
  sources[3].account = "another-account";
  engine.store.data.grants[sources[4].id].retrieve = false;
  const result = selectAgentsForOwner(engine, {}, { account: sources[0].account, project });
  assert.deepEqual(result.matches.map(source => source.id), sources.slice(0, 3).map(source => source.id));
  assert.equal(result.omitted.outsideBoundary, 1); assert.equal(result.omitted.unavailable, 1);
  assert.throws(() => selectAgentsForOwner(engine, {}, { account: "another-account", project }), { code: "current_owner_selection_boundary_required" });
});

test("human directives extract multiple thread IDs, date/topic criteria and preserve original audit text", () => {
  const input = `@all @codex2 @recent(30d) @topic("chillit recipe") @thread(${uuid(2)}) @thread(${uuid(3)}) Please update the table.`;
  const parsed = parseAgentSelectors(input);
  assert.equal(parsed.originalText, input); assert.equal(parsed.text, "@codex2 Please update the table.");
  assert.deepEqual(parsed.criteria, { all: true, activeWithinDays: 30, query: '"chillit recipe"', nativeThreadIds: [uuid(2), uuid(3)] });
  assert.equal(parsed.directives.length, 5); assert.equal(parsed.directives[2].raw, '@topic("chillit recipe")');
});

test("repeated filters intersect and thread directives deduplicate; ordinary aliases/email remain text", () => {
  const parsed = parseAgentSelectors(`@recent(30d) @recent(7d) @topic("chillit recipe") @topic("cooking") @thread(${uuid(2)}) @thread(${uuid(2)}) Share context with @claude1. sender@all.example`);
  assert.deepEqual(parsed.criteria, { activeWithinDays: 7, query: '"chillit recipe" "cooking"', nativeThreadIds: [uuid(2)] });
  assert.equal(parsed.text, "Share context with @claude1. sender@all.example");
  assert.deepEqual(parseAgentSelectors("@codex1 hello").criteria, {});
  assert.equal(parseAgentSelectors("Hello\n\n@topic(\"chillit recipe\")\nrespond.").text, "Hello\n\n\nrespond.");
  assert.equal(parseAgentSelectors('@topic("quoted \\"word\\" topic") Say hello.').criteria.query, '"quoted \\"word\\" topic"');
});

test("malformed reserved directives fail visibly without turning into broadcasts", () => {
  for (const text of ["@recent(0d) Hello", "@recent(3651d)", "@recent(thirty days)", "@topic()", '@topic("broken)', '@topic(" ")', "@thread(wrong-id)", '@topic("' + "x".repeat(501) + '")'])
    assert.throws(() => parseAgentSelectors(text), { code: "bounded_agent_selector_text_required" });
  assert.throws(() => parseAgentSelectors(null), { code: "bounded_agent_selector_text_required" });
});
