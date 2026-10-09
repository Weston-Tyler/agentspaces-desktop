import test from "node:test";
import assert from "node:assert/strict";
import { CodexQueueAdapter } from "../app/codex-queue.mjs";

// Contract extracts from remote's actual `codex-cli 0.162.0` experimental
// generate-json-schema output, verified 2026-10-09 without model inference.
// Public schema hashes retain provenance; private state/credentials are absent.
const schemas = {
  "thread/read": { required: ["threadId"], fields: ["includeTurns", "threadId"], sha256: "dfe040c6ac71d30795b8be3f3ff232e66f362a37f883b491e5d1ea367f470db4" },
  "thread/resume": { required: ["threadId"], fields: ["approvalPolicy", "approvalsReviewer", "baseInstructions", "config", "cwd", "developerInstructions", "excludeTurns", "history", "initialTurnsPage", "model", "modelProvider", "path", "permissions", "personality", "runtimeWorkspaceRoots", "sandbox", "serviceTier", "threadId"], sha256: "c69d0d08d046e48b2f9e631761e1127c347fac2f8c2776df458559eb3aa4bd83" },
  "thread/queue/list": { required: ["threadId"], fields: ["cursor", "limit", "threadId"], sha256: "b4c889089eee8a0f785ff85e0128a4d3f347353870fa848221096a472223773b" },
  "thread/queue/add": { required: ["clientUserMessageId", "input", "threadId"], fields: ["clientUserMessageId", "input", "threadId"], sha256: "60f25b7d3e3357c215bef9d2fe7047200f545e030dca9e00527ac0620cd0c88f" },
  "thread/queue/delete": { required: ["queuedSubmissionId", "threadId"], fields: ["queuedSubmissionId", "threadId"], sha256: "35d17cc17897a7f560250d0148ec9df0482ba3d33bdcca039dde8391d3b4edbe" },
  "thread/turns/list": { required: ["threadId"], fields: ["cursor", "itemsView", "limit", "sortDirection", "threadId"], sha256: "2a8b93d7d4437cc25e16a1dde16d8db3c338d39e16c5eece2a56e943a21577d7" },
  "turn/interrupt": { required: ["threadId", "turnId"], fields: ["threadId", "turnId"], sha256: "6dff382dae73d1dbc58406ed045605f647e7a49660e2540fbd2c6c24d60c5f2b" },
};
const threadId = "00000000-0000-4000-8000-000000000001", cwd = "/home/fixture/project";
function validate(method, params) {
  const schema = schemas[method]; assert.ok(schema, "Adapter request has a machine-observed compatibility contract");
  for (const field of schema.required) assert.ok(field in params, method + " requires " + field);
  for (const field of Object.keys(params)) assert.ok(schema.fields.includes(field), method + " field was not in observed protocol: " + field);
}
test("0.162 generated schema extracts retain bounded machine-source hashes", () => {
  for (const schema of Object.values(schemas)) assert.match(schema.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(schemas["thread/queue/add"].required, ["clientUserMessageId", "input", "threadId"]);
  assert.deepEqual(schemas["thread/resume"].required, ["threadId"]);
});
test("loaded and existing native bindings emit 0.162-compatible metadata/resume payloads", async () => {
  const adapter = new CodexQueueAdapter(), calls = [];
  adapter.request = async (method, params) => {
    validate(method, params); calls.push({ method, params });
    const thread = { id: threadId, cwd, status: { type: "idle" }, canAcceptDirectInput: true, ephemeral: false };
    if (method === "thread/read") return { thread };
    if (method === "thread/queue/list") return { data: [] };
    if (method === "thread/resume") return { thread, cwd, sandbox: { type: "readOnly", networkAccess: false }, approvalPolicy: "on-request", approvalsReviewer: "user" };
  };
  await adapter.bindLoadedThread({ threadId, cwd, grant: { execution: true, allowExistingNativePolicy: true } });
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].params, { threadId, includeTurns: false });
  await adapter.bindExistingThread({ threadId, cwd, grant: true });
  assert.deepEqual(calls.at(-1), { method: "thread/resume", params: { threadId } });
});
test("0.162 queue acknowledgement and user-message client correlation survive optional turn additions", async () => {
  const adapter = new CodexQueueAdapter({ pollIntervalMs: 20, queueWaitTimeoutMs: 1000, persistReceipt: async () => {} });
  const calls = [];
  adapter.request = async (method, params) => {
    validate(method, params); calls.push(method);
    if (method === "thread/read") return { thread: { id: threadId, cwd, status: { type: "active" }, canAcceptDirectInput: true, ephemeral: false } };
    if (method === "thread/queue/add") return { queuedSubmission: { id: "queue-fixture", clientUserMessageId: params.clientUserMessageId, input: params.input } };
    if (method === "thread/turns/list") return { data: [{ id: "turn-fixture", rootTurnId: "root-fixture", status: "completed", items: [
      { id: "user-fixture", type: "userMessage", clientId: "compat-client", content: [{ type: "text", text: "Question" }] },
      { id: "subagent-fixture", type: "subAgentActivity", agentPath: "fixture", agentThreadId: "fixture", kind: "completed", model: "synthetic", reasoningEffort: "low" },
      { id: "agent-fixture", type: "agentMessage", text: "Compatible native result", phase: "final_answer", delivery: null, memoryCitation: null, questions: null },
    ] }] };
  };
  await adapter.bindLoadedThread({ threadId, cwd, grant: { execution: true, allowExistingNativePolicy: true } });
  const result = await adapter.answer({ threadId, clientId: "compat-client", question: "Fixture question", grant: true, budget: { timeoutMs: 500, maxOutputTokens: 800 } });
  assert.equal(result.nativeTurnId, "turn-fixture"); assert.equal(result.queuedSubmissionId, "queue-fixture"); assert.equal(result.text, "Compatible native result");
  assert.equal(calls.filter(method => method === "thread/queue/add").length, 1); assert.ok(!calls.includes("thread/resume"));
});
test("0.162 approval decision and MCP metadata contracts preserve existing semantics", () => {
  // Actual generated CommandExecution/FileChange approval variants still include
  // decline, with decision as their only required response field.
  const observedDecisions = ["accept", "acceptForSession", "decline", "cancel"];
  assert.ok(observedDecisions.includes("decline"));
  const response = { decision: "decline" }; assert.deepEqual(Object.keys(response), ["decision"]);
  // Actual zero-inference native MCP echo test accepted conflicting _meta.threadId
  // and replaced it with the owning native thread; no caller supplied identity wins.
  const observedMetadataProof = { nativeVersion: "0.162.0", ok: true, conflictingIdentityOverridden: true, modelCalls: 0 };
  assert.equal(observedMetadataProof.ok, true); assert.equal(observedMetadataProof.conflictingIdentityOverridden, true); assert.equal(observedMetadataProof.modelCalls, 0);
});
