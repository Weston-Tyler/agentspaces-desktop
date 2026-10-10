import test from "node:test";
import { realpathSync } from "node:fs";
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
  const root = await mkdtemp(join(realpathSync(tmpdir()), "as-participant-cli-")), path = join(root, "participant.json"), address = "http://127.0.0.1:" + server.address().port;
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

test('decision and machine CLI commands keep source binding and route bounded JSON',async t=>{
 const f=await setup(t);
 for(const command of ['decisions','machines','continuations'])await runParticipantCli(f.args(command));
 for(const command of ['decision-change','machine-change'])await runParticipantCli(f.args(command),{input:JSON.stringify({action:command==='decision-change'?'decision_withdraw':'machine_cancel',entryId:'synthetic',deliveryId:'synthetic-operation-001',rationale:'Reason',summary:'Reason'})});
 assert.deepEqual(f.requests.map(r=>r.path),['/api/decisions/list','/api/machines/list','/api/work-board/continuations','/api/decisions/change','/api/machines/change']);
 assert(f.requests.every(r=>r.auth==='Bearer '+TOKEN&&r.host==='127.0.0.1:43127'));
});

test('Linux machine runner uses exact participant identity and SSH bridge authority end to end',{skip:process.platform!=='linux'},async t=>{
 let lock;
 const f=await setup(t,r=>({status:200,body:r.body.action==='machine_request'?{entryId:'synthetic-request'}:r.body.action==='machine_acquire'?{entryId:'synthetic-request',status:'reserved',host:'remote',lockPaths:[lock],gateCommand:[],minutes:1,deadline:Date.now()+5000}:{status:'released'}}));
 lock=join(f.root,'machine.lock');
 await promisify(execFile)('python3',[resolveRunner(),'--config',f.path,'--source',SOURCE,'--machine','synthetic-machine','--title','Synthetic smoke','--minutes','1','--','python3','-c','pass'],{timeout:12000});
 assert.deepEqual(f.requests.map(r=>r.body.action),['machine_request','machine_acquire','machine_release']);
 assert(f.requests.every(r=>r.host==='127.0.0.1:43127'&&r.auth==='Bearer '+TOKEN));
});
function resolveRunner(){return new URL('../scripts/machine-run.py',import.meta.url).pathname;}

test('CLI help is available offline without configuration, source, stdin or network', async () => {
  const noNetwork = async () => { throw new Error('Help must never access network'); };
  const index = await runParticipantCli(['--help'], { requestImpl: noNetwork });
  assert(index.commands.includes('message')); assert(index.commands.includes('board'));
  for (const args of [['message', '--help'], ['--help', 'message'], ['--config', '/not/read', '--source', 'invalid', 'message', '--help']]) {
    const help = await runParticipantCli(args, { requestImpl: noNetwork });
    assert.equal(help.command, 'message');
    assert.deepEqual(help.stdinSchema.required, ['text', 'nativeTurnId', 'deliveryId']);
    assert.equal(help.stdinSchema.properties.deliveryId.pattern, '^[a-zA-Z0-9-]{8,100}$');
    assert.equal(help.stdinSchema.additionalProperties, false);
    assert.equal(help.stdinSchema.oneOf.length, 2);
    assert.match(help.notes.join(' '), /self-reported/);
  }
  const broadcast = await runParticipantCli(['broadcast', '--help']);
  assert.equal(broadcast.stdinSchema.properties.activeWithinDays.maximum, 3650);
  await assert.rejects(runParticipantCli(['message', '--unknown', '--help']), /invalid_arguments/);
});

test('Message validation identifies missing and invalid fields without echoing input or sending requests', async t => {
  const f = await setup(t);
  await assert.rejects(runParticipantCli(f.args('message'), { input: JSON.stringify({ text: 'Private content', nativeThreadId: GROUP }) }), error => {
    assert.equal(error.code, 'bounded_agent_message_required');
    assert.deepEqual(error.details.missingFields, ['nativeTurnId', 'deliveryId']);
    assert.equal(error.details.help, 'message --help');
    assert(!JSON.stringify(error).includes('Private content')); return true;
  });
  await assert.rejects(runParticipantCli(f.args('broadcast'), { input: JSON.stringify({ text: 'Private content', nativeTurnId: 'turn', deliveryId: 'x', activeWithinDays: 0, 'Private-key-name': true }) }), error => {
    assert.deepEqual(error.details.invalidFields, ['deliveryId', 'activeWithinDays', 'additionalProperties']);
    assert(!JSON.stringify(error).includes('Private')); return true;
  });
  await assert.rejects(runParticipantCli(f.args('message'), { input: JSON.stringify({ text: 'Hi', nativeTurnId: 'turn', deliveryId: 'valid-message-001' }) }), error => {
    assert.deepEqual(error.details.invalidFields, ['sessionId|nativeThreadId']); return true;
  });
  assert.equal(f.requests.length, 0);
});

