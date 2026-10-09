import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../app/engine.mjs";
import { Store } from "../app/store.mjs";
import { Ask } from "../app/ask.mjs";
import { loadWorkspaceFixture } from "../app/workspace-fixture.mjs";
const budget = {
  inputChars: 2000,
  outputChars: 1000,
  timeoutMs: 1000,
  maxOutputTokens: 200,
};
const input = (extra = {}) => ({
  question: "What did we decide about retry?",
  mode: "work",
  provider: "claude",
  host: "local",
  sourceIds: ["sample-codex-old"],
  budget,
  executionGranted: true,
  deliveryId: "ask-delivery-0001",
  ...extra,
});
function setup(handler) {
  const store = new Store(mkdtempSync(join(tmpdir(), "as-ask-")));
  const engine = new Engine(store, {
    diagnostics: () => ({ status: "disconnected" }),
  });
  engine.loadSample();
  engine.grant("sample-codex-old", {
    enrolled: true,
    content: true,
    share: true,
    retrieve: true,
  });
  let calls = 0,
    received;
  const answerFactory = async () => ({
    answer: async (request) => {
      calls++;
      received = request;
      return handler
        ? handler(request)
        : {
            text: "Synthetic actor: reconcile original operation [S1].",
            fixture: true,
            executionKind: "injected fixture actor",
            nativeThreadId: "fixture-thread",
            nativeTurnId: "fixture-turn",
            usage: { input: 20, output: 10 },
          };
    },
  });
  return {
    engine,
    store,
    ask: new Ask(engine, { answerFactory }),
    answerFactory,
    count: () => calls,
    received: () => received,
  };
}
test("Ask matches all permitted catalog rows beyond discover page and reports native fanout block", () => {
  const { engine, ask, count } = setup();
  const original = engine.catalog.find((s) => s.id === "sample-codex-old");
  for (let i = 0; i < 260; i++)
    engine.catalog.push({ ...original, id: "extra-" + i });
  const result = ask.search({ question: "retry" });
  assert.equal(result.sessions.length, 263);
  assert.equal(result.fanout.capacity, 12);
  assert.equal(result.fanout.automaticWake, false);
  assert(!result.sessions.some((s) => s.id === "sample-denied"));
  assert.equal(count(), 0);
});
test("natural-language topic matching ignores question punctuation and filler words", () => {
  const { ask } = setup();
  const result = ask.search({ question: "What have we done about retry?" });
  assert(result.sessions.some((session) => session.id === "sample-codex-old"));
  assert(
    !result.sessions.some((session) => session.id === "sample-claude-old"),
  );
});
test("Ask sends bounded shared context across source providers with source citations", async () => {
  const { ask, received } = setup();
  const result = await ask.answer(input());
  assert.equal(result.fixture, true);
  assert.equal(result.provider, "claude");
  assert.equal(result.citations[0].provider, "codex");
  assert.equal(result.citations[0].version, "synthetic-fixture-v1");
  assert.match(result.citations[0].digest, /^[a-f0-9]{64}$/);
  assert.equal(received().context[0].untrusted, true);
  assert(
    received().context.reduce(
      (n, c) => n + c.text.length,
      received().question.length,
    ) <= budget.inputChars,
  );
});
test("General answer retrieves no work and rejects appended source IDs", async () => {
  const { ask, received } = setup(() => ({
    text: "Synthetic general answer without source citations",
    fixture: true,
  }));
  await assert.rejects(
    ask.answer(input({ mode: "general" })),
    /General questions/,
  );
  await ask.answer(input({ mode: "general", sourceIds: [] }));
  assert.deepEqual(received().context, []);
});
test("Sharing and explicit execution budget required before dispatch", async () => {
  const { engine, ask, count } = setup();
  await assert.rejects(
    ask.answer(input({ executionGranted: false })),
    /execution grant/,
  );
  await assert.rejects(
    ask.answer(input({ budget: { ...budget, timeoutMs: 0 } })),
    /budget/,
  );
  engine.grant("sample-codex-old", { share: false });
  await assert.rejects(ask.answer(input()), /sharing grants/);
  assert.equal(count(), 0);
});
test("Completed effect survives restart and never replays; revoked source redacts cached answer", async () => {
  const { ask, engine, answerFactory, count } = setup();
  await ask.answer(input());
  const restarted = new Ask(engine, { answerFactory });
  const duplicate = await restarted.answer(input());
  assert.equal(duplicate.duplicate, true);
  assert.equal(count(), 1);
  await assert.rejects(
    ask.answer(input({ question: "Changed question" })),
    /reused/,
  );
  engine.grant("sample-codex-old", { share: false });
  await assert.rejects(restarted.answer(input()), /revoked/);
  assert.equal(
    engine.store.data.askReceipts[input().deliveryId].result,
    undefined,
  );
});
test("Uncertain inference failures persist effect fence and do not retry", async () => {
  const { ask, engine, answerFactory, count } = setup(() => {
    throw new Error("Lost acknowledgement");
  });
  await assert.rejects(ask.answer(input()), /Lost acknowledgement/);
  await assert.rejects(
    new Ask(engine, { answerFactory }).answer(input()),
    /uncertain.*no automatic retry/,
  );
  assert.equal(count(), 1);
});
test("Exact indexed file citations and changed hash invalidate replay", async () => {
  const { ask, engine } = setup();
  engine.workspace.index = {
    profile: { active: true, id: "fixture-scope", indexFiles: true },
    nodes: [
      {
        id: "doc1",
        kind: "document",
        hash: "fixture-hash",
        path: "/fixture/retry.md",
        host: "remote",
      },
    ],
    edges: [],
    sessions: [],
    coverage: [{ partial: true, limits: ["fixture file cap"] }],
    errors: [],
    cursors: {},
    filesystemCursors: { remote: {} },
  };
  engine.workspace.inspect = async () => ({
    source: {
      path: "/fixture/retry.md",
      host: "remote",
      sha256: "fixture-hash",
    },
    text: "Synthetic exact indexed document",
    truncated: false,
  });
  const args = input({ sourceIds: [], nodeIds: ["doc1"] });
  const result = await ask.answer(args);
  assert.equal(result.citations[0].sha256, "fixture-hash");
  assert.equal(result.sourceCoverage.partial, true);
  engine.workspace.index.nodes[0].hash = "changed";
  await assert.rejects(ask.answer(args), /indexed source changed/);
});
test("Input budget truncation and omissions are explicit", async () => {
  const { ask, engine } = setup();
  engine.grant("sample-claude-old", {
    enrolled: true,
    content: true,
    share: true,
  });
  const result = await ask.answer(
    input({
      sourceIds: ["sample-codex-old", "sample-claude-old"],
      budget: { ...budget, inputChars: 400 },
    }),
  );
  assert(result.sourceCoverage.serializedPromptChars <= 400);
  assert.deepEqual(result.sourceCoverage.truncated, ["S1"]);
  assert.deepEqual(result.sourceCoverage.omitted, ["sample-claude-old"]);
});
test("Concurrent duplicate submissions dispatch one fixture inference effect", async () => {
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const { ask, count } = setup(async () => {
    await wait;
    return { text: "Synthetic fixture answer", fixture: true };
  });
  const first = ask.answer(input());
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(ask.answer(input()), /uncertain.*no automatic retry/);
  release();
  await first;
  assert.equal(count(), 1);
});
test("Native inference count and unknown usage survive dedup without fabricated turn IDs", async () => {
  const { ask, engine, answerFactory } = setup(() => ({
    text: "Protocol fixture representing native answer",
    limitations: ["native identity unavailable"],
  }));
  const result = await ask.answer(input());
  assert.equal(engine.modelCalls, 1);
  assert.equal(result.usage.known, false);
  assert.equal(result.usage.inputTokens, null);
  assert.equal(result.nativeTurnId, null);
  assert.deepEqual(result.limitations, ["native identity unavailable"]);
  await new Ask(engine, { answerFactory }).answer(input());
  assert.equal(engine.modelCalls, 1);
});
test("Only explicitly safe preflight failure is recorded as before-dispatch", async () => {
  const { ask, engine } = setup(() => {
    throw Object.assign(new Error("Fixture preflight refusal"), {
      uncertainOutcome: false,
    });
  });
  await assert.rejects(ask.answer(input()), /preflight refusal/);
  assert.equal(
    engine.store.data.askReceipts[input().deliveryId].state,
    "failed-before-dispatch",
  );
  assert.equal(engine.modelCalls, 0);
});
test("Revocation while answer is pending removes returned and cached content", async () => {
  const { ask, engine } = setup(() => {
    engine.grant("sample-codex-old", { share: false });
    return { text: "Synthetic revoked answer", fixture: true };
  });
  await assert.rejects(ask.answer(input()), /revoked/);
  assert.equal(
    engine.store.data.askReceipts[input().deliveryId].result,
    undefined,
  );
  await assert.rejects(ask.answer(input()), /revoked/);
});
test("Answers cannot invent a source identifier that was never retrieved", async () => {
  const { ask, engine } = setup(() => ({
    text: "Unsupported claim [S99]",
    fixture: true,
  }));
  await assert.rejects(ask.answer(input()), /unavailable source citation/);
  assert.equal(
    engine.store.data.askReceipts[input().deliveryId].result,
    undefined,
  );
});
test("cached answer refuses changed file bytes even when the derived index hash was not refreshed", async () => {
  const { ask, engine, count } = setup(() => ({
    text: "Synthetic file-based answer [S1]",
    fixture: true,
  }));
  await loadWorkspaceFixture(engine);
  const file = engine.workspace.index.nodes.find(
    (node) =>
      node.kind === "document" &&
      node.hash &&
      node.path.endsWith("architecture.md"),
  );
  assert(file);
  const args = input({
    sourceIds: [],
    nodeIds: [file.id],
    deliveryId: "file-bytes-delivery",
  });
  await ask.answer(args);
  writeFileSync(
    file.path,
    "Changed synthetic file bytes; derived index left unchanged.\n",
  );
  await assert.rejects(ask.answer(args), /changed|hash|indexed/i);
  assert.equal(count(), 1);
  assert.equal(
    engine.store.data.askReceipts[args.deliveryId].result,
    undefined,
  );
});
