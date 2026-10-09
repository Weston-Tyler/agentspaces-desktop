import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../app/engine.mjs";
import { Store } from "../app/store.mjs";
import { FabricAdapter } from "../app/fabric.mjs";
import { CodexDiscussionHub } from "../app/codex-discussions.mjs";

function setup({ sourceCount = 1 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "as-codex-recovery-"));
  const engine = new Engine(new Store(root), new FabricAdapter({ stateRoot: root }));
  engine.loadSample(); engine.mode = "workspace-connected";
  const template = engine.session("sample-codex-old");
  const sources = Array.from({ length: sourceCount }, (_, i) => ({ ...template,
    id: "native-recovery-source-" + i, fixture: false, host: "remote", status: "unknown",
    nativeThreadId: "11111111-2222-4333-8444-" + String(i + 1).padStart(12, "0"),
    cwd: "/tmp/agentspaces-recovery-fixture-" + i }));
  engine.catalog.push(...sources);
  const peer = engine.session("sample-claude-new");
  for (const source of [...sources, peer]) engine.grant(source.id, { enrolled: true, content: true, share: true, retrieve: true });
  engine.store.data.projects[template.project].fixture = false;
  const groupId = engine.discussions.create({ title: "Undispatched recovery fixture", sessionIds: [...sources.map(s => s.id), peer.id] }).id;
  engine.discussions.post({ id: groupId, text: "Original owner question", deliveryId: "recovery-owner-message-0001" });
  const group = engine.discussions.group(groupId), message = group.messages[0];
  let unhealthy = true; const counts = { factory: 0, binds: 0, answers: 0, closes: 0 }, calls = [];
  const hub = new CodexDiscussionHub(engine, { adapterFactory: callbacks => {
    counts.factory++;
    return { events: new EventEmitter(), open: async () => {},
      async bindExistingThread(input) {
        counts.binds++;
        if (unhealthy) throw Object.assign(new Error("SENSITIVE_PROVIDER_DIAGNOSTIC_NEVER_EXPOSE"),
          { code: "native_protocol_unavailable", rpcMethod: "initialize", uncertainOutcome: true });
        return { nativeThreadId: input.threadId, permissionProof: { nativeThreadId: input.threadId, cwd: input.cwd } };
      },
      async answer(input) {
        input.dispatchFence?.(); counts.answers++; calls.push(input);
        assert(engine.store.data.codexDiscussionDeliveries[input.clientId]);
        const turn = "fixture-recovery-turn-" + counts.answers;
        const receipt = { clientId: input.clientId, nativeThreadId: input.threadId, nativeTurnId: turn, status: "completed", retryAllowed: false };
        await callbacks.persistReceipt(receipt);
        return { nativeThreadId: input.threadId, nativeTurnId: turn, text: "Recovered fixture answer", usage: { known: false }, receipt };
      }, close() { counts.closes++; },
    };
  } });
  const args = (suffix = "0001", source = sources[0], addressed = message) => ({ sessionId: source.id,
    discussionId: groupId, messageId: addressed.id, text: addressed.text, requestId: "recovery-request-" + suffix,
    budget: { timeoutMs: 90000, maxOutputTokens: 800 } });
  const failFirst = async request => { hub.dispatch(request); await hub.wait(request.requestId); return engine.store.data.codexDiscussionDeliveries[request.requestId]; };
  return { engine, sources, peer, group, message, hub, args, failFirst, counts, calls, healthy: () => unhealthy = false };
}

