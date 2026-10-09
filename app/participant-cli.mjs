import { lstat, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (code) => Object.assign(new Error(code), { code });
function argumentsOf(args) {
  const options = {}, commands = ["info", "discover", "joinable", "join", "create", "read", "work", "finding", "contribute"];
  let command = null;
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (commands.includes(value) && !command) { command = value; continue; }
    if (!/^--(config|source|query|discussion|source-id|turn|delivery|reply-to)$/.test(value) || i + 1 >= args.length || args[i + 1].startsWith("--")) throw fail("invalid_arguments");
    const key = value.slice(2);
    if (key in options) throw fail("duplicate_argument");
    options[key] = args[++i];
  }
  if (!command || !options.config || !UUID.test(options.source ?? "")) throw fail("config_and_exact_source_required");
  const allowed = { info: [], discover: ["query"], joinable: ["query"], join: ["discussion"], create: [], read: ["discussion"], work: ["query"], finding: ["source-id"], contribute: ["discussion", "turn", "delivery", "reply-to"] };
  if (Object.keys(options).some((key) => !["config", "source", ...allowed[command]].includes(key))) throw fail("invalid_command_argument");
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
  const { command, options } = argumentsOf(args), config = await configuration(options.config, options.source);
  const attribution = "locally connector-bound; native caller not verified";
  if (command === "info") return { nativeThreadId: config.nativeThreadId, sessionId: config.sessionId, provider: config.provider, host: config.host, attribution, commands: ["discover", "joinable", "join", "create", "read", "work", "finding", "contribute"] };
  let path, body;
  if (["discover", "joinable", "work"].includes(command)) {
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
    path = command === "read" ? "/api/discussions/context" : command === "join" ? "/api/discussions/join" : "/api/discussions/contribute"; body = { id: options.discussion };
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
  runParticipantCli(process.argv.slice(2), { input: process.stdin }).then((value) => { process.stdout.write(JSON.stringify(value) + "\n"); }, (error) => { process.stderr.write(JSON.stringify({ error: error.code ?? "scoped_request_failed" }) + "\n"); process.exitCode = 1; });
}
