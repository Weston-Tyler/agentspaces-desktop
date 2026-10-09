import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { checkCodexProtocol } from "../app/codex-protocol.mjs";
const object = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required });
const string = () => ({ type: "string" });
const array = (items) => ({ type: "array", items });
const enumeration = (...values) => ({ type: "string", enum: values });
const ref = name => ({ $ref: "#/definitions/" + name });
function fixture() {
  const definitions = {
    Input: { oneOf: [object({ type: enumeration("text"), text: string(), text_elements: array(object({})) }, ["type", "text"])] },
    Queue: object({ id: string(), clientUserMessageId: string() }),
    Status: { anyOf: [object({ type: enumeration("idle") }), object({ type: enumeration("notLoaded") }), object({ type: enumeration("active") })] },
    Thread: object({ id: string(), cwd: { allOf: [{ type: "string" }] }, status: ref("Status"), updatedAt: { type: "integer" }, cliVersion: string() }),
    Item: { oneOf: [object({ type: enumeration("userMessage"), clientId: { type: ["string", "null"] }, content: array(ref("Input")) }, ["type", "content"]), object({ type: enumeration("agentMessage"), text: string() })] },
    Turn: object({ id: string(), status: enumeration("completed", "failed", "interrupted", "inProgress"), items: array(ref("Item")) }),
    Sandbox: { oneOf: [object({ type: enumeration("readOnly"), networkAccess: { type: "boolean" } }, ["type"]), object({ type: enumeration("workspaceWrite"), networkAccess: { type: "boolean" }, writableRoots: array(string()) }, ["type"]), object({ type: enumeration("dangerFullAccess") })] },
    Approval: { oneOf: [enumeration("never", "untrusted", "on-request"), object({ granular: object({ mcp_elicitations: { type: "boolean" }, rules: { type: "boolean" }, sandbox_approval: { type: "boolean" } }) })] },
  };
  const schemas = {
    ThreadReadParams: object({ threadId: string(), includeTurns: { type: "boolean" } }, ["threadId"]),
    ThreadReadResponse: object({ thread: ref("Thread") }),
    ThreadListParams: object({ cwd: { anyOf: [string(), array(string()), { type: "null" }] }, archived: { type: ["boolean", "null"] }, limit: { type: ["integer", "null"] }, cursor: { type: ["string", "null"] }, sourceKinds: array(enumeration("cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown")) }, []),
    ThreadListResponse: object({ data: array(ref("Thread")) }),
    ThreadQueueAddParams: object({ threadId: string(), clientUserMessageId: string(), input: array(ref("Input")) }),
    ThreadQueueAddResponse: object({ queuedSubmission: ref("Queue") }),
    ThreadQueueListParams: object({ threadId: string(), cursor: { type: ["string", "null"] }, limit: { type: ["integer", "null"] } }, ["threadId"]),
    ThreadQueueListResponse: object({ data: array(ref("Queue")) }),
    ThreadQueueDeleteParams: object({ threadId: string(), queuedSubmissionId: string() }),
    ThreadQueueDeleteResponse: object({ deleted: { type: "boolean" } }),
    ThreadTurnsListParams: object({ threadId: string(), limit: { type: ["integer", "null"] }, itemsView: { anyOf: [enumeration("full", "summary"), { type: "null" }] } }, ["threadId"]),
    ThreadTurnsListResponse: object({ data: array(ref("Turn")) }),
    ThreadResumeParams: object({ threadId: string() }),
    ThreadResumeResponse: object({ thread: ref("Thread"), cwd: string(), sandbox: ref("Sandbox"), approvalPolicy: ref("Approval"), approvalsReviewer: enumeration("user", "auto_review", "guardian_subagent") }),
  };
  for (const root of Object.values(schemas)) root.definitions = structuredClone(definitions);
  return schemas;
}
const probe = (version, schemas) => checkCodexProtocol("local", { version, collectSchemas: async () => schemas });
test("Native protocol baseline and additive native upgrade retain compatible subset", async () => {
  const baseline = await probe("fixture-baseline", fixture());
  assert.equal(baseline.compatible, true); assert.equal(baseline.status, "protocol-compatible"); assert.match(baseline.contractHash, /^[a-f0-9]{64}$/);
  const upgraded = fixture();
  upgraded.ThreadResumeParams.properties.newOptional = { type: ["string", "null"] };
  upgraded.ThreadTurnsListResponse.definitions.Turn.properties.rootTurnId = { type: ["string", "null"] };
  upgraded.ThreadQueueAddResponse.definitions.Queue.properties.extraOptional = string();
  const verdict = await probe("fixture-additive-upgrade", upgraded);
  assert.equal(verdict.compatible, true); assert.equal(verdict.contractHash, baseline.contractHash);
});
test("Missing schemas, renamed acknowledgement fields and changed types block compatibility", async () => {
  const missing = fixture(); delete missing.ThreadQueueDeleteResponse;
  assert.equal((await probe("fixture-missing-schema", missing)).reason, "missing_schema");
  const renamed = fixture(), queue = renamed.ThreadQueueAddResponse.definitions.Queue;
  queue.properties.submissionId = queue.properties.id; delete queue.properties.id;
  assert.equal((await probe("fixture-renamed-id", renamed)).reason, "required_field_changed");
  const typeChange = fixture(); typeChange.ThreadQueueListResponse.definitions.Queue.properties.id = { type: "integer" };
  assert.equal((await probe("fixture-type-change", typeChange)).reason, "type_changed");
});
test("New required request fields and nested input requirements are rejected", async () => {
  const required = fixture(); required.ThreadResumeParams.properties.extraApproval = string(); required.ThreadResumeParams.required.push("extraApproval");
  assert.equal((await probe("fixture-new-required", required)).reason, "unknown_request_requirement");
  const nested = fixture(), text = nested.ThreadQueueAddParams.definitions.Input.oneOf[0];
  text.properties.mustSupply = string(); text.required.push("mustSupply");
  assert.equal((await probe("fixture-new-input-required", nested)).reason, "unknown_request_requirement");
  const lostRequirement = fixture(); lostRequirement.ThreadQueueAddResponse.definitions.Queue.required = ["id"];
  assert.equal((await probe("fixture-ack-not-required", lostRequirement)).reason, "required_field_changed");
});
test("Removed enum and changed native message discriminator block contract", async () => {
  const changed = fixture(); changed.ThreadResumeResponse.properties.approvalsReviewer.enum = ["user"];
  assert.equal((await probe("fixture-policy-enum-change", changed)).reason, "method_contract_changed");
  const renamed = fixture(); renamed.ThreadTurnsListResponse.definitions.Item.oneOf[1].properties.type.enum = ["assistantText"];
  assert.equal((await probe("fixture-message-tag-change", renamed)).reason, "method_contract_changed");
});
test("Cache is host and exact-version scoped and concurrent probes deduplicate", async () => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const collectSchemas = async () => { calls++; await gate; return fixture(); };
  const first = checkCodexProtocol("local", { version: "fixture-concurrent", collectSchemas }), second = checkCodexProtocol("local", { version: "fixture-concurrent", collectSchemas });
  release(); assert.deepEqual(await first, await second); assert.equal(calls, 1);
  await checkCodexProtocol("local", { version: "fixture-concurrent", collectSchemas }); assert.equal(calls, 1);
  await checkCodexProtocol("remote", { version: "fixture-concurrent", collectSchemas }); assert.equal(calls, 2);
  await checkCodexProtocol("local", { version: "fixture-concurrent-next", collectSchemas }); assert.equal(calls, 3);
});
test("Probe failures are safe and oversized schema material is bounded", async () => {
  const result = await checkCodexProtocol("local", { version: "fixture-unavailable", collectSchemas: async () => { throw new Error("PRIVATE native diagnostic token"); } });
  assert.equal(result.status, "protocol-probe-unavailable"); assert(!JSON.stringify(result).includes("PRIVATE"));
  const huge = fixture(); huge.ThreadReadParams.description = "x".repeat(2097153);
  assert.equal((await probe("fixture-schema-bound", huge)).status, "protocol-probe-unavailable");
});
test("Default collector launches schema generation only, hides windows and cleans owned temp on failure", async () => {
  let folder, killed = false;
  const spawnProcess = (command, args, options) => {
    assert.equal(command, "codex"); assert.deepEqual(args.slice(0, 4), ["app-server", "generate-json-schema", "--experimental", "--out"]);
    assert.equal(options.windowsHide, true); assert.equal(options.shell, false); folder = args[4];
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter(); child.stdin.end = () => queueMicrotask(() => child.emit("close", 1)); child.kill = () => { killed = true; };
    return child;
  };
  const result = await checkCodexProtocol("local", { version: "fixture-native-unavailable", spawnProcess });
  assert.equal(result.status, "protocol-probe-unavailable"); assert.equal(existsSync(folder), false); assert.equal(killed, false);
});
test("Failed verdict TTL expires without exposing native diagnostics", async () => {
  const originalNow = Date.now; let clock = originalNow(), calls = 0;
  Date.now = () => clock;
  try {
    const collectSchemas = async () => { calls++; throw new Error("fixture probe offline"); };
    await checkCodexProtocol("local", { version: "fixture-failure-ttl", collectSchemas });
    clock += 29000; await checkCodexProtocol("local", { version: "fixture-failure-ttl", collectSchemas }); assert.equal(calls, 1);
    clock += 2000; await checkCodexProtocol("local", { version: "fixture-failure-ttl", collectSchemas }); assert.equal(calls, 2);
  } finally { Date.now = originalNow; }
});
test("Successful verdict expires after ten minutes and cache retains at most sixteen versions", async () => {
  const originalNow = Date.now; let clock = originalNow(), calls = 0;
  Date.now = () => clock;
  const collectSchemas = async () => { calls++; return fixture(); };
  try {
    await checkCodexProtocol("local", { version: "fixture-success-ttl", collectSchemas });
    clock += 599000; await checkCodexProtocol("local", { version: "fixture-success-ttl", collectSchemas }); assert.equal(calls, 1);
    clock += 2000; await checkCodexProtocol("local", { version: "fixture-success-ttl", collectSchemas }); assert.equal(calls, 2);
    for (let i = 0; i < 17; i++) await checkCodexProtocol("local", { version: "fixture-capacity-" + i, collectSchemas });
    const before = calls;
    await checkCodexProtocol("local", { version: "fixture-capacity-0", collectSchemas }); assert.equal(calls, before + 1);
  } finally { Date.now = originalNow; }
});
