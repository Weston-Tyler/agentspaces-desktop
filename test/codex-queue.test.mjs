import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer } from "node:http";
import { connect } from "node:net";
import { WebSocketServer } from "ws";
import { CodexQueueAdapter } from "../app/codex-queue.mjs";

const threadId = "owned-thread",
  cwd = "/tmp/agentspaces-queue-proof",
  budget = { timeoutMs: 200, maxOutputTokens: 800 };
function fixture({
  status = "idle",
  sandbox = "readOnly",
  hang = false,
  ackError = false,
  outputTokens = 20,
  persistenceFails = false,
} = {}) {
  const calls = [],
    writes = [],
    saved = new Map();
  const adapter = new CodexQueueAdapter({
    persistReceipt: async (receipt) => {
      writes.push({ ...receipt });
      if (persistenceFails) throw new Error("store unavailable");
      saved.set(receipt.clientId, { ...receipt });
    },
    loadReceipt: async (id) => saved.get(id),
  });
  adapter.request = async (method, params) => {
    calls.push({ method, params, writesBefore: writes.length });
    if (method === "thread/start")
      return {
        thread: { id: threadId },
        cwd,
        approvalPolicy: "never",
        sandbox: { type: sandbox, networkAccess: false },
      };
    if (method === "thread/read")
      return {
        thread: {
          id: threadId,
          cwd,
          status: { type: status },
          ephemeral: false,
        },
      };
    if (method === "thread/queue/add") {
      if (ackError) throw new Error("unknown ack");
      if (!hang)
        setImmediate(() => {
          adapter.events.emit("notification", {
            method: "item/started",
            params: {
              threadId,
              turnId: "turn-1",
              item: {
                type: "userMessage",
                clientId: params.clientUserMessageId,
              },
            },
          });
          adapter.events.emit("notification", {
            method: "thread/tokenUsage/updated",
            params: {
              threadId,
              turnId: "turn-1",
              tokenUsage: {
                last: {
                  inputTokens: 100,
                  outputTokens,
                  totalTokens: 100 + outputTokens,
                },
              },
            },
          });
          adapter.events.emit("notification", {
            method: "item/completed",
            params: {
              threadId,
              turnId: "turn-1",
              item: { type: "agentMessage", text: "Bounded native reply." },
            },
          });
          adapter.events.emit("notification", {
            method: "turn/completed",
            params: {
              threadId,
              turn: { id: "turn-1", status: "completed", items: [] },
            },
          });
        });
      return {
        queuedSubmission: {
          id: "queue-1",
          clientUserMessageId: params.clientUserMessageId,
        },
      };
    }
    if (method === "thread/queue/list")
      return { data: [{ id: "queue-1", clientUserMessageId: "client-1" }] };
    if (method === "thread/queue/delete") return { deleted: true };
    if (method === "turn/interrupt") return {};
    if (method === "thread/turns/list") return { data: [] };
    throw new Error("unexpected method");
  };
  const start = () =>
    adapter.createOwnedThread({ cwd, grant: true, ownedScratch: true });
  const answer = (extras) =>
    adapter.answer({
      threadId,
      clientId: "client-1",
      question: "Return a short answer",
      grant: true,
      budget,
      ...extras,
    });
  return { adapter, calls, writes, saved, start, answer };
}

