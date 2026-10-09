import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { createHash } from "node:crypto";
const names = ["ThreadReadParams", "ThreadReadResponse", "ThreadListParams", "ThreadListResponse", "ThreadQueueAddParams", "ThreadQueueAddResponse", "ThreadQueueListParams", "ThreadQueueListResponse", "ThreadQueueDeleteParams", "ThreadQueueDeleteResponse", "ThreadTurnsListParams", "ThreadTurnsListResponse", "ThreadResumeParams", "ThreadResumeResponse"];
const fail = reason => Object.assign(new Error(reason), { reason });
const cache = new Map(), pending = new Map();
const MAX = 2097152;
function variants(schema, root, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 24) throw fail("type_changed");
  if (schema.$ref) {
    if (!schema.$ref.startsWith("#/")) throw fail("method_contract_changed");
    const target = schema.$ref.slice(2).split("/").reduce((value, part) => value?.[part.replaceAll("~1", "/").replaceAll("~0", "~")], root);
    return variants(target, root, depth + 1);
  }
  if (schema.oneOf || schema.anyOf) return (schema.oneOf ?? schema.anyOf).flatMap(s => variants(s, root, depth + 1));
  if (schema.allOf) {
    let result = [{ ...schema, allOf: undefined }];
    for (const part of schema.allOf) result = result.flatMap(base => variants(part, root, depth + 1).map(extra => ({ ...base, ...extra, properties: { ...base.properties, ...extra.properties }, required: [...new Set([...(base.required ?? []), ...(extra.required ?? [])])] })));
    return result;
  }
  return [schema];
}
function at(root, path, required = false) {
  let nodes = variants(root, root);
  for (const step of path.split(".").filter(Boolean)) {
    if (step === "[]") {
      const arrays = nodes.filter(n => (Array.isArray(n.type) ? n.type : [n.type]).includes("array"));
      if (!arrays.length || arrays.some(n => !n.items)) throw fail("type_changed");
      nodes = arrays.flatMap(n => variants(n.items, root));
    } else if (step.startsWith("@")) {
      nodes = nodes.filter(n => n.properties?.type && variants(n.properties.type, root).some(t => t.enum?.includes(step.slice(1)) || t.const === step.slice(1)));
      if (!nodes.length) throw fail("method_contract_changed");
    } else {
      const objects = nodes.filter(n => n.properties?.[step]);
      if (!objects.length) throw fail("required_field_changed");
      if (required && objects.some(n => !(n.required ?? []).includes(step))) throw fail("required_field_changed");
      nodes = objects.flatMap(n => variants(n.properties[step], root));
    }
  }
  return nodes;
}
function checkType(root, path, type, { required = true, nullable = false, enums, alternatives = [], closedEnum = false } = {}) {
  const nodes = at(root, path, required), types = new Set(nodes.flatMap(n => n.type ? (Array.isArray(n.type) ? n.type : [n.type]) : n.properties ? ["object"] : []));
  if (!types.has(type) || [...types].some(t => t !== type && !alternatives.includes(t) && !(nullable && t === "null"))) throw fail("type_changed");
  if (enums) {
    const values = new Set(nodes.flatMap(n => n.enum ?? (n.const === undefined ? [] : [n.const])));
    if (enums.some(value => !values.has(value)) || closedEnum && [...values].some(value => !enums.includes(value))) throw fail("method_contract_changed");
  }
}
function requestFields(root, allowed) {
  for (const node of variants(root, root)) if ((node.required ?? []).some(field => !allowed.includes(field))) throw fail("unknown_request_requirement");
}
function verify(schemas) {
  if (Buffer.byteLength(JSON.stringify(schemas)) > MAX) throw fail("protocol_probe_unavailable");
  for (const name of names) if (!schemas[name] || typeof schemas[name] !== "object") throw fail("missing_schema");
  const checks = [];
  const typed = (name, path, type, options) => { checkType(schemas[name], path, type, options); checks.push({ name, path, type, options: options ?? {} }); };
  const optional = { required: false, nullable: true };
  const requests = {
    ThreadReadParams: ["threadId", "includeTurns"], ThreadListParams: ["cwd", "sourceKinds", "archived", "limit", "cursor"],
    ThreadQueueAddParams: ["threadId", "clientUserMessageId", "input"], ThreadQueueListParams: ["threadId", "cursor", "limit"],
    ThreadQueueDeleteParams: ["threadId", "queuedSubmissionId"], ThreadTurnsListParams: ["threadId", "limit", "itemsView"], ThreadResumeParams: ["threadId"],
  };
  for (const [name, fields] of Object.entries(requests)) requestFields(schemas[name], fields);
  for (const name of ["ThreadReadParams", "ThreadQueueAddParams", "ThreadQueueListParams", "ThreadQueueDeleteParams", "ThreadTurnsListParams", "ThreadResumeParams"]) typed(name, "threadId", "string");
  typed("ThreadReadParams", "includeTurns", "boolean", { required: false });
  for (const [path, type] of [["archived", "boolean"], ["cursor", "string"], ["limit", "integer"], ["sourceKinds", "array"]]) typed("ThreadListParams", path, type, optional);
  typed("ThreadListParams", "cwd", "string", { ...optional, alternatives: ["array"] });
  typed("ThreadListParams", "sourceKinds.[]", "string", { required: false, enums: ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"] });
  for (const name of ["ThreadQueueListParams", "ThreadTurnsListParams"]) typed(name, "limit", "integer", optional);
  typed("ThreadQueueListParams", "cursor", "string", optional);
  typed("ThreadTurnsListParams", "itemsView", "string", { ...optional, enums: ["full", "summary"] });
  typed("ThreadQueueAddParams", "clientUserMessageId", "string"); typed("ThreadQueueAddParams", "input", "array");
  typed("ThreadQueueAddParams", "input.[].@text.text", "string"); typed("ThreadQueueAddParams", "input.[].@text.type", "string", { enums: ["text"] });
  typed("ThreadQueueAddParams", "input.[].@text.text_elements", "array", { required: false });
  for (const node of at(schemas.ThreadQueueAddParams, "input.[].@text")) if ((node.required ?? []).some(field => !["type", "text", "text_elements"].includes(field))) throw fail("unknown_request_requirement");
  typed("ThreadQueueDeleteParams", "queuedSubmissionId", "string");
  for (const path of ["queuedSubmission.id", "queuedSubmission.clientUserMessageId"]) typed("ThreadQueueAddResponse", path, "string");
  typed("ThreadQueueListResponse", "data", "array");
  for (const path of ["data.[].id", "data.[].clientUserMessageId"]) typed("ThreadQueueListResponse", path, "string");
  typed("ThreadQueueDeleteResponse", "deleted", "boolean");
  typed("ThreadTurnsListResponse", "data", "array");
  typed("ThreadTurnsListResponse", "data.[].id", "string");
  typed("ThreadTurnsListResponse", "data.[].status", "string", { enums: ["completed", "failed", "interrupted"] });
  typed("ThreadTurnsListResponse", "data.[].items", "array");
  typed("ThreadTurnsListResponse", "data.[].items.[].@userMessage.clientId", "string", optional);
  typed("ThreadTurnsListResponse", "data.[].items.[].@userMessage.content", "array");
  typed("ThreadTurnsListResponse", "data.[].items.[].@userMessage.content.[].@text.text", "string");
  typed("ThreadTurnsListResponse", "data.[].items.[].@agentMessage.text", "string");
  for (const name of ["ThreadReadResponse", "ThreadResumeResponse"]) {
    typed(name, "thread", "object"); typed(name, "thread.id", "string"); typed(name, "thread.cwd", "string");
    typed(name, "thread.status", "object");
    typed(name, "thread.status.@idle.type", "string", { enums: ["idle"] }); typed(name, "thread.status.@notLoaded.type", "string", { enums: ["notLoaded"] });
  }
  typed("ThreadListResponse", "data", "array"); typed("ThreadListResponse", "data.[].id", "string"); typed("ThreadListResponse", "data.[].cwd", "string");
  typed("ThreadListResponse", "data.[].updatedAt", "integer"); typed("ThreadListResponse", "data.[].cliVersion", "string");
  typed("ThreadResumeResponse", "cwd", "string");
  typed("ThreadResumeResponse", "sandbox", "object");
  for (const tag of ["readOnly", "workspaceWrite", "dangerFullAccess"]) typed("ThreadResumeResponse", "sandbox.@" + tag + ".type", "string", { enums: [tag] });
  typed("ThreadResumeResponse", "sandbox.@readOnly.networkAccess", "boolean", { required: false });
  typed("ThreadResumeResponse", "sandbox.@workspaceWrite.networkAccess", "boolean", { required: false });
  typed("ThreadResumeResponse", "sandbox.@workspaceWrite.writableRoots", "array", { required: false });
  typed("ThreadResumeResponse", "approvalsReviewer", "string", { enums: ["user", "auto_review", "guardian_subagent"], closedEnum: true });
  // Approval supports string policy or the existing structured granular form.
  const approvals = at(schemas.ThreadResumeResponse, "approvalPolicy", true);
  const policy = approvals.find(n => n.type === "string");
  const allowedPolicies = ["untrusted", "on-request", "never"];
  if (!policy || allowedPolicies.some(value => !policy.enum?.includes(value)) || policy.enum.some(value => !allowedPolicies.includes(value))) throw fail("method_contract_changed");
  if (approvals.some(n => !["string", "object"].includes(n.type))) throw fail("type_changed");
  for (const field of ["mcp_elicitations", "rules", "sandbox_approval"]) typed("ThreadResumeResponse", "approvalPolicy.granular." + field, "boolean");
  return createHash("sha256").update(JSON.stringify({ contract: "desktop-codex-read-queue-v1", requests, names, checks, allowedPolicies, textInputFields: ["type", "text", "text_elements"] })).digest("hex");
}
async function cleanup(folder) {
  const absolute = resolve(folder);
  if (dirname(absolute) !== resolve(tmpdir()) || !/^agentspaces-protocol-[A-Za-z0-9_-]+$/.test(basename(absolute))) throw fail("protocol_probe_unavailable");
  await rm(absolute, { recursive: true, force: true });
}
function run(spawnProcess, command, args, input = "", capture = false) {
  return new Promise((yes, no) => {
    let child, data = "", size = 0, done = false;
    const finish = (error, result) => { if (done) return; done = true; clearTimeout(timer); error ? no(fail("protocol_probe_unavailable")) : yes(result); };
    const timer = setTimeout(() => { child?.kill(); finish(true); }, 20000);
    try {
      child = spawnProcess(command, args, { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
      child.stderr.on("data", () => {});
      child.stdout.on("data", chunk => { size += chunk.length; if (size > MAX) { child.kill(); finish(true); } else if (capture) data += chunk.toString(); });
      child.on("error", () => finish(true)); child.on("close", code => finish(code !== 0, data));
      child.stdin.on("error", () => finish(true)); child.stdin.end(input);
    } catch { finish(true); }
  });
}
async function collect({ host, spawnProcess }) {
  if (host === "remote") {
    const script = "import{spawn}from'node:child_process';import{mkdtemp,readFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join,resolve,dirname,basename}from'node:path';const root=await mkdtemp(join(tmpdir(),'agentspaces-protocol-'));try{await new Promise((yes,no)=>{const c=spawn('codex',['app-server','generate-json-schema','--experimental','--out',root],{stdio:['ignore','ignore','ignore']});const t=setTimeout(()=>{c.kill();no(new Error())},18000);c.on('error',()=>{clearTimeout(t);no(new Error())});c.on('close',n=>{clearTimeout(t);n===0?yes():no(new Error())})});const names=" + JSON.stringify(names) + ";const schemas={};for(const n of names)schemas[n]=JSON.parse(await readFile(join(root,'v2',n+'.json'),'utf8'));const text=JSON.stringify(schemas);if(Buffer.byteLength(text)>2097152)throw new Error();process.stdout.write(text)}finally{if(dirname(resolve(root))!==resolve(tmpdir())||!/^agentspaces-protocol-[A-Za-z0-9_-]+$/.test(basename(root)))throw new Error();await rm(root,{recursive:true,force:true})}";
    try { return JSON.parse(await run(spawnProcess, "ssh", ["remote", "node --input-type=module -"], script, true)); } catch { throw fail("protocol_probe_unavailable"); }
  }
  const folder = await mkdtemp(join(tmpdir(), "agentspaces-protocol-"));
  try {
    await run(spawnProcess, "codex", ["app-server", "generate-json-schema", "--experimental", "--out", folder]);
    const schemas = {};
    for (const name of names) { const text = await readFile(join(folder, "v2", name + ".json"), "utf8"); if (Buffer.byteLength(text) > MAX) throw fail("protocol_probe_unavailable"); schemas[name] = JSON.parse(text); }
    return schemas;
  } catch { throw fail("protocol_probe_unavailable"); }
  finally { await cleanup(folder); }
}
export async function checkCodexProtocol(host, { version, spawnProcess = spawn, collectSchemas = collect } = {}) {
  const safeVersion = typeof version === "string" && /^[A-Za-z0-9. +_-]{1,100}$/.test(version) ? version : null;
  if (!["local", "remote"].includes(host) || !safeVersion) return { compatible: false, status: "protocol-probe-unavailable", version: safeVersion, reason: "protocol_probe_unavailable", contractHash: null, checkedAt: new Date().toISOString() };
  const key = host + "\0" + safeVersion, old = cache.get(key);
  if (old && old.expiresAt > Date.now()) return { ...old.verdict };
  if (pending.has(key)) return pending.get(key);
  const operation = (async () => {
    let verdict;
    try {
      const schemas = await collectSchemas({ host, version: safeVersion, spawnProcess });
      const contractHash = verify(schemas);
      verdict = { compatible: true, status: "protocol-compatible", version: safeVersion, reason: "contract_subset_verified", contractHash, checkedAt: new Date().toISOString() };
    } catch (error) {
      const reason = ["missing_schema", "required_field_changed", "type_changed", "unknown_request_requirement", "method_contract_changed"].includes(error.reason) ? error.reason : "protocol_probe_unavailable";
      verdict = { compatible: false, status: reason === "protocol_probe_unavailable" ? "protocol-probe-unavailable" : "protocol-incompatible", version: safeVersion, reason, contractHash: null, checkedAt: new Date().toISOString() };
    }
    cache.delete(key); cache.set(key, { verdict, expiresAt: Date.now() + (verdict.compatible ? 600000 : 30000) });
    while (cache.size > 16) cache.delete(cache.keys().next().value);
    return { ...verdict };
  })();
  pending.set(key, operation);
  try { return await operation; } finally { pending.delete(key); }
}