test("known protocol-undispatched messages recover once using the original message and request identity", async t => {
  const f = setup(); t.after(() => f.hub.close()); const args = f.args(), effect = await f.failFirst(args);
  assert.equal(effect.undispatched, true); assert.equal(effect.uncertainOutcome, false);
  assert.equal(effect.reasonCode, "native_protocol_unavailable"); assert.equal(effect.failedMethod, "initialize");
  assert.match(effect.reason, /not queued/); assert(!JSON.stringify(effect).includes("SENSITIVE_PROVIDER_DIAGNOSTIC"));
  assert.equal(f.counts.answers, 0); const originalHash = effect.inputHash;
  f.healthy(); const recovered = await f.hub.recoverUndispatched(); assert.deepEqual(recovered.recovered, [args.requestId]);
  await f.hub.wait(args.requestId); assert.equal(f.counts.answers, 1);
  assert.equal(effect.inputHash, originalHash); assert.equal(effect.messageId, f.message.id);
  assert.equal(f.calls[0].clientId, args.requestId); assert.equal(f.calls[0].threadId, f.sources[0].nativeThreadId);
  assert(f.calls[0].question.includes(f.message.text)); assert.equal(f.message.author, "You");
  assert.equal(f.group.messages.length, 2); assert.equal(f.group.messages[1].replyTo, f.message.id);
  assert.equal(effect.retryCount, 1); assert.equal(effect.previousAttempts.length, 1);
  await f.hub.recoverUndispatched(); assert.equal(f.counts.answers, 1);
});

test("concurrent recovery passes never allocate a duplicate native question", async t => {
  const f = setup(); t.after(() => f.hub.close()); const request = f.args(); await f.failFirst(request); f.healthy();
  const results = await Promise.all([f.hub.recoverUndispatched(), f.hub.recoverUndispatched(), f.hub.recoverUndispatched()]);
  assert.equal(results.flatMap(result => result.recovered).length, 1);
  await f.hub.wait(request.requestId); assert.equal(f.counts.answers, 1); assert.equal(f.group.messages.length, 2);
});

test("unknown or uncertain outcomes, any native receipt, turn identity and active abort exclude recovery", async t => {
  const changes = [
    (f, effect) => { delete effect.undispatched; },
    (f, effect) => { effect.undispatched = false; effect.uncertainOutcome = true; },
    (f, effect) => { f.engine.store.data.codexDiscussionNativeReceipts[effect.requestId] = { status: "prepared", undispatched: true }; },
    (f, effect) => { effect.nativeTurnId = "already-allocated-native-turn"; },
    (f, effect) => { f.hub.aborters.set(effect.requestId, new AbortController()); },
  ];
  for (const change of changes) {
    const f = setup(); t.after(() => f.hub.close()); const request = f.args(), effect = await f.failFirst(request);
    change(f, effect); f.healthy(); const before = f.counts.factory;
    assert.deepEqual((await f.hub.recoverUndispatched()).recovered, []);
    assert.equal(f.counts.factory, before); assert.equal(f.counts.answers, 0);
  }
});

test("current source grants, root-author grants and room policy fence undispatched recovery", async t => {
  for (const kind of ["source", "ancestor", "policy"]) {
    const f = setup({ sourceCount: 2 }); t.after(() => f.hub.close());
    let addressed = f.message;
    if (kind !== "source") {
      f.engine.discussions.contribute({ id: f.group.id, text: "Participant root", nativeTurnId: "fixture-root-turn",
        deliveryId: "recovery-participant-root" }, { sessionId: f.peer.id });
      const root = f.group.messages.at(-1); f.engine.discussions.setPolicy({ id: f.group.id, agentInitiation: true });
      f.engine.discussions.contribute({ id: f.group.id, text: "@codex1 inspect the earlier source", nativeTurnId: "fixture-current-turn",
        deliveryId: "recovery-current-participant", replyTo: root.id }, { sessionId: f.sources[1].id });
      addressed = f.group.messages.at(-1);
    }
    const request = f.args("fenced-0001", f.sources[0], addressed); await f.failFirst(request); f.healthy();
    if (kind === "source") f.engine.grant(f.sources[0].id, { enrolled: false });
    if (kind === "ancestor") f.engine.grant(f.peer.id, { retrieve: false });
    if (kind === "policy") f.engine.discussions.setPolicy({ id: f.group.id, agentInitiation: false });
    const before = f.counts.factory; assert.deepEqual((await f.hub.recoverUndispatched()).recovered, []);
    assert.equal(f.counts.factory, before); assert.equal(f.counts.answers, 0);
  }
});

test("editing an undispatched message does not reuse its recorded native request hash", async t => {
  const f = setup(); t.after(() => f.hub.close()); await f.failFirst(f.args()); f.healthy();
  f.message.text = "Different owner message";
  assert.deepEqual((await f.hub.recoverUndispatched()).recovered, []); assert.equal(f.counts.answers, 0);
});