test("owned thread verifies returned read-only permissions and configured tool boundaries", async () => {
  const f = fixture();
  const result = await f.start();
  assert.equal(result.nativeThreadId, threadId);
  assert.equal(result.permissionProof.sandbox.type, "readOnly");
  assert.equal(f.calls[0].params.config["features.hooks"], false);
  assert.equal(f.calls[0].params.config["features.shell_tool"], false);
  assert.deepEqual(f.calls[0].params.config.mcp_servers, {});
  assert.equal(
    f.calls[0].params.ephemeral,
    false,
    "native queue requires persistent threads",
  );
  const g = fixture({ sandbox: "dangerFullAccess" });
  await assert.rejects(g.start(), {
    code: "native_readonly_permission_not_verified",
  });
});
test("cold or unknown permission threads refuse without resume or config mutation", async () => {
  const f = fixture({ status: "notLoaded" });
  await f.start();
  await assert.rejects(f.answer(), {
    code: "cold_thread_requires_native_owner_resume",
  });
  const g = fixture();
  await assert.rejects(g.answer(), {
    code: "native_readonly_permission_not_verified",
  });
  assert.ok(
    ![...f.calls, ...g.calls].some(
      (c) => c.method === "thread/resume" || c.method === "thread/queue/add",
    ),
  );
});
test("durable receipt precedes native queue write and exact message correlates turn and usage", async () => {
  const f = fixture();
  await f.start();
  const result = await f.answer();
  assert.equal(result.nativeThreadId, threadId);
  assert.equal(result.nativeTurnId, "turn-1");
  assert.equal(result.queuedSubmissionId, "queue-1");
  assert.equal(result.usage.totalTokens, 120);
  const mutation = f.calls.find((c) => c.method === "thread/queue/add");
  assert.ok(mutation.writesBefore >= 2);
  assert.equal(mutation.params.clientUserMessageId, "client-1");
  assert.equal(f.writes[0].status, "prepared");
  assert.equal(f.saved.get("client-1").status, "completed");
  assert.ok(
    !mutation.params.sandbox,
    "existing native permission config is not overridden",
  );
  await assert.rejects(f.answer(), {
    code: "receipt_exists_reconcile_without_retry",
  });
  assert.equal(
    f.calls.filter((c) => c.method === "thread/queue/add").length,
    1,
  );
});
test("missing grant, invalid budget and failed receipt allocation refuse queue mutation", async () => {
  const f = fixture();
  await f.start();
  await assert.rejects(f.answer({ grant: false }), {
    code: "execution_grant_and_durable_receipt_required",
  });
  await assert.rejects(
    f.answer({ budget: { ...budget, maxOutputTokens: 801 } }),
    { code: "invalid_queue_budget" },
  );
  const g = fixture({ persistenceFails: true });
  await g.start();
  await assert.rejects(g.answer());
  assert.ok(!g.calls.some((c) => c.method === "thread/queue/add"));
});
test("lost queue acknowledgement retains uncertain receipt and prohibits repeat", async () => {
  const f = fixture({ ackError: true });
  await f.start();
  await assert.rejects(f.answer(), {
    code: "native_queue_ack_uncertain",
    uncertainOutcome: true,
  });
  assert.equal(f.saved.get("client-1").observationEnded, true);
  assert.ok(!f.calls.some((c) => c.method === "thread/queue/delete"));
  await assert.rejects(f.answer(), {
    code: "receipt_exists_reconcile_without_retry",
  });
});
test("timeout preserves the matching queued submission even for an owned proof thread", async () => {
  const f = fixture({ hang: true });
  await f.start();
  await assert.rejects(f.answer({ budget: { ...budget, timeoutMs: 10 } }), {
    code: "native_queue_timeout",
    uncertainOutcome: true,
  });
  assert.ok(!f.calls.some((c) => c.method === "thread/queue/delete"));
  assert.equal(f.saved.get("client-1").nativeCancellationRequested,false);
  assert.ok(!f.calls.some((c) => c.method === "turn/interrupt"));
});
test("running cancellation detaches observation without interrupting the native turn", async () => {
  const f = fixture({ hang: true });
  await f.start();
  const controller = new AbortController();
  const result = f.answer({ signal: controller.signal });
  setImmediate(() => {
    f.adapter.events.emit("notification", {
      method: "item/started",
      params: {
        threadId,
        turnId: "owned-turn",
        item: { type: "userMessage", clientId: "client-1" },
      },
    });
    controller.abort();
  });
  await assert.rejects(result, { code: "cancelled", uncertainOutcome: true });
  assert.ok(!f.calls.some((c) => c.method === "turn/interrupt"));
  assert.equal(f.saved.get("client-1").nativeCancellationRequested,false);
});
test("unrelated turn notifications cannot supply this request result", async () => {
  const f = fixture({ hang: true });
  await f.start();
  const answer = f.answer({ budget: { ...budget, timeoutMs: 15 } });
  setImmediate(() =>
    f.adapter.events.emit("notification", {
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: "unrelated",
          status: "completed",
          items: [{ type: "agentMessage", text: "Not our result" }],
        },
      },
    }),
  );
  await assert.rejects(answer, { code: "native_queue_timeout" });
});
test("known over-budget output returns failure after completion", async () => {
  const f = fixture({ outputTokens: 801 });
  await f.start();
  await assert.rejects(f.answer(), {
    code: "native_queue_token_budget_exceeded",
    uncertainOutcome: true,
  });
});
test("concurrent duplicate client delivery is excluded before native queue mutation", async () => {
  const f = fixture({ hang: true });
  await f.start();
  const first = f.answer({ budget: { ...budget, timeoutMs: 10 } });
  await assert.rejects(f.answer(), { code: "request_already_inflight" });
  await assert.rejects(first, { code: "native_queue_timeout" });
  assert.equal(
    f.calls.filter((c) => c.method === "thread/queue/add").length,
    1,
  );
});
test("reconciliation finds native pending IDs without re-enqueuing", async () => {
  const f = fixture();
  await f.start();
  assert.deepEqual(
    await f.adapter.reconcile({ threadId, clientId: "client-1", grant: true }),
    {
      status: "queued",
      nativeThreadId: threadId,
      clientId: "client-1",
      queuedSubmissionId: "queue-1",
    },
  );
  assert.ok(!f.calls.some((c) => c.method === "thread/queue/add"));
  await assert.rejects(
    f.adapter.reconcile({ threadId, clientId: "client-1", grant: false }),
    { code: "reconciliation_grant_and_permission_proof_required" },
  );
});
test("transport connects only to existing shared daemon and enables qualified experimental queue API", async () => {
  const calls = [],
    server = createServer(),
    websocketServer = new WebSocketServer({ server });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  websocketServer.on("connection", (peer) => {
    peer.on("message", (data) => {
      const request = JSON.parse(data.toString());
      calls.push(request);
      if (request.id) {
        // Standard server frames deliberately cross large-frame and fragmentation boundaries.
        const result = JSON.stringify({
          id: request.id,
          result: { fixture: "x".repeat(70000) },
        });
        peer.send(result.slice(0, 30000), { fin: false });
        peer.send(result.slice(30000), { fin: true });
      }
    });
    peer.ping("fixture-keepalive");
  });
  let launch;
  const adapter = new CodexQueueAdapter({
    spawnProcess: (command, args) => {
      launch = { command, args };
      const child = new EventEmitter(),
        socket = connect(server.address().port, "127.0.0.1");
      child.stdout = socket;
      child.stdin = socket;
      child.stderr = new PassThrough();
      child.kill = () => socket.destroy();
      socket.on("close", () => child.emit("close"));
      return child;
    },
  });
  try {
    const response = await adapter.open();
    assert.equal(response.fixture.length, 70000);
    assert.deepEqual(launch, {
      command: "ssh",
      args: ["remote", "codex app-server proxy"],
    });
    assert.equal(calls[0].params.capabilities.experimentalApi, true);
    assert.ok(!launch.args.some((arg) => arg.includes("--stdio")));
  } finally {
    adapter.close();
    for (const peer of websocketServer.clients) peer.terminate();
    await new Promise((resolve) => server.close(resolve));
    websocketServer.close();
  }
});

test('native transport refuses turn interruption before writing any RPC',async()=>{
 const adapter=new CodexQueueAdapter();let sent=false;adapter.send=()=>{sent=true;};
 await assert.rejects(adapter.request('turn/interrupt',{threadId,turnId:'some-turn'}),{code:'native_turn_cancellation_disabled'});
 assert.equal(sent,false);
});
