import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../app/engine.mjs";
import { Store } from "../app/store.mjs";
import { FabricAdapter } from "../app/fabric.mjs";
import { CodexDiscussionHub } from "../app/codex-discussions.mjs";

const THREAD = "11111111-2222-4333-8444-555555555555";
const TURN = "66666666-7777-4888-8999-000000000000";
const fail = (code, uncertainOutcome = false) => Object.assign(new Error(code), { code, uncertainOutcome });
function setup({ root = mkdtempSync(join(tmpdir(), "as-codex-discussion-")), controls = {} } = {}) {
  const engine = new Engine(new Store(root), new FabricAdapter({ stateRoot: root }));
  engine.loadSample(); engine.mode = "workspace-connected";
  const source = engine.session("sample-codex-old");
  Object.assign(source, { fixture: false, nativeThreadId: THREAD, host: "remote", cwd: "/tmp/agentspaces-discussion-fixture", status: "unknown" });
  engine.store.data.projects[source.project].fixture = false;
  engine.store.data.projects[source.project].targets = { "remote:codex": { path: source.cwd, host: "remote", provider: "codex" } };
  for (const id of [source.id, "sample-claude-new"])
    engine.grant(id, { enrolled: true, content: true, share: true, retrieve: true });
  const counters = { factory: 0, open: 0, bind: 0, answer: 0, close: 0 }, adapters = [];
  const factory = options => {
    counters.factory++;
    const adapter = { events: new EventEmitter(),
      async open() { counters.open++; await controls.open?.(); },
      async bindExistingThread(args) {
        counters.bind++; adapter.binding = args;
        if (controls.bind) return controls.bind(args, options);
        const proof = { nativeThreadId: args.threadId, host: "remote", cwd: args.cwd,
          sandbox: { type: "readOnly", networkAccess: false }, approvalPolicy: "on-request",
          source: "existing-native-thread-resume-response", verifiedAt: new Date().toISOString() };
        await options.persistPermissionProof?.(proof);
        return { nativeThreadId: args.threadId, permissionProof: proof };
      },
      async answer(args) {
        counters.answer++; adapter.answerArgs = args;
        assert(engine.store.data.codexDiscussionDeliveries[args.clientId],
          "Delivery allocation must be durable before a native effect");
        if (controls.answer) return controls.answer(args, options, adapter);
        const receipt = { clientId: args.clientId, nativeThreadId: args.threadId, nativeTurnId: TURN,
          queuedSubmissionId: "fixture-native-queued", status: "completed", retryAllowed: false };
        await options.persistReceipt?.(receipt);
        return { nativeThreadId: args.threadId, nativeTurnId: TURN, text: "Fixture adapter contribution",
          queuedSubmissionId: receipt.queuedSubmissionId, usage: { known: true, inputTokens: 10, outputTokens: 4, totalTokens: 14 }, receipt };
      },
      close() { counters.close++; },
    };
    adapters.push(adapter); return adapter;
  };
  const hub = new CodexDiscussionHub(engine, { adapterFactory: factory });
  const group = engine.discussions.create({ title: "Native discussion integration fixture", sessionIds: [source.id, "sample-claude-new"] });
  const posted = engine.discussions.post({ id: group.id, text: "Explain the topic", deliveryId: "owner-message-0001" });
  const args = { sessionId: source.id, discussionId: group.id, messageId: posted.messages[0].id,
    text: "Explain the topic", requestId: "discussion-request-0001", budget: { timeoutMs: 90000, maxOutputTokens: 800 } };
  return { engine, source, root, counters, adapters, hub, args, factory };
}
const until = async predicate => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error("Expected fake native adapter phase");
};
const settle = async (hub, id) => { try { return await hub.wait(id); } catch (error) { return { error }; } };

