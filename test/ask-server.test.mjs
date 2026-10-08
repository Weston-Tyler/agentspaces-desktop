import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../app/engine.mjs";
import { Store } from "../app/store.mjs";
import { FabricAdapter } from "../app/fabric.mjs";
import { startServer } from "../app/server.mjs";
const budget = {
  inputChars: 24000,
  outputChars: 12000,
  maxOutputTokens: 800,
  timeoutMs: 1000,
};
test("authenticated Ask HTTP flow finds two cross-tool sources and shows one cited answer without duplicate effects", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "as-ask-http-"));
  let calls = 0;
  const engine = new Engine(
    new Store(root),
    new FabricAdapter({ stateRoot: root }),
    {
      answerFactory: async () => ({
        answer: async ({ context }) => {
          calls++;
          assert.equal(context.length, 2);
          return {
            text: "Synthetic answer: reconcile retries [S1]; retain artifact provenance [S2].",
            fixture: true,
            executionKind: "injected fixture actor",
            usage: {
              known: false,
              inputTokens: null,
              outputTokens: null,
              totalTokens: null,
            },
          };
        },
      }),
    },
  );
  engine.loadSample();
  for (const id of ["sample-codex-old", "sample-claude-old"])
    engine.grant(id, { enrolled: true, content: true, share: true });
  const app = await startServer({ root, port: 0, engine });
  t.after(() => app.close());
  const post = async (path, data, token = app.admin) =>
    fetch(app.address + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
  const search = await (
    await post("/api/ask/search", { question: "retry artifact", mode: "work" })
  ).json();
  assert(search.sessions.some((s) => s.id === "sample-codex-old"));
  assert(search.sessions.some((s) => s.id === "sample-claude-old"));
  const args = {
    question: "What did we decide?",
    mode: "work",
    provider: "codex",
    host: "local",
    sourceIds: ["sample-codex-old", "sample-claude-old"],
    budget,
    deliveryId: "http-ask-delivery-1",
    executionGranted: true,
  };
  const first = await (await post("/api/ask/answer", args)).json();
  assert.equal(first.citations.length, 2);
  assert.equal(first.fixture, true);
  assert.equal(first.usage.known, false);
  const second = await (await post("/api/ask/answer", args)).json();
  assert.equal(second.duplicate, true);
  assert.equal(calls, 1);
  engine.grant("sample-codex-old", { share: false });
  assert.equal((await post("/api/ask/answer", args)).status, 400);
  engine.grant("sample-codex-new", { enrolled: true, retrieve: true });
  const connector = engine.issueConnector("sample-codex-new");
  assert.equal(
    (await post("/api/ask/answer", args, connector.token)).status,
    400,
  );
});
test("Ask HTTP cancellation persists uncertainty and never repeats the native effect", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "as-ask-cancel-"));
  let started;
  const ready = new Promise((r) => (started = r));
  let calls = 0;
  const engine = new Engine(
    new Store(root),
    new FabricAdapter({ stateRoot: root }),
    {
      answerFactory: async () => ({
        answer: ({ signal }) =>
          new Promise((_yes, no) => {
            calls++;
            started();
            signal.addEventListener(
              "abort",
              () =>
                no(
                  Object.assign(new Error("native_cancelled"), {
                    uncertainOutcome: true,
                  }),
                ),
              { once: true },
            );
          }),
      }),
    },
  );
  const app = await startServer({ root, port: 0, engine });
  t.after(() => app.close());
  const post = (path, data) =>
    fetch(app.address + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + app.admin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
  const args = {
    question: "Question",
    mode: "general",
    provider: "codex",
    host: "local",
    budget,
    deliveryId: "cancel-delivery-1",
    executionGranted: true,
  };
  const pending = post("/api/ask/answer", args);
  await ready;
  const cancelled = await (
    await post("/api/ask/cancel", { deliveryId: args.deliveryId })
  ).json();
  assert.equal(cancelled.status, "cancellation requested");
  assert.equal((await pending).status, 400);
  assert.equal((await post("/api/ask/answer", args)).status, 400);
  assert.equal(calls, 1);
  assert.equal(
    engine.store.data.askReceipts[args.deliveryId].state,
    "uncertain",
  );
});