test('Executable copied CLI prints command schema and safe structured errors', async t => {
  const f = await setup(t), script = join(f.root, 'copied-participant-cli.mjs');
  await copyFile(new URL('../app/participant-cli.mjs', import.meta.url), script);
  const help = await promisify(execFile)(process.execPath, [script, 'message', '--help']);
  assert.equal(JSON.parse(help.stdout).stdinSchema.properties.text.maxLength, 8000);
  const result = await new Promise(resolve => {
    const child = execFile(process.execPath, [script, ...f.args('message')], (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    child.stdin.end(JSON.stringify({ text: 'Private message', nativeThreadId: GROUP }));
  });
  assert.equal(result.error.code, 1);
  const diagnostic = JSON.parse(result.stderr);
  assert.deepEqual(diagnostic.details.missingFields, ['nativeTurnId', 'deliveryId']);
  assert(!result.stderr.includes('Private message')); assert.equal(result.stdout, '');
});

test('CLI verifies exact owner approval receipts without widening participant authority', async t => {
  const f = await setup(t), body = { entryId: 'decision-1', requestHash: 'b'.repeat(64), receiptId: 'receipt-1' };
  await runParticipantCli(f.args('verify-approval'), { input: JSON.stringify(body) });
  assert.equal(f.requests[0].path, '/api/approvals/verify'); assert.deepEqual(f.requests[0].body, body);
  for (const invalid of [{ ...body, receiptId: '' }, { ...body, requestHash: 'wrong' }, { ...body, owner: true }]) {
    await assert.rejects(runParticipantCli(f.args('verify-approval'), { input: JSON.stringify(invalid) }), /exact_approval_receipt_required/);
  }
  assert.equal(f.requests.length, 1);
  const help = await runParticipantCli(['verify-approval', '--help']);
  assert.deepEqual(help.stdinSchema.required, ['entryId', 'requestHash', 'receiptId']);
});

test('artifact CLI schemas and scoped routes carry report text without filesystem paths',async t=>{
 const f=await setup(t);
 const help=await runParticipantCli(['artifact-drop','--help']);assert.ok(help.stdinSchema.properties.previousEntryId);assert.equal(f.requests.length,0);
 const input={deliveryId:'artifact-cli-upload',workEntryId:'work-entry',name:'report.md',text:'Synthetic report'};
 await runParticipantCli(f.args('artifact-drop'),{input:JSON.stringify(input)});
 await runParticipantCli(f.args('artifact-read'),{input:JSON.stringify({entryId:'artifact-entry'})});
 await runParticipantCli(f.args('artifacts'),{input:'{}'});await runParticipantCli(f.args('lanes'));
 assert.deepEqual(f.requests.map(row=>row.path),['/api/artifacts/create','/api/artifacts/list','/api/artifacts/list','/api/lanes/list']);assert.deepEqual(f.requests[0].body,input);
 await assert.rejects(runParticipantCli(f.args('artifact-drop'),{input:JSON.stringify({...input,path:'/tmp/not-allowed'})}),/bounded_artifact_request_required/);
});
test('Topic subscriptions and digest expose offline schemas and preserve scoped route arguments',async t=>{
  const {args,requests}=await setup(t);
  const subscription={id:GROUP,mode:'wake',topics:['chillit recipe']};
  assert.equal((await runParticipantCli(['subscribe','--help'])).stdinSchema.properties.mode.enum[0],'wake');
  await runParticipantCli(args('subscribe'),{input:JSON.stringify(subscription)});
  await runParticipantCli(args('subscriptions','--discussion',GROUP));
  await runParticipantCli(args('digest'),{input:JSON.stringify({query:'recipe',limit:20,since:'2026-10-10T00:00:00Z'})});
  assert.deepEqual(requests.map(row=>row.path),['/api/discussions/subscription','/api/discussions/subscriptions','/api/digest']);
  assert.deepEqual(requests[0].body,subscription);
  await assert.rejects(runParticipantCli(args('subscribe'),{input:JSON.stringify({...subscription,sessionId:'a-peer'})}),/bounded_subscription/);
  await assert.rejects(runParticipantCli(args('digest'),{input:JSON.stringify({limit:201})}),/bounded_subscription/);
  assert.equal(requests.length,3);
});
