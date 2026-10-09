import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile, chmod, symlink, copyFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runParticipantCli } from "../app/participant-cli.mjs";
const SOURCE = "00000000-0000-4000-8000-000000000001", GROUP = "00000000-0000-4000-8000-000000000002", TOKEN = "a".repeat(64);
async function setup(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const item = { path: req.url, host: req.headers.host, auth: req.headers.authorization, body: JSON.parse(body) }; requests.push(item);
    const response = handler?.(item) ?? { status: 200, body: { fixture: true, text: "Synthetic scoped participant response" } };
    res.writeHead(response.status, { "Content-Type": "application/json" }); res.end(typeof response.body === "string" ? response.body : JSON.stringify(response.body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const root = await mkdtemp(join(tmpdir(), "as-participant-cli-")), path = join(root, "participant.json"), address = "http://127.0.0.1:" + server.address().port;
  const config = { schema: 1, address, authority: "127.0.0.1:43127", token: TOKEN, sessionId: "claude@remote:" + SOURCE, nativeThreadId: SOURCE, host: "remote", provider: "claude" };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  return { requests, path, root, config, args: (...args) => ["--config", path, "--source", SOURCE, ...args] };
}
test("Participant CLI exact source check precedes all network access and local info omits secrets", async (t) => {
  const { args, requests } = await setup(t);
  const wrong = args("discover"); wrong[3] = GROUP;
  await assert.rejects(runParticipantCli(wrong), /source_identity_mismatch/);
  const info = await runParticipantCli(args("info"));
  assert.equal(info.nativeThreadId, SOURCE);
  assert.equal(info.attribution, "locally connector-bound; native caller not verified");
  assert(!JSON.stringify(info).includes(TOKEN)); assert.equal(requests.length, 0);
});
test("Participant CLI uses original Host over different-port alias and maps readonly commands", async (t) => {
  const { args, requests } = await setup(t);
  for (const command of [["discover", "--query", "Atlas"], ["read", "--discussion", GROUP], ["work", "--query", "retry"], ["finding", "--source-id", "codex@local:fixture-source"]]) {
    const result = await runParticipantCli(args(...command)); assert.equal(result.nativeThreadId, SOURCE); assert.equal(result.result.fixture, true);
  }
  assert.deepEqual(requests.map((r) => r.path), ["/api/discussions/discover", "/api/discussions/context", "/api/discover", "/api/retrieve"]);
  assert(requests.every((r) => r.host === "127.0.0.1:43127" && r.auth === "Bearer " + TOKEN));
  assert.deepEqual(requests[2].body, { query: "retry" });
  assert.deepEqual(requests[3].body, { sourceId: "codex@local:fixture-source" });
});
test("Contribution text arrives only through bounded stdin JSON and retains exact identifiers", async (t) => {
  const { args, requests } = await setup(t);
  const options = args("contribute", "--discussion", GROUP, "--turn", "self-reported-fixture-turn", "--delivery", "fixture-delivery-0001", "--reply-to", GROUP);
  const stream = (async function* () { yield '{"text":"Synthetic '; yield 'multiline\\nreply"}'; })();
  await runParticipantCli(options, { input: stream });
  assert.deepEqual(requests[0].body, { id: GROUP, text: "Synthetic multiline\nreply", nativeTurnId: "self-reported-fixture-turn", deliveryId: "fixture-delivery-0001", replyTo: GROUP });
  assert.equal(requests[0].path, "/api/discussions/contribute");
  await assert.rejects(runParticipantCli(options, { input: JSON.stringify({ text: "x".repeat(8001) }) }), /bounded_stdin_text_required/);
  await assert.rejects(runParticipantCli(options, { input: "x".repeat(65537) }), /stdin_limit_exceeded/);
  await assert.rejects(runParticipantCli([...options, "--text", "not-allowed"]), /invalid_arguments/);
  assert.equal(requests.length, 1);
});
test("Participant CLI discovers joinable rooms, joins itself and creates groups with bounded stdin", async t => {
  const { args, requests } = await setup(t);
  await runParticipantCli(args("joinable", "--query", "Atlas"));
  await runParticipantCli(args("join", "--discussion", GROUP));
  const body = { title: "Atlas peers", sessionIds: ["codex@local:" + GROUP], deliveryId: "fixture-create-room-0001" };
  await runParticipantCli(args("create"), { input: JSON.stringify(body) });
  assert.deepEqual(requests.map(r => r.path), ["/api/discussions/joinable", "/api/discussions/join", "/api/discussions/create"]);
  assert.deepEqual(requests[2].body, body);
  await assert.rejects(runParticipantCli(args("create"), { input: JSON.stringify({ ...body, selfRegistration: true }) }), /bounded_group_creation_required/);
  assert.equal(requests.length, 3);
});
test('Participant CLI exposes capabilities, source-bound invitations and empty native thread creation', async t => {
  const { args, requests } = await setup(t);
  await runParticipantCli(args('capabilities'));
  await runParticipantCli(args('invite', '--discussion', GROUP, '--source-id', 'codex@local:' + GROUP));
  const body = { title: 'New native work chat', deliveryId: 'cli-native-create-0001', host: 'remote', cwd: '/fictional/work' };
  await runParticipantCli(args('new-thread'), { input: JSON.stringify(body) });
  assert.deepEqual(requests.map(r => r.path), ['/api/agent/capabilities','/api/discussions/invite','/api/native/thread/create']);
  assert.deepEqual(requests[1].body, { id: GROUP, sessionId: 'codex@local:' + GROUP });
  assert.deepEqual(requests[2].body, body);
  await assert.rejects(runParticipantCli(args('new-thread'), { input: JSON.stringify({ ...body, approvalPolicy: 'never' }) }), /bounded_native_thread_creation_required/);
  assert.equal(requests.length, 3);
});
test('Participant CLI sends exact peer messages and bounded topic/date broadcasts', async t => {
  const { args, requests } = await setup(t);
  const common = { text: 'Please share your findings.', nativeTurnId: 'synthetic-turn', deliveryId: 'cli-message-0001' };
  await runParticipantCli(args('message'), { input: JSON.stringify({ ...common, nativeThreadId: GROUP }) });
  await runParticipantCli(args('broadcast'), { input: JSON.stringify({ ...common, deliveryId: 'cli-broadcast-0001', query: 'chillit recipe', activeWithinDays: 30 }) });
  assert.deepEqual(requests.map(r => r.path), ['/api/agent/message', '/api/agent/broadcast']);
  assert.equal(requests[1].body.activeWithinDays, 30);
  await assert.rejects(runParticipantCli(args('message'), { input: JSON.stringify({ ...common, nativeThreadId: GROUP, sessionId: 'other' }) }), /bounded_agent_message_required/);
  await assert.rejects(runParticipantCli(args('broadcast'), { input: JSON.stringify({ ...common, activeWithinDays: 0 }) }), /bounded_agent_message_required/);
  await assert.rejects(runParticipantCli(args('broadcast'), { input: JSON.stringify({ ...common, model: 'override' }) }), /bounded_agent_message_required/);
  assert.equal(requests.length, 2);
});
test("Revocation and server diagnostics never expose credentials; successful echo redacts capability", async (t) => {
  let status = 401;
  const { args } = await setup(t, () => ({ status, body: { secret: TOKEN, privateDiagnostic: "Should never appear in CLI error" } }));
  for (status of [401, 403]) await assert.rejects(runParticipantCli(args("discover")), (error) => error.code === "scoped_access_denied" && !error.message.includes(TOKEN) && !error.message.includes("Diagnostic"));
  status = 200;
  assert.equal((await runParticipantCli(args("discover"))).result.secret, "[redacted]");
});
test("Private configuration validation refuses external authority and symbolic-link file", async (t) => {
  const { args, path, root, config, requests } = await setup(t);
  await writeFile(path, JSON.stringify({ ...config, authority: "example.invalid:43127" }));
  await assert.rejects(runParticipantCli(args("info")), /invalid_private_config/);
  await writeFile(path, JSON.stringify(config));
  if (process.platform !== "win32") {
    await chmod(path, 0o644);
    await assert.rejects(runParticipantCli(args("info")), /owner_private_config_required/);
    await chmod(path, 0o600);
    const linked = join(root, "linked.json"); await symlink(path, linked);
    const linkedArgs = args("info"); linkedArgs[1] = linked;
    await assert.rejects(runParticipantCli(linkedArgs), /config_symlink_refused/);
  }
  assert.equal(requests.length, 0);
});
test("Oversized response and malformed command reject without printing raw contents", async (t) => {
  const { args } = await setup(t);
  await assert.rejects(runParticipantCli(args("discover"), { requestImpl: async () => ({ statusCode: 200, body: "x".repeat(1048577) }) }), /invalid_scoped_response/);
  await assert.rejects(runParticipantCli(args("read", "--discussion", "not-a-uuid")), /discussion_uuid_required/);
  await assert.rejects(runParticipantCli(args("discover", "--query", "x".repeat(201))), /query_limit_exceeded/);
});
test("Self-contained CLI executes from a copied hash filename without repo dependencies", async (t) => {
  const { args, root, requests } = await setup(t);
  const script = join(root, "participant-cli-abcdef123456.mjs");
  await copyFile(new URL("../app/participant-cli.mjs", import.meta.url), script);
  const result = await promisify(execFile)(process.execPath, [script, ...args("info")]);
  assert.equal(JSON.parse(result.stdout).nativeThreadId, SOURCE);
  assert.equal(result.stderr, ""); assert(!result.stdout.includes(TOKEN));
  assert.equal(requests.length, 0);
});
test("Real HTTP response over byte bound is rejected", async (t) => {
  const { args } = await setup(t, () => ({ status: 200, body: JSON.stringify({ text: "x".repeat(1048577) }) }));
  await assert.rejects(runParticipantCli(args("discover")), /scoped_transport_failed/);
});
