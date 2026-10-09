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
      return { queuedSubmission: { id: "queued-request", clientUserMessageId: params.clientUserMessageId } };
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
test("loaded active source accepts explicitly granted input without resume or policy assertions", async () => {
  const f = fixture({ status: "active", emitsTools: true }), events = [];
  const target = await f.adapter.bindLoadedThread({ threadId, cwd, grant: { execution: true, allowExistingNativePolicy: true } });
  assert.deepEqual(f.calls, [{ method: "thread/read", params: { threadId, includeTurns: false } }]);
  assert.equal(target.permissionProof.source, "loaded-native-input-target"); assert.equal(target.permissionProof.policyKnown, false); assert.equal(target.permissionProof.sandbox, undefined);
  f.adapter.events.on("queued", event => events.push(event));
  const result = await f.adapter.answer({ threadId, clientId: "loaded-busy-client", question: "A queued conversation message", grant: true, budget: { timeoutMs: 1000, maxOutputTokens: 800 } });
  assert.equal(result.receipt.status, "completed"); assert.ok(!f.calls.some(call => call.method === "thread/resume" || call.method === "thread/start" || call.method === "turn/interrupt"));
  assert.deepEqual(events, [{ threadId, clientId: "loaded-busy-client", queuedSubmissionId: "queued-request", status: "queued" }]);
  assert.equal(f.adapter.activeOwnedTurns.size, 0);
});
test("loaded target requires explicit native-policy grant and rejects cold or stale identities", async () => {
  const f = fixture({ status: "active" });
  await assert.rejects(f.adapter.bindLoadedThread({ threadId, cwd, grant: true }), { code: "loaded_native_input_grant_required" }); assert.equal(f.calls.length, 0);
  await f.adapter.bindLoadedThread({ threadId, cwd, grant: { execution: true, allowExistingNativePolicy: true } });
  f.adapter.request = async () => ({ thread: { id: threadId, cwd, status: { type: "notLoaded" }, canAcceptDirectInput: false } });
  assert.equal((await f.adapter.eligible(threadId)).eligible, false);
  const g = fixture({ status: "notLoaded" });
  await assert.rejects(g.adapter.bindLoadedThread({ threadId, cwd, grant: { execution: true, allowExistingNativePolicy: true } }), { code: "native_loaded_target_not_available" });
  const h = fixture({ status: "idle" });
  await assert.rejects(h.adapter.bindLoadedThread({ threadId, cwd: "/another", grant: { execution: true, allowExistingNativePolicy: true } }), { code: "native_loaded_target_identity_mismatch" });
});
function pollingFixture({ data, fence, queueWaitTimeoutMs = 300 } = {}) {
  const receipts = [], calls = [];
  const adapter = new CodexQueueAdapter({ pollIntervalMs: 20, queueWaitTimeoutMs, persistReceipt: async receipt => receipts.push(structuredClone(receipt)) });
  adapter.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { id: threadId, cwd, status: { type: "active" }, canAcceptDirectInput: true, ephemeral: false } };
    if (method === "thread/queue/add") return { queuedSubmission: { id: "poll-queue", clientUserMessageId: params.clientUserMessageId } };
    if (method === "thread/turns/list") return typeof data === "function" ? data(calls.filter(call => call.method === "thread/turns/list").length) : { data: data ?? [] };
    if (method === "thread/queue/delete") return { deleted: true };
    if (method === "turn/interrupt") return {};
    if (method === "thread/queue/list") return { data: [{ id: "poll-queue", clientUserMessageId: "poll-client" }] };
    throw new Error("Unexpected method");
  };
  const bind = () => adapter.bindLoadedThread({ threadId, cwd, grant: { execution: true, allowExistingNativePolicy: true } });
  const answer = extra => adapter.answer({ threadId, clientId: "poll-client", question: "Queued fixture", grant: true, dispatchFence: fence ?? (() => true), budget: { timeoutMs: 100, maxOutputTokens: 800 }, ...extra });
  return { adapter, calls, receipts, bind, answer };
}
test("loaded request polls only after acknowledgement and returns exact-client result without other turn text", async () => {
  const f = pollingFixture({ data: [{ id: "foreign-turn", status: "completed", items: [{ type: "userMessage", clientId: "foreign-client" }, { type: "agentMessage", text: "PRIVATE FOREIGN RESULT" }] }, { id: "own-polled-turn", status: "completed", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 }, items: [{ type: "userMessage", clientId: "poll-client" }, { type: "agentMessage", text: "Own polled reply" }] }] });
  await f.bind(); const result = await f.answer();
  assert.equal(result.nativeTurnId, "own-polled-turn"); assert.equal(result.text, "Own polled reply"); assert.equal(result.usage.totalTokens, 6);
  assert.ok(!JSON.stringify([result, f.receipts]).includes("PRIVATE"));
  const calls = f.calls.map(call => call.method); assert.ok(calls.indexOf("thread/queue/add") < calls.indexOf("thread/turns/list"));
  assert.deepEqual(f.calls.find(call => call.method === "thread/turns/list").params, { threadId, limit: 8, itemsView: "summary" });
  const count = f.calls.length; await new Promise(resolve => setTimeout(resolve, 35)); assert.equal(f.calls.length, count);
  assert.ok(!calls.includes("thread/resume") && !calls.includes("thread/start"));
});
test("busy queued waiting is separate from execution timeout and repeated polls never reset running budget", async () => {
  const f = pollingFixture({ queueWaitTimeoutMs: 500, data: count => count < 4 ? { data: [] } : { data: [{ id: "own-running", status: "inProgress", items: [{ type: "userMessage", clientId: "poll-client" }] }] } });
  await f.bind();
  await assert.rejects(f.answer({ budget: { timeoutMs: 30, maxOutputTokens: 800 } }), { code: "native_queue_timeout" });
  assert.ok(f.calls.filter(call => call.method === "thread/turns/list").length >= 4, "short execution budget did not expire while waiting for a busy native owner");
  assert.deepEqual(f.calls.find(call => call.method === "turn/interrupt").params, { threadId, turnId: "own-running" });
});
test("read uncertainty backs off without model retry and can recover the same native client", async () => {
  const f = pollingFixture({ data: count => { if (count === 1) throw new Error("PRIVATE metadata diagnostic"); return { data: [{ id: "own-recovered", status: "completed", items: [{ type: "userMessage", clientId: "poll-client" }, { type: "agentMessage", text: "Recovered reply" }] }] }; } });
  await f.bind(); const result = await f.answer();
  assert.equal(result.text, "Recovered reply"); assert.equal(f.calls.filter(call => call.method === "thread/queue/add").length, 1);
});
test("poll-time grant revocation cancels exact queue without any further content lookup", async () => {
  let checks = 0;
  const f = pollingFixture({ fence: () => ++checks < 3 }); await f.bind();
  await assert.rejects(f.answer(), { code: "native_delivery_grant_revoked", uncertainOutcome: true });
  assert.equal(f.calls.filter(call => call.method === "thread/turns/list").length, 0);
  assert.equal(f.calls.filter(call => call.method === "thread/queue/list").length, 0);
  assert.deepEqual(f.calls.find(call => call.method === "thread/queue/delete").params, { threadId, queuedSubmissionId: "poll-queue" });
});
test("poll constructor bounds and queue wait ceiling are finite", async () => {
  assert.throws(() => new CodexQueueAdapter({ pollIntervalMs: 1 }), { code: "invalid_native_delivery_poll_bound" });
  assert.throws(() => new CodexQueueAdapter({ queueWaitTimeoutMs: 1800001 }), { code: "invalid_native_delivery_poll_bound" });
  const f = pollingFixture({ queueWaitTimeoutMs: 35 }); await f.bind();
  await assert.rejects(f.answer(), { code: "native_queue_timeout" });
});
test("large foreign full history is never fetched when reconciling an exact completed summary", async () => {
  const f = pollingFixture({ data: [{ id: "foreign", status: "completed", items: [{ type: "userMessage", clientId: "foreign" }, { type: "agentMessage", text: "PRIVATE foreign summary" }] }, { id: "own-final", status: "completed", items: [{ type: "userMessage", clientId: "poll-client" }, { type: "agentMessage", phase: "commentary", text: "Own progress" }, { type: "agentMessage", phase: "final_answer", text: "Exact final result" }] }] });
  await f.bind();
  const request = f.adapter.request;
  f.adapter.request = async (method, params) => { if (method === "thread/turns/list") assert.equal(params.itemsView, "summary", "a full read would exceed the observed native frame bound"); return request(method, params); };
  const result = await f.adapter.reconcileAnswer({ threadId, clientId: "poll-client", grant: true });
  assert.equal(result.status, "completed"); assert.equal(result.text, "Exact final result"); assert.equal(result.nativeTurnId, "own-final"); assert.equal(result.usage.known, false);
  assert.ok(!JSON.stringify(result).includes("PRIVATE")); assert.ok(!f.calls.some(call => ["thread/queue/add", "thread/start", "thread/resume", "turn/interrupt"].includes(call.method)));
});
test("missing summary text reads bounded items from the own exact turn only", async () => {
  const f = pollingFixture({ data: [{ id: "own-no-text", status: "completed", items: [{ type: "userMessage", clientId: "poll-client" }] }] }); await f.bind();
  const request = f.adapter.request;
  f.adapter.request = async (method, params) => {
    if (method === "thread/items/list") {
      f.calls.push({ method, params }); assert.equal(params.threadId, threadId); assert.equal(params.turnId, "own-no-text");
      return { data: [{ turnId: "own-no-text", item: { type: "agentMessage", phase: "final_answer", text: "Own paged final" } }], nextCursor: null };
    }
    return request(method, params);
  };
  const result = await f.adapter.reconcileAnswer({ threadId, clientId: "poll-client", grant: true }); assert.equal(result.text, "Own paged final");
  assert.equal(f.calls.filter(call => call.method === "thread/items/list").length, 1);
});
test("unknown or textless completed own turn never fabricates an answer or retries inference", async () => {
  const f = pollingFixture({ data: [{ id: "foreign-only", status: "completed", items: [{ type: "userMessage", clientId: "foreign" }, { type: "agentMessage", text: "PRIVATE" }] }] }); await f.bind();
  const unknown = await f.adapter.reconcileAnswer({ threadId, clientId: "not-present", grant: true }); assert.equal(unknown.status, "uncertain"); assert.equal(unknown.retryAllowed, false); assert.equal(unknown.text, undefined);
  const g = pollingFixture({ data: [{ id: "own-empty", status: "completed", items: [{ type: "userMessage", clientId: "poll-client" }] }] }); await g.bind();
  const request = g.adapter.request; g.adapter.request = async (method, params) => method === "thread/items/list" ? { data: [], nextCursor: null } : request(method, params);
  const empty = await g.adapter.reconcileAnswer({ threadId, clientId: "poll-client", grant: true }); assert.equal(empty.status, "uncertain"); assert.equal(empty.text, undefined);
  assert.ok(![...f.calls, ...g.calls].some(call => call.method === "thread/queue/add"));
});
test("foreign own-turn paging identity and missing reconciliation grants are refused", async () => {
  const f = pollingFixture({ data: [{ id: "own-no-text", status: "completed", items: [{ type: "userMessage", clientId: "poll-client" }] }] }); await f.bind();
  const request = f.adapter.request; f.adapter.request = async (method, params) => method === "thread/items/list" ? { data: [{ turnId: "other-turn", item: { type: "agentMessage", text: "PRIVATE" } }] } : request(method, params);
  await assert.rejects(f.adapter.reconcileAnswer({ threadId, clientId: "poll-client", grant: true }), { code: "native_own_item_identity_mismatch" });
  await assert.rejects(f.adapter.reconcileAnswer({ threadId, clientId: "poll-client", grant: false }), { code: "reconciliation_grant_required" });
});
test("reconciliation does not silently truncate a native result above discussion limit", async () => {
  const f = pollingFixture({ data: [{ id: "own-long", status: "completed", items: [{ type: "userMessage", clientId: "poll-client" }, { type: "agentMessage", phase: "final_answer", text: "x".repeat(8001) }] }] }); await f.bind();
  const result = await f.adapter.reconcileAnswer({ threadId, clientId: "poll-client", grant: true });
  assert.equal(result.status, "uncertain"); assert.equal(result.reason, "output_limit"); assert.equal(result.clientId, "poll-client"); assert.equal(result.text, undefined); assert.equal(result.queuedSubmissionId, undefined);
});
test("cold completed history uses a separate read-only target without execution authority", async () => {
  const adapter = new CodexQueueAdapter({ persistReceipt: async () => {} }), calls = [];
  adapter.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { id: threadId, cwd, status: { type: "notLoaded" }, canAcceptDirectInput: null } };
    if (method === "thread/turns/list") return { data: [{ id: "cold-completed", status: "completed", items: [{ type: "userMessage", clientId: "cold-client" }, { type: "agentMessage", phase: "final_answer", text: "Already completed response" }] }] };
    throw new Error("Read-only target cannot mutate native state");
  };
  const bound = await adapter.bindReadTarget({ threadId, cwd, grant: true }); assert.equal(bound.executionAuthorized, false); assert.equal(adapter.proofs.size, 0);
  const answer = await adapter.reconcileAnswer({ threadId, clientId: "cold-client", grant: true }); assert.equal(answer.status, "completed"); assert.equal(answer.text, "Already completed response");
  await assert.rejects(adapter.answer({ threadId, clientId: "not-authorized", question: "No new question", grant: true, budget: { timeoutMs: 1000, maxOutputTokens: 800 } }));
  assert.ok(calls.every(call => ["thread/read", "thread/turns/list"].includes(call.method)));
});
test("historical read target rechecks exact identity and cwd and still requires caller grant", async () => {
  const adapter = new CodexQueueAdapter(); let changed = false;
  adapter.request = async () => ({ thread: { id: threadId, cwd: changed ? "/changed" : cwd, status: { type: "notLoaded" } } });
  await adapter.bindReadTarget({ threadId, cwd, grant: true }); changed = true;
  await assert.rejects(adapter.reconcileAnswer({ threadId, clientId: "read-client", grant: true }), { code: "native_read_target_identity_mismatch" });
  await assert.rejects(adapter.reconcileAnswer({ threadId, clientId: "read-client", grant: false }), { code: "reconciliation_grant_required" });
  await assert.rejects(adapter.bindReadTarget({ threadId, cwd, grant: false }), { code: "native_read_target_grant_required" });
});
test("only correlated owned-turn approvals are declined; foreign native requests are untouched", async t => {
  const server = createServer(), wss = new WebSocketServer({ server });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const replies = [], attention = [], foreign = []; let peer;
  wss.on("connection", socket => {
    peer = socket;
    socket.on("message", bytes => {
      const message = JSON.parse(bytes.toString());
      if (message.method === "initialize") socket.send(JSON.stringify({ id: message.id, result: {} }));
      if (["approval-request", "foreign-approval", "uncorrelated-approval", "late-approval", "foreign-input"].includes(message.id)) replies.push(message);
    });
  });
  const adapter = new CodexQueueAdapter({ persistReceipt: async () => {}, spawnProcess: () => {
    const child = new EventEmitter(), socket = connect(server.address().port, "127.0.0.1");
    child.stdout = socket; child.stdin = socket; child.stderr = new PassThrough(); child.kill = () => socket.destroy(); socket.on("close", () => child.emit("close")); return child;
  } });
  t.after(async () => { adapter.close(); for (const socket of wss.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); wss.close(); });
  adapter.events.on("native-attention", event => attention.push(event)); await adapter.open();
  adapter.events.on("foreign-native-request", event => foreign.push(event));
  adapter.request = async (method, params) => method === "thread/read" ? { thread: { id: threadId, cwd, status: { type: "active" }, canAcceptDirectInput: true, ephemeral: false } } : method === "thread/queue/add" ? { queuedSubmission: { id: "fixture-queue", clientUserMessageId: params.clientUserMessageId } } : {};
  await adapter.bindLoadedThread({ threadId, cwd, grant: { execution: true, allowExistingNativePolicy: true } });
  const answer = adapter.answer({ threadId, clientId: "owned-approval-client", question: "Synthetic test", grant: true, budget: { timeoutMs: 1000, maxOutputTokens: 800 } });
  await new Promise(resolve => setImmediate(resolve));
  peer.send(JSON.stringify({ method: "item/started", params: { threadId, turnId: "native-turn", item: { type: "userMessage", clientId: "another-client" } } }));
  peer.send(JSON.stringify({ id: "uncorrelated-approval", method: "item/commandExecution/requestApproval", params: { threadId, turnId: "native-turn", command: "PRIVATE FOREIGN INPUT" } }));
  peer.send(JSON.stringify({ id: "foreign-input", method: "tool/requestUserInput", params: { threadId, turnId: "foreign-turn" } }));
  peer.send(JSON.stringify({ method: "item/started", params: { threadId, turnId: "native-turn", item: { type: "userMessage", clientId: "owned-approval-client" } } }));
  peer.send(JSON.stringify({ id: "foreign-approval", method: "item/commandExecution/requestApproval", params: { threadId, turnId: "foreign-turn" } }));
  peer.send(JSON.stringify({ id: "approval-request", method: "item/commandExecution/requestApproval", params: { threadId, turnId: "native-turn", command: "PRIVATE NATIVE TOOL INPUT" } }));
  const approvalDeadline = Date.now() + 1000;
  while (replies.length < 1 && Date.now() < approvalDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(replies.length, 1); assert.equal(replies[0].id, "approval-request"); assert.deepEqual(replies[0].result, { decision: "decline" }); assert.equal(attention[0].nativeThreadId, threadId);
  assert.equal(foreign.length, 3);
  peer.send(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: "native-turn", status: "completed", items: [{ type: "agentMessage", text: "Fixture done" }] } } }));
  await answer; assert.equal(adapter.activeOwnedTurns.size, 0);
  peer.send(JSON.stringify({ id: "late-approval", method: "item/commandExecution/requestApproval", params: { threadId, turnId: "native-turn" } }));
  const foreignDeadline = Date.now() + 1000;
  while (foreign.length < 4 && Date.now() < foreignDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(foreign.length, 4); assert.equal(replies.length, 1);
  assert.ok(!JSON.stringify(attention).includes("PRIVATE"));
  assert.ok(!JSON.stringify(foreign).includes("PRIVATE"));
});
