import { lstat, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (code, details) => Object.assign(new Error(code), { code, ...(details ? { details } : {}) });
const COMMAND_OPTIONS = { subscriptions: ["discussion"], subscribe: [], digest: [], continuations: [], lanes: [], artifacts: [], "artifact-read": [], "artifact-drop": [], decisions: [], "decision-change": [], "verify-approval": [], machines: [], "machine-change": [], board: [], "board-change": [], info: [], capabilities: [], discover: ["query"], joinable: ["query"], join: ["discussion"], invite: ["discussion", "source-id"], create: [], "new-thread": [], message: [], broadcast: [], read: ["discussion"], work: ["query"], finding: ["source-id"], contribute: ["discussion", "turn", "delivery", "reply-to"] };
const COMMANDS = Object.keys(COMMAND_OPTIONS);
const string = (maxLength, extra = {}) => ({ type: "string", minLength: 1, maxLength, ...extra });
const uuid = { type: "string", pattern: UUID.source.replaceAll("a-f", "a-fA-F") };
const delivery = string(100, { minLength: 8, pattern: "^[a-zA-Z0-9-]{8,100}$" });
const objectSchema = (properties, required, extra = {}) => ({ type: "object", properties, required, additionalProperties: false, ...extra });
const MESSAGE_PROPERTIES = { text: string(8000, { pattern: "\\S" }), nativeTurnId: string(200), deliveryId: delivery };
const STDIN_SCHEMAS = {
  "artifact-read": objectSchema({entryId:string(100)},['entryId']),
  "artifact-drop": objectSchema({deliveryId:delivery,name:string(120),text:string(16384),mediaType:{enum:['text/plain','text/markdown','application/json']},workEntryId:string(100),discussionId:uuid,messageId:uuid,previousEntryId:string(100)},['deliveryId','name','text']),
  artifacts: objectSchema({workEntryId:string(100),discussionId:uuid,limit:{type:'integer',minimum:1,maximum:200}},[]),
  subscribe: objectSchema({id:uuid,mode:{enum:["wake","digest","off"]},topics:{type:"array",minItems:0,maxItems:12,items:string(80)},workEntryId:string(100)},["id","mode","topics"]),
  digest: objectSchema({since:string(40),query:string(200,{minLength:0}),limit:{type:"integer",minimum:1,maximum:200},discussionId:uuid},[]),
  message: objectSchema({ ...MESSAGE_PROPERTIES, sessionId: string(300), nativeThreadId: uuid, host: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$" }, provider: { enum: ["codex", "claude"] }, title: string(80, { pattern: "\\S" }) }, Object.keys(MESSAGE_PROPERTIES), { oneOf: [{ required: ["sessionId"] }, { required: ["nativeThreadId"] }] }),
  broadcast: objectSchema({ ...MESSAGE_PROPERTIES, query: string(500, { minLength: 0 }), activeWithinDays: { type: "integer", minimum: 1, maximum: 3650 }, sessionIds: { type: "array", minItems: 1, maxItems: 200, items: string(300) }, nativeThreadIds: { type: "array", minItems: 1, maxItems: 200, items: uuid }, discussionId: uuid }, Object.keys(MESSAGE_PROPERTIES)),
  "verify-approval": objectSchema({ entryId: string(100), requestHash: string(64, { minLength: 64, pattern: "^[a-f0-9]{64}$" }), receiptId: string(100) }, ["entryId", "requestHash", "receiptId"]),
};
function helpFor(command) {
  const notes = ["Help is offline and never reads private configuration or stdin.", "All actual commands require --config PATH and --source UUID for this exact native thread."];
  if (!command) return { usage: "participant-cli.mjs [--config PATH --source UUID] COMMAND [OPTIONS]", commands: COMMANDS, help: "COMMAND --help", notes };
  if (["message", "broadcast", "contribute"].includes(command)) notes.push("nativeTurnId/--turn is a self-reported native turn reference, not verified sender authority.", "Reuse the same deliveryId/--delivery for a retry of the same request; use a new ID for a new request.");
  if (command === "continuations") notes.push("Read explicit pending steps, standing grant status and native idle observations. No force-resume, cancellation or model polling; only owner-enabled scoped wakes may execute.");
  if (["subscribe","subscriptions","digest"].includes(command)) notes.push("Delivery preferences do not authorize work. Explicit mentions remain honored; plain replies stay quiet. Digests are bounded persisted evidence; since is inclusive ISO time and discussionId filters only messages.");
  if (command === "verify-approval") notes.push("Verifies the exact receipt against current expiry, revocation and authenticated target source; records an audit receipt. Native owner delegation and client permissions remain authoritative.");
  return { command, usage: `participant-cli.mjs --config PATH --source UUID ${command}${COMMAND_OPTIONS[command].map(key => ` [--${key} VALUE]`).join("")}`, options: COMMAND_OPTIONS[command], ...(STDIN_SCHEMAS[command] ? { stdinSchema: STDIN_SCHEMAS[command] } : {}), notes };
}
function validField(value, schema) {
  if (schema.enum) return schema.enum.includes(value);
  if (schema.type === "string") return typeof value === "string" && (schema.minLength === undefined || value.length >= schema.minLength) && (schema.maxLength === undefined || value.length <= schema.maxLength) && (!schema.pattern || new RegExp(schema.pattern).test(value));
  if (schema.type === "integer") return Number.isInteger(value) && value >= schema.minimum && value <= schema.maximum;
  if (schema.type === "array") return Array.isArray(value) && value.length >= schema.minItems && value.length <= schema.maxItems && value.every(item => validField(item, schema.items));
  return false;
}
function validateStdin(command, data, code) {
  const schema = STDIN_SCHEMAS[command], missingFields = [], invalidFields = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) invalidFields.push("stdin");
  else {
    for (const field of schema.required) if (!Object.hasOwn(data, field)) missingFields.push(field);
    for (const [field, constraint] of Object.entries(schema.properties)) if (Object.hasOwn(data, field) && !validField(data[field], constraint)) invalidFields.push(field);
    if (command === "message" && Object.hasOwn(data, "sessionId") === Object.hasOwn(data, "nativeThreadId")) invalidFields.push("sessionId|nativeThreadId");
    // Do not echo unknown field names or values: they may contain private input.
    if (Object.keys(data).some(field => !Object.hasOwn(schema.properties, field))) invalidFields.push("additionalProperties");
  }
  if (missingFields.length || invalidFields.length) throw fail(code, { missingFields, invalidFields, help: `${command} --help` });
  return data;
}
function argumentsOf(args) {
  const options = {};
  let help = false;
  let command = null;
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === "--help" || value === "-h") { help = true; continue; }
    if (COMMANDS.includes(value) && !command) { command = value; continue; }
    if (!/^--(config|source|query|discussion|source-id|turn|delivery|reply-to)$/.test(value) || i + 1 >= args.length || args[i + 1].startsWith("--")) throw fail("invalid_arguments");
    const key = value.slice(2);
    if (key in options) throw fail("duplicate_argument");
    options[key] = args[++i];
  }
  if (help) return { command, options, help };
  if (!command || !options.config || !UUID.test(options.source ?? "")) throw fail("config_and_exact_source_required");
  if (Object.keys(options).some((key) => !["config", "source", ...COMMAND_OPTIONS[command]].includes(key))) throw fail("invalid_command_argument");
  return { command, options };
}
async function configuration(path, source) {
  const file = resolve(path);
  for (let current = file; ; current = dirname(current)) {
    const stat = await lstat(current).catch(() => { throw fail("private_config_unavailable"); });
    if (stat.isSymbolicLink()) throw fail("config_symlink_refused");
    if (current === file && (!stat.isFile() || stat.size > 65536)) throw fail("invalid_private_config_file");
    if (process.platform !== "win32" && current === file && ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid())) throw fail("owner_private_config_required");
    if (dirname(current) === current) break;
  }
  let config;
  try { config = JSON.parse(await readFile(file, "utf8")); } catch { throw fail("invalid_private_config"); }
  if (config.schema !== 1 || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(config.address ?? "") || !/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(config.authority ?? "") || !/^[a-f0-9]{64}$/.test(config.token ?? "") || !UUID.test(config.nativeThreadId ?? "") || typeof config.sessionId !== "string" || !config.sessionId || config.sessionId.length > 300 || !["codex", "claude"].includes(config.provider) || typeof config.host !== "string" || !config.host || config.host.length > 100) throw fail("invalid_private_config");
  if (+new URL(config.address).port > 65535 || +config.authority.split(":")[1] > 65535) throw fail("invalid_private_config");
  if (config.nativeThreadId.toLowerCase() !== source.toLowerCase()) throw fail("source_identity_mismatch");
  return config;
}
async function inputJson(input) {
  let value = "";
  if (typeof input === "string" || Buffer.isBuffer(input)) value = input.toString();
  else if (input?.[Symbol.asyncIterator]) {
    for await (const chunk of input) {
      value += chunk.toString();
      if (Buffer.byteLength(value) > 65536) throw fail("stdin_limit_exceeded");
    }
  } else throw fail("stdin_json_text_required");
  if (Buffer.byteLength(value) > 65536) throw fail("stdin_limit_exceeded");
  let data; try { data = JSON.parse(value); } catch { throw fail("stdin_json_text_required"); }
  return data;
}
async function inputText(input) {
  const data = await inputJson(input);
  if (!data || typeof data.text !== "string" || !data.text.trim() || data.text.length > 8000 || Object.keys(data).some((key) => key !== "text")) throw fail("bounded_stdin_text_required");
  return data.text;
}
function request({ address, authority, token, path, body }) {
  return new Promise((resolveResult, reject) => {
    const bytes = JSON.stringify(body);
    const req = http.request(new URL(path, address), { method: "POST", headers: { Host: authority, Authorization: "Bearer " + token, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bytes) } }, (res) => {
      let text = "", size = 0;
      res.on("data", (chunk) => { size += chunk.length; if (size > 1048576) req.destroy(fail("response_limit_exceeded")); else text += chunk.toString(); });
      res.on("end", () => resolveResult({ statusCode: res.statusCode, body: text }));
      res.on("error", () => reject(fail("scoped_transport_failed")));
    });
    req.setTimeout(12000, () => req.destroy(fail("scoped_transport_timeout")));
    req.on("error", () => reject(fail("scoped_transport_failed")));
    req.end(bytes);
  });
}
export async function runParticipantCli(args, { input, requestImpl = request } = {}) {
  const { command, options, help } = argumentsOf(args);
  if (help) return helpFor(command);
  const config = await configuration(options.config, options.source);
  const attribution = "locally connector-bound; native caller not verified";
  if (command === "info") return { nativeThreadId: config.nativeThreadId, sessionId: config.sessionId, provider: config.provider, host: config.host, attribution, commands: COMMANDS };
  let path, body;
  if (command === 'lanes') { path = '/api/lanes/list'; body = {limit:200}; }
  else if (['artifacts','artifact-read','artifact-drop'].includes(command)) { path = command === 'artifact-drop' ? '/api/artifacts/create' : '/api/artifacts/list'; body = validateStdin(command, await inputJson(input), 'bounded_artifact_request_required'); }
  else if (command === 'capabilities') { path = '/api/agent/capabilities'; body = {}; }
  else if (command === 'subscriptions') {
    if (!UUID.test(options.discussion ?? "")) throw fail("discussion_uuid_required");
    path = '/api/discussions/subscriptions'; body = {id:options.discussion};
  }
  else if (command === 'subscribe' || command === 'digest') {
    body = validateStdin(command, await inputJson(input), 'bounded_subscription_or_digest_required');
    path = command === 'subscribe' ? '/api/discussions/subscription' : '/api/digest';
  }
  else if (command === 'message' || command === 'broadcast') {
    body = validateStdin(command, await inputJson(input), "bounded_agent_message_required");
    path = command === 'message' ? '/api/agent/message' : '/api/agent/broadcast';
  }
  else if (command === "continuations") { path="/api/work-board/continuations"; body={}; }
  else if (command === "verify-approval") {
    path = "/api/approvals/verify"; body = validateStdin(command, await inputJson(input), "exact_approval_receipt_required");
  }
  else if (['decisions','decision-change','machines','machine-change'].includes(command)) {
    path = ({decisions:'/api/decisions/list','decision-change':'/api/decisions/change',machines:'/api/machines/list','machine-change':'/api/machines/change'})[command];
    body = command.endsWith('-change') ? await inputJson(input) : {};
  }
  else if (command === 'board' || command === 'board-change') {
    path = command === 'board' ? '/api/work-board/list' : '/api/work-board/change';
    body = command === 'board' ? { limit: 200 } : await inputJson(input);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('work_board_object_required');
  }
  else if (command === 'new-thread') {
    const data = await inputJson(input);
    if (!data || typeof data.title !== 'string' || !data.title.trim() || data.title.length > 200 || !/^[a-zA-Z0-9-]{8,100}$/.test(data.deliveryId ?? '') || data.host !== undefined && (typeof data.host !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(data.host)) || data.cwd !== undefined && (typeof data.cwd !== 'string' || !data.cwd || data.cwd.length > 4096) || Object.keys(data).some(key => !['title','deliveryId','host','cwd'].includes(key))) throw fail('bounded_native_thread_creation_required');
    path = '/api/native/thread/create'; body = data;
  } else if (["discover", "joinable", "work"].includes(command)) {
    const query = options.query ?? ""; if (query.length > 200) throw fail("query_limit_exceeded");
    path = command === "work" ? "/api/discover" : command === "joinable" ? "/api/discussions/joinable" : "/api/discussions/discover"; body = { query };
  } else if (command === "create") {
    const data = await inputJson(input);
    if (!data || typeof data.title !== "string" || !data.title.trim() || data.title.length > 80 || !Array.isArray(data.sessionIds) || !data.sessionIds.length || data.sessionIds.length > 11 || data.sessionIds.some(id => typeof id !== "string" || !id || id.length > 300) || new Set(data.sessionIds).size !== data.sessionIds.length || !/^[a-zA-Z0-9-]{8,100}$/.test(data.deliveryId ?? "") || Object.keys(data).some(key => !["title", "sessionIds", "deliveryId"].includes(key))) throw fail("bounded_group_creation_required");
    path = "/api/discussions/create"; body = data;
  } else if (command === "finding") {
    if (!options["source-id"] || options["source-id"].length > 300) throw fail("source_actor_id_required");
    path = "/api/retrieve"; body = { sourceId: options["source-id"] };
  } else {
    if (!UUID.test(options.discussion ?? "")) throw fail("discussion_uuid_required");
    path = command === "read" ? "/api/discussions/context" : command === "join" ? "/api/discussions/join" : command === 'invite' ? '/api/discussions/invite' : "/api/discussions/contribute"; body = { id: options.discussion };
    if (command === 'invite') {
      if (!options['source-id'] || options['source-id'].length > 300) throw fail('source_actor_id_required');
      body.sessionId = options['source-id'];
    }
    if (command === "contribute") {
      if (!options.turn || options.turn.length > 200 || !/^[a-zA-Z0-9-]{8,100}$/.test(options.delivery ?? "") || (options["reply-to"] && !UUID.test(options["reply-to"]))) throw fail("stable_contribution_identifiers_required");
      body = { ...body, text: await inputText(input), nativeTurnId: options.turn, deliveryId: options.delivery, ...(options["reply-to"] ? { replyTo: options["reply-to"] } : {}) };
    }
  }
  let response; try { response = await requestImpl({ address: config.address, authority: config.authority, token: config.token, path, body }); } catch { throw fail("scoped_transport_failed"); }
  if (response.statusCode !== 200) throw fail(response.statusCode === 401 || response.statusCode === 403 ? "scoped_access_denied" : "scoped_request_refused");
  let result;
  try { const raw = typeof response.body === "string" ? response.body : JSON.stringify(response.body); if (Buffer.byteLength(raw) > 1048576) throw new Error(); result = JSON.parse(raw.replaceAll(config.token, "[redacted]")); } catch { throw fail("invalid_scoped_response"); }
  return { nativeThreadId: config.nativeThreadId, attribution, result };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runParticipantCli(process.argv.slice(2), { input: process.stdin }).then((value) => { process.stdout.write(JSON.stringify(value) + "\n"); }, (error) => { process.stderr.write(JSON.stringify({ error: error.code ?? "scoped_request_failed", ...(error.details ? { details: error.details } : {}) }) + "\n"); process.exitCode = 1; });
}
