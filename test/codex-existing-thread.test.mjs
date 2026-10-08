import test from "node:test";
import assert from "node:assert/strict";
import { CodexQueueAdapter } from "../app/codex-queue.mjs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { WebSocketServer } from "ws";

const threadId = "00000000-0000-4000-8000-000000000001", cwd = "/home/owner/project";
function fixture({ status = "notLoaded", pending = false, sandbox = { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false }, approvalPolicy = "on-request", reviewer = "user", resumeMismatch = false, emitsTools = false, persisted = null } = {}) {
  const calls = [], receipts = [], proofs = [];
  const adapter = new CodexQueueAdapter({ persistReceipt: async receipt => receipts.push(structuredClone(receipt)), persistPermissionProof: async proof => proofs.push(structuredClone(proof)), loadPermissionProof: async () => persisted });
  let loaded = status;
  adapter.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { id: threadId, cwd, status: { type: loaded }, canAcceptDirectInput: true, ephemeral: false } };
    if (method === "thread/queue/list") return { data: pending ? [{ id: "prior-user-request" }] : [] };
    if (method === "thread/resume") { loaded = "idle"; return { thread: { id: resumeMismatch ? "other" : threadId, cwd, status: { type: "idle" }, canAcceptDirectInput: true, ephemeral: false }, cwd, sandbox, approvalPolicy, approvalsReviewer: reviewer }; }
    if (method === "thread/queue/add") {
      setImmediate(() => {
        adapter.events.emit("notification", { method: "item/started", params: { threadId, turnId: "native-turn", item: { type: "userMessage", clientId: params.clientUserMessageId } } });
        if (emitsTools) adapter.events.emit("notification", { method: "item/started", params: { threadId, turnId: "native-turn", item: { type: "commandExecution", command: "synthetic-native-tool" } } });
        adapter.events.emit("notification", { method: "turn/completed", params: { threadId, turn: { id: "native-turn", status: "completed", items: [{ type: "agentMessage", text: "Existing native result" }] } } });
      });
      return { queuedSubmission: { id: "queued-request" } };
    }
    if (method === "turn/interrupt") return {};
    throw new Error("Unexpected native method");
  };
  return { adapter, calls, receipts, proofs, bind: grant => adapter.bindExistingThread({ threadId, cwd, grant: grant ?? true }) };
}
test("exact existing source resumes only through preserved native configuration and policy", async () => {
  const f = fixture(); const result = await f.bind();
  assert.deepEqual(f.calls.map(call => call.method), ["thread/read", "thread/queue/list", "thread/resume"]);
  assert.deepEqual(f.calls[2].params, { threadId });
  assert.equal(result.permissionProof.source, "existing-native-thread-resume-response");
  assert.equal(result.permissionProof.approvalPolicy, "on-request"); assert.deepEqual(result.permissionProof.sandbox.writableRoots, [cwd]);
  assert.equal(f.proofs.length, 1); assert.equal((await f.adapter.eligible(threadId)).eligible, true);
});
test("invalid identity or missing grant fails without a native request", async () => {
  const f = fixture();
  await assert.rejects(f.adapter.bindExistingThread({ threadId: "name-not-uuid", cwd, grant: true }));
  await assert.rejects(f.adapter.bindExistingThread({ threadId, cwd: "relative", grant: true }));
  await assert.rejects(f.bind(false)); assert.equal(f.calls.length, 0);
});
test("active native owner and prior native queued messages refuse before resume", async () => {
  const f = fixture({ status: "active" }); await assert.rejects(f.bind(), { code: "native_existing_thread_busy_or_unavailable" });
  assert.equal(f.calls.length, 1);
  const g = fixture({ pending: true }); await assert.rejects(g.bind(), { code: "native_existing_thread_pending_queue" });
  assert.ok(!g.calls.some(call => call.method === "thread/resume"));
});
test("full-access native policy needs distinct explicit authority; unknown policies never qualify", async () => {
  const f = fixture({ sandbox: { type: "dangerFullAccess" } });
  await assert.rejects(f.bind(), { code: "native_existing_permission_policy_not_qualified" });
  assert.equal(f.proofs.length, 0);
  const g = fixture({ sandbox: { type: "dangerFullAccess" } }); await g.bind({ execution: true, allowFullAccess: true });
  assert.equal((await g.adapter.eligible(threadId)).eligible, true);
  for (const options of [{ sandbox: { type: "unknownPolicy" } }, { approvalPolicy: "invented-auto" }, { reviewer: "invented-reviewer" }, { sandbox: { type: "workspaceWrite", writableRoots: ["relative"] } }]) {
    const h = fixture(options); await assert.rejects(h.bind(), { code: "native_existing_permission_policy_not_qualified" });
  }
});
test("valid native granular approval policy is preserved without substitution", async () => {
  const policy = { granular: { mcp_elicitations: true, rules: true, sandbox_approval: false, request_permissions: false } };
  const f = fixture({ sandbox: { type: "readOnly", networkAccess: false }, approvalPolicy: policy }); const result = await f.bind();
  assert.deepEqual(result.permissionProof.approvalPolicy, policy);
});
test("resume acknowledgement identity mismatch cannot allocate permission authority", async () => {
  const f = fixture({ resumeMismatch: true }); await assert.rejects(f.bind(), { code: "native_existing_thread_resume_not_eligible" });
  assert.equal(f.adapter.proofs.size, 0); assert.equal(f.proofs.length, 0);
});
test("persisted evidence after restart requires explicit rebind and cannot replay execution", async () => {
  const first = fixture(); await first.bind();
  const next = fixture({ status: "idle", persisted: first.proofs[0] });
  assert.deepEqual(await next.adapter.eligible(threadId), { eligible: false, reason: "native_permission_proof_requires_rebind" });
  assert.ok(!next.calls.some(call => call.method === "thread/queue/add" || call.method === "thread/resume"));
  await next.bind(); assert.equal((await next.adapter.eligible(threadId)).eligible, true);
});
test("existing native policy tool events remain native-owned and receipt retains permission provenance", async () => {
  const f = fixture({ emitsTools: true }); await f.bind();
  const result = await f.adapter.answer({ threadId, clientId: "existing-request-1", question: "Inspect the permitted project", grant: true, budget: { timeoutMs: 1000, maxOutputTokens: 800 } });
  assert.equal(result.nativeTurnId, "native-turn"); assert.equal(result.receipt.status, "completed");
  assert.equal(f.receipts[0].permissionProof.source, "existing-native-thread-resume-response");
  assert.ok(!f.calls.some(call => call.method === "turn/interrupt"));
  const submission = f.calls.find(call => call.method === "thread/queue/add").params.input[0].text;
  assert.ok(!submission.includes("Do not use tools"));
});
test("owned scratch tool guard cannot be raced by a following completion event", async () => {
  const f = fixture({ status: "idle", emitsTools: true });
  f.adapter.proofs.set(threadId, { nativeThreadId: threadId, host: "remote", cwd, sandbox: { type: "readOnly" }, approvalPolicy: "never", source: "owned-native-thread-start-response" });
  await assert.rejects(f.adapter.answer({ threadId, clientId: "owned-request-1", question: "Short answer only", grant: true, budget: { timeoutMs: 1000, maxOutputTokens: 800 } }), { code: "unexpected_native_tool_execution", uncertainOutcome: true });
  assert.ok(f.calls.some(call => call.method === "turn/interrupt"));
});
test("revocation during eligible metadata read is fenced before native queue insertion", async () => {
  const f = fixture(); await f.bind(); let release, granted = true;
  const gate = new Promise(resolve => { release = resolve; }), request = f.adapter.request;
  f.adapter.request = async (method, params) => { if (method === "thread/read") await gate; return request(method, params); };
  const result = f.adapter.answer({ threadId, clientId: "revoked-metadata-1", question: "Targeted question", grant: true, budget: { timeoutMs: 1000, maxOutputTokens: 800 }, dispatchFence: () => granted });
  granted = false; release();
  await assert.rejects(result, { code: "native_dispatch_grant_revoked", uncertainOutcome: false });
  assert.equal(f.calls.filter(call => call.method === "thread/queue/add").length, 0);
  assert.equal(f.receipts.at(-1).status, "not-dispatched"); assert.equal(f.receipts.at(-1).undispatched, true);
});
test("revocation while durable allocation is pending produces known undispatched receipt and no replay", async () => {
  const f = fixture(); await f.bind(); let release, granted = true;
  const gate = new Promise(resolve => { release = resolve; }), persist = f.adapter.persistReceipt;
  f.adapter.persistReceipt = async receipt => { if (receipt.status === "prepared") await gate; await persist(receipt); };
  f.adapter.loadReceipt = async clientId => f.receipts.findLast(receipt => receipt.clientId === clientId) ?? null;
  const args = { threadId, clientId: "revoked-receipt-1", question: "Targeted question", grant: true, budget: { timeoutMs: 1000, maxOutputTokens: 800 }, dispatchFence: () => granted };
  const result = f.adapter.answer(args); await new Promise(resolve => setImmediate(resolve));
  granted = false; release();
  await assert.rejects(result, { code: "native_dispatch_grant_revoked", uncertainOutcome: false });
  assert.equal(f.calls.filter(call => call.method === "thread/queue/add").length, 0);
  granted = true;
  await assert.rejects(f.adapter.answer(args), { code: "receipt_exists_reconcile_without_retry", uncertainOutcome: false });
  assert.equal(f.calls.filter(call => call.method === "thread/queue/add").length, 0);
});
test("second dispatch fence runs after dispatch-state persistence and before exact native mutation", async () => {
  const f = fixture(); await f.bind(); let checks = 0;
  const result = f.adapter.answer({ threadId, clientId: "second-fence-1", question: "Targeted question", grant: true, budget: { timeoutMs: 1000, maxOutputTokens: 800 }, dispatchFence: async () => {
    checks++; if (checks === 1) { assert.equal(f.receipts.at(-1).status, "prepared"); return true; }
    assert.equal(f.receipts.at(-1).status, "dispatching"); throw new Error("PRIVATE grant diagnostic");
  } });
  await assert.rejects(result, error => error.code === "native_dispatch_grant_revoked" && !error.uncertainOutcome && !error.message.includes("PRIVATE"));
  assert.equal(checks, 2); assert.equal(f.calls.filter(call => call.method === "thread/queue/add").length, 0);
  assert.ok(!f.calls.some(call => call.method === "turn/interrupt"));
});
test("invalid dispatch fence refuses before native eligibility read", async () => {
  const f = fixture(); await f.bind(); const count = f.calls.length;
  await assert.rejects(f.adapter.answer({ threadId, clientId: "invalid-fence-1", question: "Question", grant: true, budget: { timeoutMs: 1000, maxOutputTokens: 800 }, dispatchFence: "not-callable" }), { code: "invalid_dispatch_fence", uncertainOutcome: false });
  assert.equal(f.calls.length, count);
});
test("native approval is declined and emits only safe owner-attention metadata", async t => {
  const server = createServer(), wss = new WebSocketServer({ server });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const replies = [], attention = []; let peer;
  wss.on("connection", socket => {
    peer = socket;
    socket.on("message", bytes => {
      const message = JSON.parse(bytes.toString());
      if (message.method === "initialize") socket.send(JSON.stringify({ id: message.id, result: {} }));
      if (message.id === "approval-request") replies.push(message);
    });
  });
  const adapter = new CodexQueueAdapter({ spawnProcess: () => {
    const child = new EventEmitter(), socket = connect(server.address().port, "127.0.0.1");
    child.stdout = socket; child.stdin = socket; child.stderr = new PassThrough(); child.kill = () => socket.destroy(); socket.on("close", () => child.emit("close")); return child;
  } });
  t.after(async () => { adapter.close(); for (const socket of wss.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); wss.close(); });
  adapter.events.on("native-attention", event => attention.push(event)); await adapter.open();
  peer.send(JSON.stringify({ id: "approval-request", method: "item/commandExecution/requestApproval", params: { threadId, turnId: "native-turn", command: "PRIVATE NATIVE TOOL INPUT" } }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(replies[0].result, { decision: "decline" }); assert.equal(attention[0].nativeThreadId, threadId);
  assert.ok(!JSON.stringify(attention).includes("PRIVATE"));
});
