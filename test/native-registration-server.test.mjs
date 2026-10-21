import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Store } from "../app/store.mjs";
import { Engine } from "../app/engine.mjs";
import { startServer } from "../app/server.mjs";
import { createNativeBootstrap } from "../app/native-bootstrap-mcp.mjs";
import { runNativeSessionHook, resolveClaudeSource } from '../app/native-session-hook.mjs';
import { runNativeInboxHook } from '../app/native-inbox-hook.mjs';
const THREAD = "00000000-0000-4000-8000-000000000001", UNKNOWN = "00000000-0000-4000-8000-000000000002";

test('real HTTP registration and loaded MCP survive folder changes; the same native Stop hook rearms its inbox', async t => {
  const f = await fixture(t), configPath = join(f.root, 'directory-device.json');
  writeFileSync(configPath, JSON.stringify({schemaVersion:1,...f.device,address:f.app.address,authority:new URL(f.app.address).host}), {mode:0o600});
  const processRecord = {pid:4242,exe:'/native/claude',startedAt:'fixture-same-process'};
  const ancestors = async () => [processRecord], grants = structuredClone(f.engine.store.data.grants);
  const room = f.engine.discussions.create({title:'Folder-change wire contract',sessionIds:[f.source.id],selfRegistration:true});
  const bootstrap = await createNativeBootstrap({configPath,resolveClaude:path=>resolveClaudeSource(path,{ancestors})});
  t.after(()=>bootstrap.server.close());
  let token;
  for (const cwd of [join(f.root,'work-one'),join(f.root,'work-two')]) {
    // Unchanged older MCP processes still use this legacy payload.
    const old = await f.call('/api/native/register',{nativeThreadId:THREAD,cwd,sourceProof:{kind:'claude-lifecycle'}},f.device.token);
    assert.equal(old.status,200); assert.equal(old.body.sourceCwd,f.source.cwd);
    token ??= old.body.participantConfig.token;
    assert.equal(old.body.participantConfig.token,token);
    const event = {hook_event_name:'UserPromptSubmit',session_id:THREAD,cwd};
    assert.equal((await runNativeSessionHook(event,{configPath,ancestors})).recorded,true);
    const read = await bootstrap.callTool({params:{name:'read_group_discussion',arguments:{id:room.id,limit:1}}});
    assert.equal(JSON.parse(read.content[0].text).available,true);
  }
  const waiting = runNativeInboxHook({hook_event_name:'Stop',session_id:THREAD,cwd:join(f.root,'work-three')},{configPath,ancestors,waitMs:2000});
  const deadline = Date.now()+1000;
  while (!f.app.channels.isConnected(f.source.id) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(f.app.channels.transportKind(f.source.id),'async-hook');
  // No message/model is needed to prove that the real source-bound inbox armed.
  assert.equal((await waiting).reason,'wait-expired');
  assert.equal(f.engine.session(f.source.id).cwd,f.source.cwd);
  assert.deepEqual(f.engine.store.data.grants,grants);
  assert.equal(f.engine.modelCalls,0);
  f.engine.grant(f.source.id,{retrieve:false});
  await assert.rejects(bootstrap.callTool({params:{name:'discover_group_discussions',arguments:{}}}),{code:'native_registration_source_revoked'});
});
async function fixture(t, sourceMetadataResolver = async () => null, nativeThreadAdapterFactory) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "as-registration-http-"));
  const engine = new Engine(new Store(root), { diagnostics: () => ({ status: "synthetic-disconnected" }), close() {} }, { nativeFactory: () => { throw new Error("No native or model call permitted by registration fixture"); } });
  engine.workspace.index = { schema: 1, fixture: false, profile: { id: "synthetic-owned-scope", active: true, account: "synthetic-owner", hosts: ["local"], providers: ["claude", "codex"], policy: "local-retrieval", indexFiles: true, roots: {}, exclusions: {} }, nodes: [{ id: "host:local", kind: "host", host: "local" }], edges: [], sessions: [], coverage: [], errors: [] };
  const source = { id: "claude@local:" + THREAD, nativeThreadId: THREAD, host: "local", provider: "claude", cwd: join(root, "fictional-work"), account: "synthetic-owner", scopeId: "synthetic-owned-scope", fixture: false, status: "unknown", title: "Synthetic native source metadata", sourceVersion: "synthetic-v1", topics: ["synthetic"] };
  engine.workspace.restore([source]); engine.workspace.index.sessions.push(source);
  const app = await startServer({ root, port: 0, engine, sourceMetadataResolver, nativeThreadAdapterFactory });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const call = async (path, body = {}, token = app.admin, method = "POST") => {
    const response = await fetch(app.address + path, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const device = await call("/api/native/registration/device", { host: "local", provider: "claude" });
  assert.equal(device.status, 200);
  return { root, app, engine, source, call, device: device.body };
}
test("Registration-only capability cannot read content, manage rooms, grant rights or mint other devices", async (t) => {
  const { call, device } = await fixture(t);
  const attempts = [
    ["/api/state", {}, "GET"], ["/api/health", {}, "GET"],
    ["/api/finding", { id: "any" }], ["/api/retrieve", { sourceId: "any" }],
    ["/api/discussions/create", { title: "unauthorized", sessionIds: [] }],
    ["/api/discussions/policy", { id: UNKNOWN, agentInitiation: true }],
    ["/api/grant", { id: "any", changes: { enrolled: true } }],
    ["/api/native/registration/device", { host: "local", provider: "codex" }],
  ];
  for (const [path, body, method = "POST"] of attempts) {
    const result = await call(path, body, device.token, method);
    assert.equal(result.status, 403, path);
    assert(!JSON.stringify(result.body).includes(device.token));
  }
});
test('Agent capabilities, native creation and invitations are source-bound over real HTTP', async t => {
  const calls = [];
  const f = await fixture(t, async args => ({ ...args, nativeObserved: true, cwd: '/fictional/new-native-thread', sourceVersion: 'synthetic-created-v1' }), () => ({
    open: async () => {}, close: () => {},
    createEmptyThread: async cwd => { calls.push({ method: 'thread/start', cwd }); return { thread: { id: UNKNOWN, cwd } }; },
    setThreadName: async (threadId, name) => { calls.push({ method: 'thread/name/set', threadId, name }); return {}; },
  }));
  f.engine.tools = [{ host: 'local', provider: 'codex', installed: true, versionMatches: true }];
  const registered = await f.call('/api/native/register', { nativeThreadId: THREAD }, f.device.token);
  const token = registered.body.participantConfig.token;
  const capabilities = await f.call('/api/agent/capabilities', {}, token);
  assert.equal(capabilities.status, 200); assert.equal(capabilities.body.groups.invite, true);
  assert.equal(capabilities.body.nativeThreads.creationStartsTurn, false);
  const body = { title: 'Created native work chat', host: 'local', cwd: '/fictional/new-native-thread', deliveryId: 'native-http-create-0001' };
  const first = await f.call('/api/native/thread/create', body, token);
  assert.equal(first.status, 200); assert.equal(first.body.nativeThreadId, UNKNOWN);
  assert.equal(first.body.registration, 'registered'); assert.equal(first.body.turnStarted, false);
  assert(!JSON.stringify(first.body).includes(token));
  const repeated = await f.call('/api/native/thread/create', body, token);
  assert.equal(repeated.body.nativeThreadId, UNKNOWN); assert.equal(calls.filter(c => c.method === 'thread/start').length, 1);
  const room = f.engine.discussions.create({ title: 'Agent invitation', sessionIds: [f.source.id], selfRegistration: true });
  const invitation = await f.call('/api/discussions/invite', { id: room.id, sessionId: first.body.sessionId }, token);
  assert.equal(invitation.status, 200); assert.equal(invitation.body.sessionId, first.body.sessionId);
  assert.equal(f.engine.modelCalls, 0);
  assert.equal((await f.call('/api/grant', { id: f.source.id, changes: { share: true } }, token)).status, 400);
});
test("Undiscovered native agent self-registers, discovers peers, joins and creates groups through MCP and HTTP", async t => {
  const f = await fixture(t, async args => ({ ...args, nativeObserved: true, cwd: "/fictional/new-thread", sourceVersion: "synthetic-new-v1" }));
  const issued = await f.call("/api/native/registration/device", { host: "local", provider: "codex" });
  const path = join(f.root, "device.json");
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, ...issued.body, address: f.app.address, authority: new URL(f.app.address).host }), { mode: 0o600 });
  const bootstrap = await createNativeBootstrap({ configPath: path }); t.after(() => bootstrap.server.close());
  const call = async (name, args = {}) => JSON.parse((await bootstrap.callTool({ params: { name, arguments: args, _meta: { threadId: UNKNOWN } } })).content[0].text);
  const room = f.engine.discussions.create({ title: "Synthetic open workspace", sessionIds: [f.source.id], selfRegistration: true });
  const registered = await call("register_native_source");
  assert.equal(registered.status, "registered"); assert.equal(registered.nativeThreadId, UNKNOWN);
  assert(!JSON.stringify(registered).includes(issued.body.token)); assert.equal(registered.inboundChannelConnected, false);
  const peers = await call("discover_permitted_work", { query: "Synthetic" });
  assert(peers.some(peer => peer.id === f.source.id));
  const joinable = await call("discover_joinable_discussions");
  assert.equal(joinable[0].id, room.id); assert(!("messages" in joinable[0]));
  assert.equal((await call("read_group_discussion", { id: room.id })).available, true);
  const joined = await call("join_group_discussion", { id: room.id });
  assert.equal(joined.participantAlias, "codex1");
  assert.equal(joined.alreadyMember, true);
  assert.equal((await call("join_group_discussion", { id: room.id })).alreadyMember, true);
  assert.equal((await call("read_group_discussion", { id: room.id })).available, true);
  const args = { title: "Synthetic peer discussion", sessionIds: [f.source.id], deliveryId: "fixture-create-group-0001" };
  const created = await call("create_group_discussion", args);
  assert.equal(created.members[0].sessionId, registered.sessionId);
  assert.equal(created.policy.agentInitiation, true); assert.equal(created.policy.selfRegistration, true);
  assert.equal((await call("create_group_discussion", args)).id, created.id);
  const broadcastArgs = { discussionId: created.id, text: '@all Please report your evidence.', nativeTurnId: 'synthetic-broadcast-turn', deliveryId: 'fixture-broadcast-http-0001' };
  const broadcast = await call('message_agents', broadcastArgs);
  assert.deepEqual(broadcast.selectedSourceIds, [f.source.id]);
  assert.equal(broadcast.batches[0].discussionId, created.id);
  const repeated = await call('message_agents', broadcastArgs);
  assert.equal(repeated.duplicate, true);
  const saved = f.engine.discussions.group(created.id);
  assert.equal(saved.messages.length, 1);
  assert.equal(saved.messages[0].source.sessionId, registered.sessionId);
  assert.deepEqual(saved.messages[0].targets.map(target => target.sessionId), [f.source.id]);
  const literal = await call('contribute_to_discussion', { id: created.id, text: '@all Please update the shared table.', nativeTurnId: 'synthetic-literal-turn', deliveryId: 'fixture-literal-http-0001' });
  assert.deepEqual(literal.selectedSourceIds, [f.source.id]);
  assert.equal(saved.messages.length, 2);
  assert.equal(saved.messages[1].text, 'Please update the shared table.');
  assert.equal(f.engine.modelCalls, 0); assert.deepEqual(f.engine.store.data.grants, {});
});
test("Known registration mints scoped source tools and preserves discussion attribution over HTTP", async (t) => {
  const { app, engine, source, call, device } = await fixture(t);
  const registration = await call("/api/native/register", { nativeThreadId: THREAD, cwd: source.cwd }, device.token);
  assert.equal(registration.status, 200);
  const config = registration.body.participantConfig;
  assert.equal(config.nativeThreadId, THREAD); assert.equal(config.sessionId, source.id);
  assert.notEqual(config.token, device.token);
  assert.equal(new URL(config.address).host, new URL(app.address).host);
  const discover = await call("/api/discover", { query: "Synthetic", project: "all" }, config.token);
  assert.equal(discover.status, 200); assert.equal(discover.body[0].id, source.id);
  assert.equal((await call("/api/discussions/create", { title: "not-owner", sessionIds: [source.id] }, config.token)).status, 400);
  const group = engine.discussions.create({ title: "Synthetic registered group", sessionIds: [source.id] });
  assert.equal((await call("/api/discussions/context", { id: group.id }, config.token)).status, 200);
  const contribution = await call("/api/discussions/contribute", { id: group.id, text: "Synthetic registered participant reply", nativeTurnId: "synthetic-self-reported-turn", deliveryId: "synthetic-register-reply-0001" }, config.token);
  assert.equal(contribution.status, 200);
  assert.equal(contribution.body.messages.at(-1).source.sessionId, source.id);
  assert.equal(contribution.body.messages.at(-1).turnId, "synthetic-self-reported-turn");
  assert.equal(engine.modelCalls, 0);
});
test("Unknown registration remains pending without grants and revoked connectors cannot be recreated", async (t) => {
  const { engine, call, device } = await fixture(t);
  const pending = await call("/api/native/register", { nativeThreadId: UNKNOWN }, device.token);
  assert.equal(pending.status, 400); assert.match(pending.body.error, /source_pending/);
  assert.equal(engine.catalog.length, 1); assert.deepEqual(engine.store.data.grants, {});
  assert.equal(Object.keys(engine.store.data.connectors).length, 0);
  const registration = await call("/api/native/register", { nativeThreadId: THREAD }, device.token), config = registration.body.participantConfig;
  delete engine.store.data.connectors[createHash("sha256").update(config.token).digest("hex")];
  const revoked = await call("/api/native/register", { nativeThreadId: THREAD }, device.token);
  assert.equal(revoked.status, 400); assert.match(revoked.body.error, /source_connector_revoked/);
  assert.equal((await call("/api/discover", {}, config.token)).status, 401);
  engine.workspace.index.profile.active = false;
  assert.equal((await call("/api/native/register", { nativeThreadId: THREAD }, device.token)).status, 401);
  assert.equal(engine.modelCalls, 0);
});