test('recorded native-policy grant prefers loaded input without resume and exposes only acknowledged queue status', async t => {
  let release; const gate = new Promise(yes => release = yes);
  const f = setup({ controls: { answer: async (args, options, adapter) => { adapter.events.emit('queued', { threadId: args.threadId, clientId: args.clientId, queuedSubmissionId: 'own-queued' }); await gate; return { nativeThreadId: args.threadId, nativeTurnId: TURN, text: 'Own fixture reply' }; } } });
  t.after(() => { release(); f.hub.close(); });
  f.engine.store.data.desktopPreferences = { allowNativeFullAccess: true };
  const factory = f.hub.adapterFactory; let loadedCalls = 0;
  f.hub.adapterFactory = options => { const adapter = factory(options); adapter.bindLoadedThread = async input => { loadedCalls++; assert.deepEqual(input.grant, { execution: true, allowExistingNativePolicy: true }); return { nativeThreadId: input.threadId }; }; return adapter; };
  f.hub.dispatch(f.args); await until(() => f.engine.store.data.codexDiscussionDeliveries[f.args.requestId].status === 'queued');
  assert.equal(loadedCalls, 1); assert.equal(f.counters.bind, 0); release();
  assert.equal((await f.hub.wait(f.args.requestId)).status, 'native-agent-replied');
});

test('revoking acceptance of the existing native policy fences a loaded delivery after binding', async t => {
  const f = setup(); t.after(() => f.hub.close()); f.engine.store.data.desktopPreferences = { allowNativeFullAccess: true };
  const factory = f.hub.adapterFactory;
  f.hub.adapterFactory = options => { const adapter = factory(options); adapter.bindLoadedThread = async () => { f.engine.store.data.desktopPreferences.allowNativeFullAccess = false; }; return adapter; };
  f.hub.dispatch(f.args); const result = await f.hub.wait(f.args.requestId);
  assert.equal(result.status, 'native-agent-unavailable'); assert.equal(f.counters.answer, 0); assert.equal(f.counters.bind, 0);
});

test('a binding transport error is known not to have queued this conversation message', async t => {
  const f = setup({ controls: { bind: async () => { throw fail('native_rpc_rejected', true); } } }); t.after(() => f.hub.close());
  f.hub.dispatch(f.args); const result = await f.hub.wait(f.args.requestId);
  assert.equal(f.counters.answer, 0); assert.equal(result.uncertainOutcome, false); assert.equal(result.undispatched, true); assert.equal(result.status, 'native-agent-unavailable');
});

test("targeted native adapter reply retains exact source thread/turn and original discussion parent", async t => {
  const { engine, source, counters, adapters, hub, args } = setup(); t.after(() => hub.close());
  const effect = hub.dispatch(args); assert.equal(effect.status, "connecting-native-agent");
  await hub.wait(args.requestId);
  assert.equal(counters.answer, 1); assert.equal(adapters[0].binding.threadId, THREAD);
  const group = engine.discussions.group(args.discussionId);
  assert.equal(group.messages.length, 2);
  const reply = group.messages[1]; assert.equal(reply.source.sessionId, source.id);
  assert.equal(reply.source.nativeThreadId, THREAD); assert.equal(reply.turnId, TURN);
  assert.equal(reply.replyTo, args.messageId); assert.match(reply.deliveryId, /^codex-[a-zA-Z0-9-]+$/);
  assert.equal(reply.synthetic, false);
  assert(engine.store.data.codexDiscussionDeliveries[args.requestId]);
  assert(Object.keys(engine.store.data.codexDiscussionNativeReceipts).length > 0);
});

test("duplicate request delivery and restart never reexecute acknowledged native work", async t => {
  const { engine, root, hub, args, counters, factory } = setup(); t.after(() => hub.close());
  hub.dispatch(args); await hub.wait(args.requestId);
  hub.dispatch(args); await settle(hub, args.requestId);
  assert.equal(counters.answer, 1); assert.equal(engine.discussions.group(args.discussionId).messages.length, 2);
  const restoredEngine = new Engine(new Store(root), new FabricAdapter({ stateRoot: root }));
  restoredEngine.catalog = structuredClone(engine.catalog);
  const restarted = new CodexDiscussionHub(restoredEngine, { adapterFactory: factory }); t.after(() => restarted.close());
  restarted.dispatch(args); await settle(restarted, args.requestId);
  assert.equal(counters.answer, 1); assert.equal(counters.factory, 1);
  assert.throws(() => restarted.dispatch({ ...args, text: "Different content" }), /collision|different|reus/i);
});

test("unknown member, foreign account and withdrawn sharing reject before any adapter effect", async t => {
  const { engine, source, hub, args, counters } = setup(); t.after(() => hub.close());
  assert.throws(() => hub.dispatch({ ...args, sessionId: "sample-codex-new" }), /participant|member|share|grant|qualified|native/i);
  const other = engine.session("sample-claude-new"); other.account = "another-account";
  assert.throws(() => hub.dispatch(args), /account|boundary|scope|share|stale/i);
  other.account = source.account;
  engine.grant(source.id, { share: false });
  assert.throws(() => hub.dispatch(args), /share|grant|permission|revoked|unavailable/i);
  assert.equal(counters.answer, 0); assert.equal(counters.factory, 0);
});

