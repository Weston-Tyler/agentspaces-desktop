import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../app/store.mjs";
import { Engine } from "../app/engine.mjs";
import { FabricAdapter } from "../app/fabric.mjs";
import { recordUsage, usageSummary } from "../app/usage.mjs";
import { ExecutionGate } from "../app/controller.mjs";
const make = (options) => {
  const root = mkdtempSync(join(tmpdir(), "as-desktop-"));
  const store = new Store(root);
  return new Engine(store, new FabricAdapter({ stateRoot: root }), options);
};
function grant(e, source = "sample-codex-old", target = "sample-codex-new") {
  e.grant(source, { enrolled: true, content: true, share: true });
  e.grant(target, { enrolled: true, retrieve: true });
}
test("startup contains no sample sessions or model activity", () => {
  const e = make();
  assert.equal(e.snapshot().sessions.length, 0);
  assert.equal(e.modelCalls, 0);
  assert.equal(e.fabric.status, "disconnected");
});
test("metadata search rediscovers archived same-tool work without content access", () => {
  const e = make();
  e.loadSample();
  const rows = e.discover({
    query: "retry",
    provider: "codex",
    status: "archived",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "sample-codex-old");
  assert.equal(rows[0].grants.content, undefined);
  assert.equal(e.cache.size, 0);
});
test("another account/project metadata is not disclosed", () => {
  const e = make();
  e.loadSample();
  assert.ok(!e.discover().some((s) => s.id === "sample-denied"));
  assert.throws(() => e.session("sample-denied"), /not granted/);
});
test("content read requires source enrollment and separate grant", async () => {
  const e = make();
  e.loadSample();
  await assert.rejects(e.finding("sample-codex-old"), /content grant/);
  assert.throws(() => e.grant("sample-codex-old", { content: true }), /Enroll/);
});
test("same-tool retrieval preserves source version/digest and invokes no inference", async () => {
  const e = make();
  e.loadSample();
  grant(e);
  const f = await e.retrieve({
    sourceId: "sample-codex-old",
    requesterId: "sample-codex-new",
  });
  assert.equal(f.handoff.relation, "same-tool");
  assert.equal(f.source.threadId, "sample-codex-old");
  assert.match(f.artifact.digest, /^[a-f0-9]{64}$/);
  assert.equal(f.handoff.modelCalls, 0);
  assert.equal(e.modelCalls, 0);
  assert.equal(f.fixture, true);
});
test("cross-tool retrieval retains provenance", async () => {
  const e = make();
  e.loadSample();
  grant(e, "sample-codex-old", "sample-claude-new");
  const f = await e.retrieve({
    sourceId: "sample-codex-old",
    requesterId: "sample-claude-new",
  });
  assert.equal(f.handoff.relation, "cross-tool");
  assert.equal(f.source.provider, "codex");
});
test("denied sharing never returns content", async () => {
  const e = make();
  e.loadSample();
  grant(e);
  e.grant("sample-codex-old", { share: false });
  await assert.rejects(
    e.retrieve({
      sourceId: "sample-codex-old",
      requesterId: "sample-codex-new",
    }),
    /grants required/,
  );
});
test("stale context is refused", async () => {
  const e = make({ clock: () => Date.parse("2028-01-01") });
  e.loadSample();
  grant(e);
  await assert.rejects(e.finding("sample-codex-old"), /Stale/);
});
test("artifact tampering is refused", async () => {
  const e = make();
  e.loadSample();
  grant(e);
  await e.finding("sample-codex-old");
  e.cache.get("sample-codex-old").artifact.text = "tampered";
  await assert.rejects(
    e.retrieve({
      sourceId: "sample-codex-old",
      requesterId: "sample-codex-new",
    }),
    /digest mismatch/,
  );
});
test("revoking enrollment clears content and disables connectors", () => {
  const e = make();
  e.loadSample();
  grant(e);
  const c = e.issueConnector("sample-codex-new");
  assert.equal(e.connector(c.token).sessionId, "sample-codex-new");
  e.grant("sample-codex-new", { enrolled: false });
  assert.equal(e.store.data.grants["sample-codex-new"].retrieve, false);
  assert.throws(() => e.connector(c.token), /revoked/);
});
test("connector capability rejects foreign and missing tokens", () => {
  const e = make();
  e.loadSample();
  grant(e);
  assert.throws(() => e.connector("invented"), /denied/);
  assert.throws(
    () => e.issueConnector("sample-codex-old"),
    /participant required/,
  );
});
test("restart preserves revocation and does not auto-discover histories", () => {
  const e = make();
  e.loadSample();
  grant(e);
  e.grant("sample-codex-old", { enrolled: false });
  const after = new Engine(new Store(e.store.root), e.fabric);
  assert.equal(after.catalog.length, 0);
  after.loadSample();
  assert.equal(after.store.data.grants["sample-codex-old"].content, false);
});
test("native discovery rejects relative paths before spawning native tool", async () => {
  const e = make({
    nativeFactory: () => {
      throw new Error("must not spawn");
    },
  });
  await assert.rejects(
    e.discoverNative({ id: "x", path: "relative", account: "private" }),
    /absolute/,
  );
});
test("native discovery refuses an unknown installed version", async () => {
  const e = make();
  e.tools = [{ provider: "codex", versionMatches: false }];
  await assert.rejects(
    e.discoverNative({ id: "x", path: process.cwd(), account: "private" }),
    /not qualified/,
  );
});
const usage = {
  provider: "codex",
  account: "personal",
  threadId: "native-1",
  turnId: "turn-1",
  scope: "turn",
  input: 100,
  output: 20,
  cachedInput: 80,
  tool: 3,
  subagent: 2,
};
test("duplicate native usage delivery is not counted twice", () => {
  const e = make();
  recordUsage(e.store, usage);
  assert.equal(recordUsage(e.store, usage).duplicate, true);
  assert.equal(usageSummary(e.store).input, 100);
  assert.equal(usageSummary(e.store).cachedInput, 80);
});
test("cumulative usage replaces precisely covered turns and retains later turns", () => {
  const e = make();
  recordUsage(e.store, usage);
  recordUsage(e.store, {
    ...usage,
    scope: "session-cumulative",
    input: 150,
    output: 30,
    coveredTurnIds: ["turn-1"],
  });
  recordUsage(e.store, { ...usage, turnId: "turn-2", input: 40, output: 8 });
  assert.equal(usageSummary(e.store).input, 190);
  assert.equal(usageSummary(e.store).output, 38);
});
test("ambiguous cumulative scope and regressing observations are rejected", () => {
  const e = make();
  assert.throws(
    () => recordUsage(e.store, { ...usage, scope: "session-cumulative" }),
    /covered/,
  );
  recordUsage(e.store, usage);
  assert.throws(
    () => recordUsage(e.store, { ...usage, input: 99 }),
    /Regressing/,
  );
});
test("identical thread ID in another account is separate usage", () => {
  const e = make();
  recordUsage(e.store, usage);
  recordUsage(e.store, { ...usage, account: "company" });
  assert.equal(usageSummary(e.store).input, 200);
});
const native = { provider: "codex", account: "personal", threadId: "n-1" };
const opts = { grant: true, budget: 100 };
function fixtureAdapter() {
  let calls = 0;
  return {
    fixture: true,
    allocateTurnId: () => `turn-${calls + 1}`,
    execute: async () => {
      calls++;
      return { status: "completed", result: "fixture result" };
    },
    reconcile: async () => null,
    get calls() {
      return calls;
    },
  };
}
test("real native execution is disabled despite a local grant", async () => {
  const gate = new ExecutionGate(mkdtempSync(join(tmpdir(), "as-gate-")));
  await assert.rejects(
    gate.run(native, "work-1", { fixture: false }, opts),
    /not qualified/,
  );
});
test("execution requires explicit grant and positive budget", async () => {
  const gate = new ExecutionGate(mkdtempSync(join(tmpdir(), "as-gate-")));
  await assert.rejects(
    gate.run(native, "work-1", fixtureAdapter()),
    /grant and budget/,
  );
});
test("duplicate and older work deliveries never repeat fixture effects", async () => {
  const gate = new ExecutionGate(mkdtempSync(join(tmpdir(), "as-gate-"))),
    a = fixtureAdapter();
  await gate.run(native, "work-1", a, opts);
  await gate.run(native, "work-2", a, opts);
  assert.equal((await gate.run(native, "work-1", a, opts)).duplicate, true);
  assert.equal(a.calls, 2);
});
test("same native thread across GUI/CLI is excluded while busy", async () => {
  const root = mkdtempSync(join(tmpdir(), "as-gate-")),
    gate = new ExecutionGate(root);
  let release;
  const a = fixtureAdapter();
  a.execute = () => new Promise((r) => (release = r));
  const first = gate.run({ ...native, surface: "desktop" }, "work-1", a, opts);
  await new Promise((r) => setImmediate(r));
  const second = await new ExecutionGate(root).run(
    { ...native, surface: "cli" },
    "work-2",
    fixtureAdapter(),
    opts,
  );
  assert.equal(second.status, "busy");
  release({ status: "completed" });
  await first;
});
test("lost acknowledgement reconciles native turn ID after restart without retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "as-gate-"));
  const a = fixtureAdapter();
  a.execute = async () => {
    throw new Error("disconnected");
  };
  await assert.rejects(
    new ExecutionGate(root).run(native, "work-1", a, opts),
    /disconnected/,
  );
  let seen;
  a.reconcile = async (id) => {
    seen = id;
    return { status: "completed", result: "retained result" };
  };
  const result = await new ExecutionGate(root).run(native, "work-1", a, opts);
  assert.equal(result.status, "completed");
  assert.equal(seen, "turn-1");
  assert.equal(a.calls, 0);
});
test("uncertain turn blocks new work even after lease timeout", async () => {
  const gate = new ExecutionGate(mkdtempSync(join(tmpdir(), "as-gate-"))),
    a = fixtureAdapter();
  a.execute = async () => {
    throw new Error("lost ack");
  };
  await assert.rejects(gate.run(native, "work-1", a, opts));
  await assert.rejects(
    gate.run(native, "work-2", fixtureAdapter(), opts),
    /reconciliation/,
  );
  assert.equal((await gate.run(native, "work-1", a, opts)).status, "uncertain");
});
test("pre-dispatch cancellation produces no fixture effect", async () => {
  const gate = new ExecutionGate(mkdtempSync(join(tmpdir(), "as-gate-"))),
    a = fixtureAdapter(),
    abort = new AbortController();
  abort.abort();
  assert.equal(
    (await gate.run(native, "work-1", a, { ...opts, signal: abort.signal }))
      .status,
    "cancelled",
  );
  assert.equal(a.calls, 0);
});
test("remote fabric seeds are refused", async () => {
  const e = make();
  await assert.rejects(
    e.fabric.connect({ host: "example.com", port: 7500, groupId: "x" }),
    /loopback/,
  );
});
test("disconnected fabric never accepts a local write as publication", () => {
  const e = make();
  assert.throws(() => e.fabric.write("x", "y", {}, "thread"), /disconnected/);
  assert.throws(() => e.fabric.read("x", "y"), /disconnected/);
});
test("multi-host catalogs preserve same native UUID as separate source references", async () => {
  const e = make({
    nativeFactory: (context) => ({
      open: async () => {},
      close: () => {},
      discover: async (p) => ({
        sessions: [
          {
            id: "same-uuid",
            nativeThreadId: "same-uuid",
            provider: context.provider,
            account: p.account,
            project: p.id,
            title: "Research",
            updatedAt: "2026-10-08T00:00:00Z",
            topics: [],
            status: "unknown",
            sourceVersion: "1",
            fixture: false,
          },
        ],
        nextCursor: null,
      }),
    }),
  });
  e.tools = [
    { provider: "codex", host: "local", versionMatches: true },
    { provider: "codex", host: "remote", versionMatches: true },
  ];
  await e.discoverNative({
    id: "linked-research",
    account: "private",
    path: process.cwd(),
    host: "local",
  });
  await e.discoverNative({
    id: "linked-research",
    account: "private",
    path: "/tmp/fixture-research",
    host: "remote",
  });
  assert.equal(e.catalog.length, 2);
  assert.notEqual(e.catalog[0].id, e.catalog[1].id);
  assert.equal(e.catalog[0].nativeThreadId, e.catalog[1].nativeThreadId);
  assert.equal(
    e.project("linked-research").targets["remote:codex"].path,
    "/tmp/fixture-research",
  );
});
test("remote discovery refuses Windows path and unknown SSH aliases before invoking tools", async () => {
  const e = make({
    nativeFactory: () => {
      throw new Error("must not start");
    },
  });
  await assert.rejects(
    e.discoverNative({
      id: "x",
      account: "a",
      host: "remote",
      path: "C:\\private",
    }),
    /absolute/,
  );
  await assert.rejects(
    e.discoverNative({ id: "x", account: "a", host: "invented", path: "/x" }),
    /Unsupported/,
  );
});
test("linked project account boundary cannot be rebound on another host", async () => {
  const e = make({
    nativeFactory: () => ({
      open: async () => {},
      close: () => {},
      discover: async () => ({ sessions: [], nextCursor: null }),
    }),
  });
  e.tools = [
    { provider: "codex", host: "local", versionMatches: true },
    { provider: "codex", host: "remote", versionMatches: true },
  ];
  await e.discoverNative({ id: "x", account: "private", path: process.cwd() });
  await assert.rejects(
    e.discoverNative({
      id: "x",
      account: "work",
      path: "/tmp/x",
      host: "remote",
    }),
    /cannot be rebound/,
  );
});
test("explicit native metadata pagination retains older discovered sessions", async () => {
  let calls = 0;
  const e = make({
    nativeFactory: () => ({
      open: async () => {},
      close: () => {},
      discover: async (p, _archive, cursor) => {
        calls++;
        return {
          sessions: [
            {
              id: cursor ? "older" : "newer",
              provider: "codex",
              account: p.account,
              project: p.id,
              title: "Research",
              updatedAt: "2026-10-08",
              topics: [],
              status: "dormant",
            },
          ],
          nextCursor: cursor ? null : "next",
        };
      },
    }),
  });
  e.tools = [{ provider: "codex", versionMatches: true }];
  await e.discoverNative({ id: "p", account: "private", path: process.cwd() });
  await e.moreNative({ projectId: "p", targetKey: "local:codex" });
  assert.equal(e.catalog.length, 2);
  assert.equal(calls, 2);
  assert.equal(e.modelCalls, 0);
});