test("protocol-only recovery is bounded to three additional binding attempts", async t => {
  const f = setup(); t.after(() => f.hub.close()); const request = f.args(), effect = await f.failFirst(request);
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.deepEqual((await f.hub.recoverUndispatched()).recovered, [request.requestId]);
    await f.hub.wait(request.requestId); assert.equal(effect.retryCount, attempt); assert.equal(effect.undispatched, true);
  }
  f.healthy(); assert.deepEqual((await f.hub.recoverUndispatched()).recovered, []);
  assert.equal(f.counts.binds, 4); assert.equal(f.counts.answers, 0); assert.equal(effect.previousAttempts.length, 3);
});

test("each pass recovers at most four sources and one FIFO request per source", async t => {
  const f = setup({ sourceCount: 5 }); t.after(() => f.hub.close());
  const requests = [f.args("source-0-first", f.sources[0]), f.args("source-0-second", f.sources[0]),
    ...f.sources.slice(1).map((source, i) => f.args("source-" + (i + 1) + "-first", source))];
  for (const request of requests) await f.failFirst(request);
  f.healthy(); const first = await f.hub.recoverUndispatched();
  assert.deepEqual(first.recovered, [requests[0].requestId, requests[2].requestId, requests[3].requestId, requests[4].requestId]);
  await Promise.all(first.recovered.map(request => f.hub.wait(request)));
  assert.equal(f.counts.answers, 4);
  const second = await f.hub.recoverUndispatched(); assert.deepEqual(second.recovered, [requests[1].requestId, requests[5].requestId]);
  await Promise.all(second.recovered.map(request => f.hub.wait(request))); assert.equal(f.counts.answers, 6);
  assert.deepEqual((await f.hub.recoverUndispatched()).recovered, []);
});

test("unknown legacy failures require explicit legacy inclusion and are never replayed automatically", async t => {
  const f = setup(); t.after(() => f.hub.close()); const request = f.args(), effect = await f.failFirst(request);
  delete effect.reasonCode; f.healthy();
  assert.deepEqual((await f.hub.recoverUndispatched()).recovered, []); assert.equal(f.counts.answers, 0);
  assert.deepEqual((await f.hub.recoverUndispatched({ includeLegacy: true })).recovered, [request.requestId]);
  await f.hub.wait(request.requestId); assert.equal(f.counts.answers, 1);
  assert.equal(effect.previousAttempts[0].reasonCode, "legacy-binding-unavailable");
});

async function submittedFixture(t, { participantRoot = false, openGate, bindGate, readGate, result } = {}) {
  const f = setup({ sourceCount: participantRoot ? 2 : 1 });
  let addressed = f.message;
  if (participantRoot) {
    f.engine.discussions.contribute({ id: f.group.id, text: "Source root", nativeTurnId: "fixture-ancestor-turn",
      deliveryId: "submitted-participant-root" }, { sessionId: f.peer.id });
    const root = f.group.messages.at(-1); f.engine.discussions.setPolicy({ id: f.group.id, agentInitiation: true });
    f.engine.discussions.contribute({ id: f.group.id, text: "@codex1 a new scoped reply", nativeTurnId: "fixture-addressed-turn",
      deliveryId: "submitted-participant-reply", replyTo: root.id }, { sessionId: f.sources[1].id });
    addressed = f.group.messages.at(-1);
  }
  const request = f.args("submitted-0001", f.sources[0], addressed), effect = await f.failFirst(request);
  f.hub.close();
  Object.assign(effect, { status: "native-reply-uncertain", uncertainOutcome: true, undispatched: false });
  const receipt = { clientId: request.requestId, nativeThreadId: f.sources[0].nativeThreadId,
    queuedSubmissionId: "acknowledged-native-queue-id", status: "queued", retryAllowed: false };
  f.engine.store.data.codexDiscussionNativeReceipts[request.requestId] = receipt;
  f.engine.store.data.desktopPreferences = { allowNativeFullAccess: true };
  addressed.targets.push({ sessionId: f.sources[0].id, alias: "codex1", status: "native-reply-uncertain" });
  const reads = { factory: 0, open: 0, binds: 0, reads: 0, answers: 0, reroutes: 0, closes: 0 }, readArgs = [];
  const hub = new CodexDiscussionHub(f.engine, { onContribution() { reads.reroutes++; },
    adapterFactory() { reads.factory++; return {
      async open() { reads.open++; if (openGate) await openGate; },
      async bindLoadedThread(input) { reads.binds++; readArgs.push({ kind: "bind", ...input }); if (bindGate) await bindGate;
        return { nativeThreadId: input.threadId, permissionProof: { nativeThreadId: input.threadId } }; },
      async reconcileAnswer(input) {
        reads.reads++; readArgs.push({ kind: "read", ...input }); if (readGate) await readGate;
        const value = { status: "completed", nativeThreadId: receipt.nativeThreadId,
          nativeTurnId: "completed-native-turn-id", clientId: receipt.clientId,
          text: "@claude1 completed historical answer", usage: { known: false }, retryAllowed: false };
        return typeof result === "function" ? result(value) : { ...value, ...(result ?? {}) };
      },
      async answer() { reads.answers++; throw new Error("Reconciliation must never mutate the native queue"); },
      close() { reads.closes++; },
    }; } });
  t.after(() => hub.close());
  return { ...f, hub, request, effect, receipt, addressed, reads, readArgs };
}
const phase = async predicate => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(yes => setTimeout(yes, 5)); }
  throw new Error("Expected fake reconciliation phase");
};

