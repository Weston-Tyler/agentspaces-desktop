import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { FabricAdapter, TYPES } from "../app/fabric.mjs";
import { ExecutionGate } from "../app/controller.mjs";
import { cbor, Peer, verifySignedGroupAd } from "@agentspaces/client";
import { Engine } from "../app/engine.mjs";
import { Store } from "../app/store.mjs";
const java = process.env.AGENTSPACES_TEST_JAVA,
  cp = process.env.AGENTSPACES_TEST_CLASSPATH;
if (!java || !cp)
  throw new Error(
    "Supply the locally built pinned upstream Java runtime/classpath. This proof must not substitute a fake seed.",
  );
const port = Number(process.env.AGENTSPACES_TEST_PORT ?? 43129),
  root = mkdtempSync(join(tmpdir(), "as-fabric-proof-"));
const child = spawn(java, ["-cp", cp, "LoopbackSeed", String(port)], {
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let seedDiagnostics = "";
child.stderr.on("data", (data) => {
  seedDiagnostics = (seedDiagnostics + data).slice(-4000);
});
const a = new FabricAdapter({ stateRoot: join(root, "codex") }),
  b = new FabricAdapter({ stateRoot: join(root, "claude") });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.AGENTSPACES_PROOF_DIAGNOSTICS === "1") {
  const original = Peer.prototype.offerGroupAd;
  Peer.prototype.offerGroupAd = function (env) {
    let verified = null;
    try {
      verified = verifySignedGroupAd(cbor.loads(Buffer.from(env.body)));
    } catch {}
    console.error(
      JSON.stringify({
        diagnostic: "group answer",
        kind: env.kind,
        groupMatches: env.group === this.group,
        verifiedMatches: verified === this.group,
        issued: cbor.loads(Buffer.from(env.body))?.advertisement?.issued,
      }),
    );
    return original.call(this, env);
  };
}
async function until(read, predicate) {
  for (let i = 0; i < 50; i++) {
    const value = read();
    if (predicate(value)) return value;
    await sleep(100);
  }
  throw new Error("Fabric observation timed out");
}
try {
  const groupId = await new Promise((yes, no) => {
    let out = "";
    const timer = setTimeout(
      () => no(new Error("Seed startup timeout")),
      10000,
    );
    child.on("error", no);
    child.on("exit", (code) => {
      clearTimeout(timer);
      no(new Error(`Seed exited ${code}`));
    });
    child.stdout.on("data", (data) => {
      out += data;
      const match = /GROUP=([^\r\n]+)/.exec(out);
      if (match) {
        clearTimeout(timer);
        yes(match[1]);
      }
    });
  });
  await a.connect({ host: "127.0.0.1", port, groupId });
  await b.connect({ host: "127.0.0.1", port, groupId });
  const engine = new Engine(new Store(join(root, "settings")), a);
  engine.loadSample();
  engine.fabricProject = "sample-research";
  engine.grant("sample-codex-old", {
    enrolled: true,
    content: true,
    share: true,
  });
  engine.grant("sample-codex-new", { enrolled: true, retrieve: true });
  engine.grant("sample-claude-new", { enrolled: true, retrieve: true });
  const publication = await engine.publish("sample-codex-old");
  const entryId = publication.entryId;
  let received = await until(
    () => b.read("desktop-fixture-context", TYPES.finding),
    (rows) => rows.some((r) => r.entryId === entryId),
  );
  assert.equal(received[0].value.source.threadId, "sample-codex-old");
  assert.match(received[0].issuer, /\//);
  assert.equal(received.filter((r) => r.entryId === entryId).length, 1);
  const originalIssuer = a.participant("sample-codex-old").agentId;
  a.close();
  await a.connect({ host: "127.0.0.1", port, groupId });
  assert.equal(a.participant("sample-codex-old").agentId, originalIssuer);
  received = await until(
    () => a.read("desktop-fixture-context", TYPES.finding),
    (rows) => rows.some((r) => r.entryId === entryId),
  );
  assert.equal(received[0].value.fixture, true);
  const sameTool = await engine.retrieve({
    sourceId: "sample-codex-old",
    requesterId: "sample-codex-new",
  });
  const crossTool = await engine.retrieve({
    sourceId: "sample-codex-old",
    requesterId: "sample-claude-new",
  });
  assert.equal(sameTool.handoff.relation, "same-tool");
  assert.equal(crossTool.handoff.relation, "cross-tool");
  assert.match(crossTool.handoff.coordination, /real AgentSpaces/);
  assert.equal((await engine.publish("sample-codex-old")).duplicate, true);
  const taskId = a.write(
    "desktop-fixture-work",
    TYPES.request,
    {
      requestId: "fixture-request",
      sourceEntryId: entryId,
      fixture: true,
      budget: 100,
    },
    "fixture-new",
  );
  const holder = b.participant("fixture-claude-target");
  const held = await b.peer.takeEntry(
    "desktop-fixture-work",
    TYPES.request,
    "fixture-worker",
    10000,
    300,
    8000,
    holder,
  );
  assert.equal(held, taskId);
  const payload = cbor.loads(
    Buffer.from(b.peer.states.get(held).record.payload),
  );
  assert.equal(payload.sourceEntryId, entryId);
  let effects = 0;
  const adapter = {
    fixture: true,
    allocateTurnId: () => "fixture-native-turn-1",
    execute: async () => {
      effects++;
      return { status: "completed", result: "bounded synthetic follow-up" };
    },
    reconcile: async () => null,
  };
  const gate = new ExecutionGate(join(root, "effect-receipts"));
  const native = {
    provider: "claude",
    account: "fixture",
    threadId: "fixture-claude-target",
  };
  const result = await gate.run(native, held, adapter, {
    grant: true,
    budget: 100,
  });
  await gate.run(native, held, adapter, { grant: true, budget: 100 });
  assert.equal(effects, 1);
  b.write(
    "desktop-fixture-work",
    TYPES.result,
    {
      requestEntryId: held,
      nativeTurnId: result.nativeTurnId,
      result: result.result,
      fixture: true,
    },
    "fixture-claude-target",
  );
  b.peer.completeEntry("desktop-fixture-work", held, holder);
  const results = await until(
    () => a.read("desktop-fixture-work", TYPES.result),
    (rows) => rows.some((r) => r.value.requestEntryId === taskId),
  );
  assert.equal(results.length, 1);
  await until(
    () => {
      a.peer.pullSpace("desktop-fixture-work");
      return a.peer.states.get(taskId);
    },
    (dto) => dto?.completed === true,
  );
  b.close();
  assert.throws(
    () => b.read("desktop-fixture-work", TYPES.result),
    /disconnected/,
  );
  console.log(
    JSON.stringify(
      {
        proof:
          "real upstream Java/TypeScript loopback fabric; synthetic session and execution payloads",
        groupId,
        signedFinding: true,
        sameToolAppRetrieval: true,
        crossToolAppRetrieval: true,
        attestedIssuerStableAfterRestart: true,
        leasedTake: true,
        resultObserved: true,
        completionObserved: true,
        duplicateEffects: 0,
        nativeProviderCalls: 0,
        upstreamBinding: "be025e7aba72e1837e0ccb3999bb76098d012fe0",
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.error(seedDiagnostics);
  throw e;
} finally {
  a.close();
  b.close();
  child.kill();
}
