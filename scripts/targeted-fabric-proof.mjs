import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { FabricAdapter } from "../app/fabric.mjs";

// No model, native-history reader, custom claim lattice, or application queue.
const java = process.env.AGENTSPACES_TEST_JAVA;
const cp = process.env.AGENTSPACES_TEST_CLASSPATH;
if (!java || !cp)
  throw new Error(
    "Supply pinned owning Java runtime/classpath with TargetedWorkProof compiled",
  );
const port = Number(process.env.AGENTSPACES_TEST_PORT ?? 43130);
const root = mkdtempSync(join(tmpdir(), "as-target-proof-"));
const child = spawn(java, ["-cp", cp, "TargetedWorkProof", String(port)], {
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});
const fabric = new FabricAdapter({ stateRoot: root });
const work = "desktop-target-fixture-work",
  other = "desktop-target-fixture-other";
const requestType = "TargetedWorkProof$Request#v1",
  resultType = "TargetedWorkProof$Result#v1";
let output = "",
  diagnostics = "",
  exited = null;
child.stdout.on("data", (b) => {
  output += b.toString();
});
child.stderr.on("data", (b) => {
  diagnostics = (diagnostics + b.toString()).slice(-4000);
});
child.on("exit", (code) => {
  exited = code;
});
const wait = async (predicate, message, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (predicate()) return;
    if (exited !== null)
      throw new Error("Java proof exited " + exited + ": " + diagnostics);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(message + ": " + diagnostics);
};
try {
  await wait(() => /GROUP=([^\r\n]+)/.test(output), "Seed startup timed out");
  const groupId = /GROUP=([^\r\n]+)/.exec(output)[1];
  await fabric.connect({ host: "127.0.0.1", port, groupId });
  const requests = [
    { requestId: "fixture-A-1", target: "targetA", fixture: true },
    { requestId: "fixture-B-1", target: "targetB", fixture: true },
    { requestId: "fixture-A-2", target: "targetA", fixture: true },
  ].map((value) => ({
    ...value,
    entryId: fabric.write(work, requestType, value, "fixture-owner"),
  }));
  const unrelated = fabric.write(
    other,
    requestType,
    { requestId: "fixture-wrongspace", target: "targetA", fixture: true },
    "fixture-owner",
  );
  child.stdin.write("RUN\n");
  await wait(
    () => output.includes("DONE="),
    "Targeted Java workers timed out",
    35000,
  );
  let results = [];
  await wait(() => {
    fabric.peer.pullSpace(work);
    fabric.peer.pullSpace(other);
    results = fabric.read(work, resultType);
    return (
      results.length === 3 &&
      fabric.peer.states.has(unrelated) &&
      requests.every(
        (r) => fabric.peer.states.get(r.entryId)?.completed === true,
      )
    );
  }, "Signed results/completions not observed");
  const retained = [];
  for (const request of requests) {
    const result = results.find((r) => r.value.requestId === request.requestId);
    assert(result, "Each requested target must contribute its own result");
    assert.equal(result.value.requestEntryId, request.entryId);
    assert.equal(result.value.target, request.target);
    assert.equal(result.value.fixture, true);
    assert(
      result.issuer.endsWith("/" + request.target),
      "Result issuer must be the selected target actor",
    );
    assert.equal(
      fabric.peer.claims.get(request.entryId)?.claim?.holder,
      result.issuer,
    );
    assert.equal(fabric.peer.states.get(request.entryId)?.completed, true);
    retained.push({
      requestId: request.requestId,
      requestEntryId: request.entryId,
      target: request.target,
      resultEntryId: result.entryId,
      nativeTurnId: result.value.nativeTurnId,
      issuer: result.issuer,
      completionObserved: true,
    });
  }
  assert(
    fabric.peer.states.has(unrelated),
    "Other-space entry must still be present",
  );
  assert.notEqual(fabric.peer.states.get(unrelated)?.completed, true);
  assert.equal(fabric.peer.claims.has(unrelated), false);
  assert.equal(fabric.read(other, requestType).length, 1);
  assert.equal(fabric.read(work, requestType).length, 0);
  assert.equal(fabric.read(other, resultType).length, 0);
  console.log(
    JSON.stringify(
      {
        proof:
          "real signed Java/TypeScript fabric with owning targeted templates; synthetic payloads",
        groupId,
        targetedRequests: retained,
        wrongSpaceEntryId: unrelated,
        wrongSpaceUnclaimed: true,
        consumedRequestsNotRetaken: true,
        nativeProviderCalls: 0,
        upstreamTypeScript: "be025e7aba72e1837e0ccb3999bb76098d012fe0",
      },
      null,
      2,
    ),
  );
  child.stdin.write("ACK\n");
} finally {
  fabric.close();
  child.kill();
}