test("submitted completed input is read and published once with original parent and stable delivery identity", async t => {
  const f = await submittedFixture(t), before = f.group.messages.length;
  const [first, parallel] = await Promise.all([f.hub.reconcileSubmitted(), f.hub.reconcileSubmitted()]);
  assert.deepEqual(first.reconciled, [f.request.requestId]); assert.deepEqual(parallel.reconciled, []);
  assert.equal(f.reads.reads, 1); assert.equal(f.reads.answers, 0); assert.equal(f.reads.reroutes, 0);
  assert.equal(f.group.messages.length, before + 1); const reply = f.group.messages.at(-1);
  assert.equal(reply.replyTo, f.addressed.id); assert.equal(reply.source.nativeThreadId, f.sources[0].nativeThreadId);
  assert.equal(reply.turnId, "completed-native-turn-id");
  assert.equal(reply.deliveryId, "codex-" + createHash("sha256").update(JSON.stringify(f.request.requestId)).digest("hex"));
  assert.equal(f.receipt.status, "completed"); assert.equal(f.effect.status, "native-agent-replied");
  assert.equal(f.effect.uncertainOutcome, false); assert.equal(f.effect.reconciled, true);
  assert.equal(f.readArgs[1].clientId, f.request.requestId); assert.equal(f.readArgs[1].threadId, f.sources[0].nativeThreadId);
  await f.hub.reconcileSubmitted(); assert.equal(f.reads.reads, 1); assert.equal(f.group.messages.length, before + 1);
});

test("submitted receipt client/thread mismatch or missing acknowledged queue identity refuses before native reads", async t => {
  for (const change of [
    receipt => { receipt.clientId = "another-native-client"; },
    receipt => { receipt.nativeThreadId = "99999999-2222-4333-8444-555555555555"; },
    receipt => { delete receipt.queuedSubmissionId; },
  ]) {
    const f = await submittedFixture(t), before = f.group.messages.length; change(f.receipt);
    assert.deepEqual((await f.hub.reconcileSubmitted()).reconciled, []);
    assert.equal(f.reads.factory, 0); assert.equal(f.reads.reads, 0); assert.equal(f.reads.answers, 0);
    assert.equal(f.group.messages.length, before);
  }
});

test("returned foreign identity, absent turn/text and wrong client correlation are never published", async t => {
  const results = [ { nativeThreadId: "99999999-2222-4333-8444-555555555555" },
    { clientId: "different-native-user-client" }, { nativeTurnId: null }, { text: "" }, { text: "   " } ];
  for (const result of results) {
    const f = await submittedFixture(t, { result }), before = f.group.messages.length;
    assert.deepEqual((await f.hub.reconcileSubmitted()).reconciled, []);
    assert.equal(f.group.messages.length, before); assert.equal(f.effect.uncertainOutcome, true);
    assert.equal(f.reads.answers, 0); assert.equal(f.reads.reroutes, 0);
  }
});