test("revocation while native binding is pending stops before queue dispatch", async t => {
  let release;
  const binding = new Promise(yes => release = yes);
  const { engine, source, hub, args, counters } = setup({ controls: { bind: async input => {
    await binding; return { nativeThreadId: input.threadId, permissionProof: { nativeThreadId: input.threadId } };
  } } }); t.after(() => { release(); hub.close(); });
  hub.dispatch(args); await until(() => counters.bind === 1);
  engine.grant(source.id, { share: false }); release(); await settle(hub, args.requestId);
  assert.equal(counters.answer, 0); assert.equal(engine.discussions.group(args.discussionId).messages.length, 1);
});

test("source identity or another participant sharing change during open prevents native binding", async t => {
  for (const change of ["identity", "other-share"]) {
    let release; const opening = new Promise(yes => release = yes);
    const { engine, source, hub, args, counters } = setup({ controls: { open: async () => opening } });
    t.after(() => { release(); hub.close(); }); hub.dispatch(args); await until(() => counters.open === 1);
    if (change === "identity") source.nativeThreadId = "99999999-2222-4333-8444-555555555555";
    else engine.grant("sample-claude-new", { share: false });
    release(); await settle(hub, args.requestId);
    assert.equal(counters.bind, 0, "Changed identity/sharing must stop before native resume, not just before queue.answer");
    assert.equal(counters.answer, 0); assert.equal(engine.discussions.group(args.discussionId).messages.length, 1);
  }
});

test("excluded native source paths cannot dispatch or bind", async t => {
  const { engine, source, hub, args, counters } = setup(); t.after(() => hub.close());
  source.scopeId = "scope-exclusion-fixture";
  engine.discussions.group(args.discussionId).members.find(member => member.sessionId === source.id).scopeId = source.scopeId;
  engine.workspace.index = { profile: { id: source.scopeId, active: true, account: source.account,
    hosts: ["remote"], providers: ["codex"], policy: "local-retrieval", exclusions: { remote: ["/tmp"] } },
    nodes: [], edges: [], sessions: [], fixture: false };
  assert.throws(() => hub.dispatch(args), /scope|permits|grant|excluded/i);
  assert.equal(counters.factory, 0); assert.equal(counters.answer, 0);
});

test("revocation after native result prevents its contribution to cached group content", async t => {
  let release;
  const answer = new Promise(yes => release = yes);
  const { engine, source, hub, args, counters } = setup({ controls: { answer: async input => {
    await answer; return { nativeThreadId: input.threadId, nativeTurnId: TURN, text: "Must not disclose after revocation", usage: { known: false } };
  } } }); t.after(() => { release(); hub.close(); });
  hub.dispatch(args); await until(() => counters.answer === 1);
  engine.grant(source.id, { enrolled: false }); release(); await settle(hub, args.requestId);
  assert.equal(engine.discussions.group(args.discussionId).messages.length, 1);
});

test("busy or unqualified native policy refuses without answering or manufacturing a reply", async t => {
  for (const code of ["native_existing_thread_busy_or_unavailable", "native_existing_permission_policy_not_qualified"]) {
    const { engine, hub, args, counters } = setup({ controls: { bind: async () => { throw fail(code); } } });
    t.after(() => hub.close()); hub.dispatch(args); await settle(hub, args.requestId);
    assert.equal(counters.answer, 0); assert.equal(engine.discussions.group(args.discussionId).messages.length, 1);
    assert(engine.store.data.codexDiscussionDeliveries[args.requestId]);
  }
});

