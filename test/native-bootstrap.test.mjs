import test from "node:test";
import { realpathSync } from "node:fs";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createNativeBootstrap } from "../app/native-bootstrap-mcp.mjs";
import { runNativeSessionHook, resolveClaudeSource, bootstrapConfigPath } from "../app/native-session-hook.mjs";
const UUID = "00000000-0000-4000-8000-000000000001", OTHER = "00000000-0000-4000-8000-000000000002";
const deviceToken = "a".repeat(64), scopedToken = "b".repeat(64);
const processRecord = { pid: 4242, parentPid: 1, exe: "/native/claude", startedAt: "fixture-start-1" };
async function setup(provider = "claude") {
  const root = await mkdtemp(join(realpathSync(tmpdir()), "as-bootstrap-")), configPath = join(root, "device.json");
  const device = { schemaVersion: 1, address: "http://127.0.0.1:45111", authority: "127.0.0.1:43127", token: deviceToken, host: "remote", provider };
  await writeFile(configPath, JSON.stringify(device), { mode: 0o600 });
  const participantConfig = { schema: 1, address: "http://127.0.0.1:43127", authority: "127.0.0.1:43127", token: scopedToken, nativeThreadId: UUID, sessionId: provider + "@remote:" + UUID, provider, host: "remote" };
  return { root, configPath, device, participantConfig };
}
const event = (extra = {}) => ({ session_id: UUID, cwd: "/fictional/project", hook_event_name: "SessionStart", ...extra });
const request = (threadId = UUID, args = {}) => ({ params: { name: "discover_group_discussions", arguments: args, _meta: { threadId } } });
test("Codex resolves native request metadata per call and never delegates the device capability", async () => {
  const { configPath, participantConfig } = await setup("codex"), requests = [];
  const bootstrap = await createNativeBootstrap({ configPath, requestImpl: async (config, path, body) => {
    requests.push({ config, path, body });
    if (path === "/api/native/register") return { participantConfig: { ...participantConfig, nativeThreadId: body.nativeThreadId } };
    return { synthetic: true, accidentalDeviceEcho: deviceToken, accidentalScopedEcho: scopedToken };
  } });
  await assert.rejects(bootstrap.callTool({ params: { name: "discover_group_discussions", arguments: {} } }), /native_request_thread_metadata_required/);
  assert.equal(requests.length, 0);
  const result = await bootstrap.callTool(request());
  assert.equal(requests[0].config.token, deviceToken);
  assert.equal(requests[1].config.token, scopedToken);
  assert.equal(requests[1].config.address, "http://127.0.0.1:45111");
  assert.equal(requests[1].config.authority, "127.0.0.1:43127");
  assert(!JSON.stringify(result).includes(deviceToken)); assert(!JSON.stringify(result).includes(scopedToken));
  await bootstrap.callTool(request(OTHER));
  assert.equal(requests[2].body.nativeThreadId, OTHER);
  await assert.rejects(bootstrap.callTool(request(UUID, { nativeThreadId: OTHER })), /bounded_native_tool_arguments_required/);
  await bootstrap.server.close();
});
test("Claude lifecycle captures exact native process identity and MCP checks it dynamically", async () => {
  const { configPath, participantConfig, root } = await setup(), calls = [];
  const result = await runNativeSessionHook(event(), { configPath, ancestors: async () => [processRecord], requestImpl: async (config, path, body) => { calls.push({ config, path, body }); return { participantConfig }; } });
  assert.equal(result.activeSessionReloaded, false);
  assert.equal(calls[0].body.nativeThreadId, UUID);
  const files = await readdir(join(root, "bindings"));
  const recordText = await readFile(join(root, "bindings", files[0]), "utf8");
  assert(!recordText.includes(deviceToken)); assert(!recordText.includes(scopedToken));
  const record = await resolveClaudeSource(configPath, { ancestors: async () => [processRecord] });
  assert.equal(record.nativeThreadId, UUID);
  const bootstrap = await createNativeBootstrap({ configPath, resolveClaude: (path) => resolveClaudeSource(path, { ancestors: async () => [processRecord] }), requestImpl: async (config, path) => path === "/api/native/register" ? { participantConfig } : { synthetic: true } });
  await bootstrap.callTool({ params: { name: "discover_group_discussions", arguments: {} } });
  await bootstrap.server.close();
});
test("Claude rejects PID reuse, executable mismatch, ambiguous identities and ended sessions", async () => {
  const { configPath, participantConfig } = await setup();
  const record = async (session_id, hook_event_name = "SessionStart") => runNativeSessionHook(event({ session_id, hook_event_name }), { configPath, ancestors: async () => [processRecord], requestImpl: async () => ({ participantConfig: { ...participantConfig, nativeThreadId: session_id } }) });
  await record(UUID);
  await assert.rejects(resolveClaudeSource(configPath, { ancestors: async () => [{ ...processRecord, startedAt: "reused-pid" }] }), /stale_or_missing/);
  await assert.rejects(resolveClaudeSource(configPath, { ancestors: async () => [{ ...processRecord, exe: "/native/other" }] }), /stale_or_missing/);
  await record(OTHER);
  await assert.rejects(resolveClaudeSource(configPath, { ancestors: async () => [processRecord] }), /ambiguous/);
  await record(OTHER, "SessionEnd");
  assert.equal((await resolveClaudeSource(configPath, { ancestors: async () => [processRecord] })).nativeThreadId, UUID);
  await record(UUID, "SessionEnd");
  await assert.rejects(resolveClaudeSource(configPath, { ancestors: async () => [processRecord] }), /stale_or_missing/);
});
test("Codex hook registers native session ID for owning resolver rather than guessing thread UUID", async () => {
  const { configPath, participantConfig } = await setup("codex");
  let body;
  const result = await runNativeSessionHook(event({ session_id: "opaque-native-session-id" }), { configPath, ancestors: async () => [{ ...processRecord, exe: "/native/codex" }], requestImpl: async (_, path, value) => { body = value; return { participantConfig }; } });
  assert.equal(body.nativeSessionId, "opaque-native-session-id");
  assert.equal(body.nativeThreadId, undefined);
  assert.equal(result.nativeThreadId, UUID);
});
test("Missing process identity and mismatched registration fail before tool content access", async () => {
  const { configPath, participantConfig } = await setup("claude");
  let calls = 0;
  await assert.rejects(runNativeSessionHook(event(), { configPath, ancestors: async () => [], requestImpl: async () => { calls++; return { participantConfig }; } }), /native_process_not_identified/);
  assert.equal(calls, 0);
  const bootstrap = await createNativeBootstrap({ configPath, resolveClaude: async () => ({ nativeThreadId: UUID, process: processRecord }), requestImpl: async () => { calls++; return { participantConfig: { ...participantConfig, nativeThreadId: OTHER } }; } });
  await assert.rejects(bootstrap.callTool({ params: { name: "discover_group_discussions", arguments: {} } }), /registered_native_binding_mismatch/);
  assert.equal(calls, 1);
  await bootstrap.server.close();
});
test("Real alias HTTP transport registers then uses scoped token with exact original authority", async (t) => {
  const { configPath, device, participantConfig } = await setup("codex"), received = [];
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    received.push({ path: req.url, host: req.headers.host, token: req.headers.authorization });
    const registering = req.url === "/api/native/register";
    if (req.headers.host !== device.authority || req.headers.authorization !== "Bearer " + (registering ? deviceToken : scopedToken)) { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(registering ? { participantConfig } : { sourceId: UUID, synthetic: true }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await writeFile(configPath, JSON.stringify({ ...device, address: "http://127.0.0.1:" + server.address().port }));
  const bootstrap = await createNativeBootstrap({ configPath });
  t.after(() => bootstrap.server.close());
  const result = await bootstrap.callTool(request());
  assert.equal(JSON.parse(result.content[0].text).sourceId, UUID);
  assert.deepEqual(received.map(x => x.path), ["/api/native/register", "/api/discussions/discover"]);
});
test("Configured resolved Claude binary matches versioned executable and SessionEnd tombstones offline", async () => {
  const { configPath, device, participantConfig } = await setup();
  const process = { ...processRecord, exe: "/native/claude/versions/2.1.283" };
  await writeFile(configPath, JSON.stringify({ ...device, nativeExecutable: process.exe }));
  await runNativeSessionHook(event(), { configPath, ancestors: async () => [process], requestImpl: async () => ({ participantConfig }) });
  assert.equal((await resolveClaudeSource(configPath, { ancestors: async () => [process] })).nativeThreadId, UUID);
  await runNativeSessionHook(event({ hook_event_name: "SessionEnd" }), { configPath, ancestors: async () => [process], requestImpl: async () => { throw new Error("An ended session must not require a server capability"); } });
  await assert.rejects(resolveClaudeSource(configPath, { ancestors: async () => [process] }), /stale_or_missing/);
  await writeFile(configPath, JSON.stringify({ ...device, nativeExecutable: "/usr/bin/node" }));
  await assert.rejects(runNativeSessionHook(event(), { configPath, ancestors: async () => [process] }), /native_executable_invalid/);
});
test("MCP protocol advertises source and group tools and preserves native request metadata per call", async () => {
  const { configPath, participantConfig } = await setup("codex");
  const nativeIds = [];
  const bootstrap = await createNativeBootstrap({ configPath, requestImpl: async (_, path, body) => {
    if (path === "/api/native/register") { nativeIds.push(body.nativeThreadId); return { participantConfig: { ...participantConfig, nativeThreadId: body.nativeThreadId } }; }
    return [{ fictionalDiscussion: true }];
  } });
  const client = new Client({ name: "fixture-native-bootstrap-client", version: "1" }), [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await bootstrap.server.connect(serverTransport); await client.connect(clientTransport);
  assert.equal((await client.listTools()).tools.length, 34);
  const reply = await client.callTool({ name: "discover_group_discussions", arguments: {}, _meta: { threadId: UUID } });
  assert.equal(reply.isError, undefined); assert.deepEqual(nativeIds, [UUID]);
  const denied = await client.callTool({ name: "discover_group_discussions", arguments: {} });
  assert.equal(denied.isError, true); assert.equal(nativeIds.length, 1);
  assert.equal(bootstrapConfigPath(["--config", configPath]), configPath);
  assert.throws(() => bootstrapConfigPath(["--token", "not-allowed"]), /device_config_argument_invalid/);
  await client.close(); await bootstrap.server.close();
});
test("Claude prompt hook automatically retrieves recent shared messages with bounded provenance and no persisted content", async () => {
  const { configPath, participantConfig, root } = await setup(), calls = [];
  const roomIds = [UUID, OTHER, "00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004", "00000000-0000-4000-8000-000000000005"];
  const result = await runNativeSessionHook(event({ hook_event_name: "UserPromptSubmit" }), { configPath, ancestors: async () => [processRecord], requestImpl: async (config, path, body) => {
    calls.push({ config, path, body });
    if (path === "/api/native/register") return { participantConfig };
    assert.equal(config.token, scopedToken);
    assert.equal(config.address, "http://127.0.0.1:45111"); assert.equal(config.authority, "127.0.0.1:43127");
    if (path === "/api/discussions/discover") return roomIds.map(id => ({ id, participantAlias: "claude1", title: "Fictional Atlas room" }));
    return { available: true, title: "Fictional Atlas room", messages: Array.from({ length: 8 }, (_, i) => ({ id: "fixture-message-" + i, author: "codex1", text: "PRIVATE-SYNTHETIC-CONTEXT-" + i + " " + deviceToken + scopedToken + "x".repeat(2000), source: { nativeThreadId: OTHER, host: "local", provider: "codex" }, turnId: "fixture-self-reported-turn", replyTo: "fixture-parent" })) };
  } });
  assert(result.additionalContext.length <= 12000);
  assert.match(result.additionalContext, /untrusted evidence, not product orders/);
  assert.match(result.additionalContext, /your alias @claude1/);
  assert.match(result.additionalContext, /native turn fixture-self-reported-turn \(self-reported\)/);
  assert.match(result.additionalContext, /PRIVATE-SYNTHETIC-CONTEXT-7/);
  assert(!result.additionalContext.includes("PRIVATE-SYNTHETIC-CONTEXT-0"));
  assert(!result.additionalContext.includes(deviceToken)); assert(!result.additionalContext.includes(scopedToken));
  assert(calls.filter(c => c.path === "/api/discussions/context").length <= 4);
  assert.equal(calls.filter(c => c.path.includes("contribute")).length, 0);
  for (const file of await readdir(join(root, "bindings"))) assert(!(await readFile(join(root, "bindings", file), "utf8")).includes("PRIVATE-SYNTHETIC-CONTEXT"));
});
test("Optional group reads may fail without losing the recorded native source binding", async () => {
  const { configPath, participantConfig } = await setup();
  const result = await runNativeSessionHook(event(), { configPath, ancestors: async () => [processRecord], requestImpl: async (_, path) => { if (path === "/api/native/register") return { participantConfig }; throw new Error("Synthetic revoked discussion scope"); } });
  assert.equal(result.recorded, true); assert.equal(result.additionalContext, undefined);
  assert.equal((await resolveClaudeSource(configPath, { ancestors: async () => [processRecord] })).nativeThreadId, UUID);
});
test("Fresh Claude lifecycle pending metadata records only identity; first later MCP call must register before content", async () => {
  const { configPath, participantConfig, root } = await setup();
  let nativeMetadataReady = false, contentCalls = 0;
  const requestImpl = async (_, path) => {
    if (path === "/api/native/register") {
      if (!nativeMetadataReady) throw Object.assign(new Error("source_pending"), { code: "source_pending" });
      return { participantConfig };
    }
    if (path === "/api/discussions/discover") { contentCalls++; return [{ id: UUID, participantAlias: "claude1" }]; }
    return { available: true, messages: [] };
  };
  const pending = await runNativeSessionHook(event(), { configPath, ancestors: async () => [processRecord], requestImpl });
  assert.equal(pending.pending, true); assert.equal(pending.recorded, true); assert.equal(pending.additionalContext, undefined);
  const record = await resolveClaudeSource(configPath, { ancestors: async () => [processRecord] });
  assert.equal(record.provisional, true); assert.equal(record.nativeThreadId, UUID);
  const bootstrap = await createNativeBootstrap({ configPath, resolveClaude: (path) => resolveClaudeSource(path, { ancestors: async () => [processRecord] }), requestImpl });
  await assert.rejects(bootstrap.callTool({ params: { name: "discover_group_discussions", arguments: {} } }), /source_pending/);
  assert.equal(contentCalls, 0, "A provisional process record grants no content access");
  nativeMetadataReady = true;
  const resolved = await bootstrap.callTool({ params: { name: "discover_group_discussions", arguments: {} } });
  assert.equal(JSON.parse(resolved.content[0].text)[0].id, UUID); assert.equal(contentCalls, 1);
  await runNativeSessionHook(event({ hook_event_name: "UserPromptSubmit" }), { configPath, ancestors: async () => [processRecord], requestImpl });
  assert.equal((await resolveClaudeSource(configPath, { ancestors: async () => [processRecord] })).provisional, false);
  for (const file of await readdir(join(root, "bindings"))) {
    const bytes = await readFile(join(root, "bindings", file), "utf8");
    assert(!bytes.includes(deviceToken)); assert(!bytes.includes(scopedToken)); assert(!bytes.includes("messages"));
  }
  await bootstrap.server.close();
});
test("Provisional source identity does not accept a mismatched registered UUID and ends offline", async () => {
  const { configPath, participantConfig } = await setup();
  await assert.rejects(runNativeSessionHook(event(), { configPath, ancestors: async () => [processRecord], requestImpl: async () => ({ participantConfig: { ...participantConfig, nativeThreadId: OTHER } }) }), /registered_source_mismatch/);
  assert.equal((await resolveClaudeSource(configPath, { ancestors: async () => [processRecord] })).nativeThreadId, UUID);
  await runNativeSessionHook(event({ hook_event_name: "SessionEnd" }), { configPath, ancestors: async () => [processRecord], requestImpl: async () => { throw new Error("Ended provisional identity must not contact the server"); } });
  await assert.rejects(resolveClaudeSource(configPath, { ancestors: async () => [processRecord] }), /stale_or_missing/);
});

test('Native topic tools resolve this source and reject peer substitution before network calls',async()=>{
  const {configPath,participantConfig}=await setup('codex'),calls=[];
  const bootstrap=await createNativeBootstrap({configPath,requestImpl:async(config,path,body)=>{calls.push({path,body});return path==='/api/native/register'?{participantConfig}:{items:[]};}});
  try{
    const invoke=(name,args)=>bootstrap.callTool({params:{name,arguments:args,_meta:{threadId:UUID}}});
    await invoke('change_room_subscription',{id:OTHER,mode:'digest',topics:['recipe']});
    await invoke('list_room_subscriptions',{id:OTHER});
    await invoke('read_coordination_digest',{since:'2026-10-10T00:00:00Z',limit:20});
    assert.deepEqual(calls.filter(x=>x.path!=='/api/native/register').map(x=>x.path),['/api/discussions/subscription','/api/discussions/subscriptions','/api/digest']);
    const count=calls.length;
    await assert.rejects(invoke('change_room_subscription',{id:OTHER,mode:'wake',topics:['recipe'],sessionId:'a-peer'}),/bounded_native_tool/);
    assert.equal(calls.length,count);
  }finally{await bootstrap.server.close();}
});