test("queued or unknown native history is retained without repost, native retry or agent routing", async t => {
  for (const status of ["queued", "uncertain", "inProgress"]) {
    const f = await submittedFixture(t, { result: { status } }), before = f.group.messages.length;
    assert.deepEqual((await f.hub.reconcileSubmitted()).reconciled, []);
    assert.equal(f.group.messages.length, before); assert.equal(f.effect.uncertainOutcome, true);
    assert.equal(f.reads.answers, 0); assert.equal(f.reads.reroutes, 0); assert.equal(f.reads.closes, 1);
  }
});

test("current source, ancestor and room policy revocation refuse submitted reconciliation before reads", async t => {
  for (const kind of ["source", "ancestor", "policy", "native-policy", "active-abort"]) {
    const f = await submittedFixture(t, { participantRoot: kind === "ancestor" || kind === "policy" });
    const before = f.group.messages.length;
    if (kind === "source") f.engine.grant(f.sources[0].id, { enrolled: false });
    if (kind === "ancestor") f.engine.grant(f.peer.id, { retrieve: false });
    if (kind === "policy") f.engine.discussions.setPolicy({ id: f.group.id, agentInitiation: false });
    if (kind === "native-policy") f.engine.store.data.desktopPreferences.allowNativeFullAccess = false;
    if (kind === "active-abort") f.hub.aborters.set(f.request.requestId, new AbortController());
    assert.deepEqual((await f.hub.reconcileSubmitted()).reconciled, []);
    assert.equal(f.reads.factory, 0); assert.equal(f.reads.reads, 0); assert.equal(f.group.messages.length, before);
  }
});

test("revocation during transport opening prevents binding and own-turn reads", async t => {
  let release; const gate = new Promise(yes => release = yes);
  const f = await submittedFixture(t, { openGate: gate, participantRoot: true }); t.after(() => release());
  const reconciling = f.hub.reconcileSubmitted(); await phase(() => f.reads.open === 1);
  f.engine.grant(f.peer.id, { retrieve: false }); release();
  assert.deepEqual((await reconciling).reconciled, []);
  assert.equal(f.reads.binds, 0); assert.equal(f.reads.reads, 0); assert.equal(f.reads.answers, 0);
});

test("revocation during native metadata binding prevents completed own-turn reads", async t => {
  let release; const gate = new Promise(yes => release = yes);
  const f = await submittedFixture(t, { bindGate: gate }); t.after(() => release());
  const reconciling = f.hub.reconcileSubmitted(); await phase(() => f.reads.binds === 1);
  f.engine.grant(f.sources[0].id, { share: false }); release();
  assert.deepEqual((await reconciling).reconciled, []);
  assert.equal(f.reads.reads, 0); assert.equal(f.reads.answers, 0);
});

test("source or room policy revocation during own-turn reading prevents completed answer publication", async t => {
  for (const kind of ["source", "ancestor", "policy", "native-policy"]) {
    let release; const gate = new Promise(yes => release = yes);
    const f = await submittedFixture(t, { readGate: gate, participantRoot: kind === "policy" || kind === "ancestor" }); t.after(() => release());
    const before = f.group.messages.length, reconciling = f.hub.reconcileSubmitted(); await phase(() => f.reads.reads === 1);
    if (kind === "source") f.engine.grant(f.sources[0].id, { share: false });
    if (kind === "ancestor") f.engine.grant(f.peer.id, { retrieve: false });
    if (kind === "policy") f.engine.discussions.setPolicy({ id: f.group.id, agentInitiation: false });
    if (kind === "native-policy") f.engine.store.data.desktopPreferences.allowNativeFullAccess = false;
    release(); assert.deepEqual((await reconciling).reconciled, []);
    assert.equal(f.group.messages.length, before); assert.equal(f.reads.answers, 0); assert.equal(f.reads.reroutes, 0);
  }
});