test("native identity mismatch, uncertain outcome and approval attention never produce fake replies or retries", async t => {
  for (const kind of ["mismatch", "uncertain", "attention"]) {
    const controls = { answer: async (input, _options, adapter) => {
      if (kind === "mismatch") return { nativeThreadId: "99999999-2222-4333-8444-555555555555", nativeTurnId: TURN, text: "Wrong source", usage: { known: false } };
      if (kind === "attention") adapter.events.emit("native-attention", { kind: "approval-required", nativeThreadId: input.threadId, action: "declined; native owner attention required" });
      throw fail(kind === "attention" ? "native_queue_turn_failed" : "native_proxy_disconnected", true);
    } };
    const { engine, hub, args, counters } = setup({ controls }); t.after(() => hub.close());
    hub.dispatch(args); await settle(hub, args.requestId);
    assert.equal(engine.discussions.group(args.discussionId).messages.length, 1);
    hub.dispatch(args); await settle(hub, args.requestId); assert.equal(counters.answer, 1);
    assert.equal(engine.store.data.codexDiscussionDeliveries[args.requestId].retryAllowed, false);
    if (kind === "uncertain") assert.equal(engine.store.data.codexDiscussionDeliveries[args.requestId].uncertainOutcome, true);
    if (kind === "attention") {
      assert.equal(engine.store.data.codexDiscussionDeliveries[args.requestId].attentionRequired, true);
      assert.equal(engine.store.data.codexDiscussionDeliveries[args.requestId].status, "needs-native-attention");
    }
  }
});

test("explicit cancellation on hub close aborts active native work and closes its adapter", async () => {
  let observedAbort = false;
  const { engine, hub, args, counters } = setup({ controls: { answer: input => new Promise((_yes, no) => {
    input.signal.addEventListener("abort", () => { observedAbort = true; no(fail("cancelled", true)); }, { once: true });
  }) } });
  hub.dispatch(args); await until(() => counters.answer === 1); await hub.close({ cancelNative: true }); await settle(hub, args.requestId);
  assert(observedAbort); assert(counters.close > 0); assert.equal(engine.discussions.group(args.discussionId).messages.length, 1);
});

test("ordinary shutdown detaches without aborting native input and preserves acknowledged queue identity", async () => {
  let observedAbort = false, rejectAnswer;
  const f = setup({ controls: { answer: async (input, options, adapter) => {
    await options.persistReceipt({ clientId: input.clientId, nativeThreadId: input.threadId,
      queuedSubmissionId: "durable-detached-queue-id", status: "queued", retryAllowed: false });
    adapter.events.emit("queued", { clientId: input.clientId, threadId: input.threadId });
    input.signal.addEventListener("abort", () => { observedAbort = true; }, { once: true });
    return new Promise((_yes, no) => { rejectAnswer = no; });
  } } });
  const factory = f.hub.adapterFactory;
  f.hub.adapterFactory = options => {
    const adapter = factory(options), close = adapter.close;
    adapter.close = () => { close(); adapter.events.emit("disconnect"); rejectAnswer?.(fail("native_proxy_disconnected", true)); };
    return adapter;
  };
  f.hub.dispatch(f.args); await until(() => f.engine.store.data.codexDiscussionDeliveries[f.args.requestId].status === "queued");
  const signal = f.adapters[0].answerArgs.signal, closed = await f.hub.close();
  assert.equal(closed.nativeCancellationRequested, false); assert.equal(observedAbort, false); assert.equal(signal.aborted, false);
  assert(f.counters.close > 0); assert.equal(f.engine.discussions.group(f.args.discussionId).messages.length, 1);
  const persisted = new Store(f.root).data;
  assert.equal(persisted.codexDiscussionNativeReceipts[f.args.requestId].queuedSubmissionId, "durable-detached-queue-id");
  assert.equal(persisted.codexDiscussionNativeReceipts[f.args.requestId].clientId, f.args.requestId);
  assert.equal(persisted.codexDiscussionDeliveries[f.args.requestId].uncertainOutcome, true);
});

test("a detached queued receipt is reconciled after restart without submitting or cancelling native input", async () => {
  let rejectAnswer;
  const f = setup({ controls: { answer: async (input, options, adapter) => {
    await options.persistReceipt({ clientId: input.clientId, nativeThreadId: input.threadId,
      queuedSubmissionId: "restart-owned-queue-id", status: "queued", retryAllowed: false });
    adapter.events.emit("queued", { clientId: input.clientId, threadId: input.threadId });
    return new Promise((_yes, no) => { rejectAnswer = no; });
  } } });
  const factory = f.hub.adapterFactory;
  f.hub.adapterFactory = options => {
    const adapter = factory(options);
    adapter.close = () => { adapter.events.emit("disconnect"); rejectAnswer?.(fail("native_proxy_disconnected", true)); };
    return adapter;
  };
  f.hub.dispatch(f.args); await until(() => f.engine.store.data.codexDiscussionDeliveries[f.args.requestId].status === "queued");
  await f.hub.close();
  f.engine.store = new Store(f.root); f.engine.discussions.store = f.engine.store;
  f.engine.store.data.desktopPreferences = { allowNativeFullAccess: true };
  const calls = [];
  const restarted = new CodexDiscussionHub(f.engine, { adapterFactory: () => ({
    open: async () => {}, close() {},
    bindReadTarget: async input => { calls.push({ method: "metadata-bind", ...input }); },
    reconcileAnswer: async input => { calls.push({ method: "read-owned-completion", ...input }); return {
      status: "completed", clientId: input.clientId, nativeThreadId: input.threadId,
      nativeTurnId: TURN, text: "Completed after companion restart", usage: { known: false },
    }; },
    answer() { throw new Error("Restart reconciliation must not enqueue or cancel a turn"); },
  }) });
  const result = await restarted.reconcileSubmitted();
  assert.deepEqual(result.reconciled, [f.args.requestId]); assert.equal(result.nativeInputRetried, false);
  assert.deepEqual(calls.map(call => call.method), ["metadata-bind", "read-owned-completion"]);
  const group = f.engine.discussions.group(f.args.discussionId);
  assert.equal(group.messages.length, 2); assert.equal(group.messages.at(-1).replyTo, f.args.messageId);
  assert.equal(group.messages.at(-1).source.nativeThreadId, THREAD);
  assert.equal(f.engine.store.data.codexDiscussionNativeReceipts[f.args.requestId].queuedSubmissionId, "restart-owned-queue-id");
  await restarted.reconcileSubmitted(); assert.equal(group.messages.length, 2); assert.equal(calls.length, 2);
  await restarted.close();
});

test("native validation uses the addressed message epoch while retaining historical-root grant checks", async t => {
  const { engine, hub, args, counters } = setup(); t.after(() => hub.close());
  const author = "sample-claude-new";
  engine.discussions.contribute({ id: args.discussionId, text: "Historical participant root", nativeTurnId: "historical-turn",
    deliveryId: "native-old-participant-root" }, { sessionId: author });
  const group = engine.discussions.group(args.discussionId), root = group.messages.at(-1);
  engine.discussions.setPolicy({ id: group.id, agentInitiation: true });
  assert.throws(() => hub.dispatch({ ...args, messageId: root.id, requestId: "native-old-root-request" }), /policy/);
  engine.discussions.contribute({ id: group.id, text: "@codex1 answer this new reply", nativeTurnId: "new-reply-turn",
    replyTo: root.id, deliveryId: "native-new-participant-reply" }, { sessionId: author });
  const reply = group.messages.at(-1), request = { ...args, messageId: reply.id, text: reply.text, requestId: "native-new-root-reply-request" };
  hub.dispatch(request); await hub.wait(request.requestId); assert.equal(counters.answer, 1);
  assert.equal(group.messages.at(-1).replyTo, reply.id);
});

test("a revoked historical root author blocks native dispatch before adapter creation", async t => {
  const { engine, hub, args, counters } = setup(); t.after(() => hub.close());
  engine.grant("sample-claude-old", { enrolled: true, content: true, share: true, retrieve: true });
  const group = engine.discussions.group(args.discussionId);
  group.members.push({ ...engine.discussions.member("sample-claude-old"), alias: "claude2" });
  engine.discussions.contribute({ id: group.id, text: "Historical root", nativeTurnId: "old-root-turn",
    deliveryId: "native-revoked-history-root" }, { sessionId: "sample-claude-new" });
  const root = group.messages.at(-1); engine.discussions.setPolicy({ id: group.id, agentInitiation: true });
  engine.discussions.contribute({ id: group.id, text: "@codex1 inspect this ancestry", nativeTurnId: "current-reply-turn",
    replyTo: root.id, deliveryId: "native-current-history-reply" }, { sessionId: "sample-claude-old" });
  const reply = group.messages.at(-1); engine.grant("sample-claude-new", { retrieve: false });
  assert.throws(() => hub.dispatch({ ...args, messageId: reply.id, requestId: "native-revoked-ancestor-request" }), /retrieval|grant|revoked/);
  assert.equal(counters.factory, 0); assert.equal(counters.answer, 0);
});
