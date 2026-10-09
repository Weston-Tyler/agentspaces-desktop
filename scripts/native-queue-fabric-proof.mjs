import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import { FabricAdapter } from "../app/fabric.mjs";
import { protectStateDirectory } from "../app/state-security.mjs";
import { CodexQueueAdapter } from "../app/codex-queue.mjs";
import { cbor } from "@agentspaces/client";
import { recoverOwnedNativeAnswers } from "./native-queue-recovery.mjs";

// Live invocation requires both a CLI switch and the parent-approved exact cap.
// No retries, private history, native history copies, or local claim algorithm.
const recovery = process.argv.includes("--recover");
if (
  recovery
    ? process.argv.includes("--live") ||
      process.env.AGENTSPACES_NATIVE_PROOF_MAX_CALLS !== "0" ||
      !process.env.AGENTSPACES_NATIVE_PROOF_RECOVER_FROM
    : !process.argv.includes("--live") ||
      process.env.AGENTSPACES_NATIVE_PROOF_MAX_CALLS !== "3"
)
  throw new Error(
    "Live requires explicit --live/cap3; recovery requires --recover/cap0/source state and never calls a model",
  );
const java = process.env.AGENTSPACES_TEST_JAVA,
  cp = process.env.AGENTSPACES_TEST_CLASSPATH;
if (!java || !cp || !process.env.AGENTSPACES_NATIVE_PROOF_STATE)
  throw new Error(
    "Supply compiled owning Java runtime/classpath and a fresh durable proof state directory",
  );
const root = resolve(process.env.AGENTSPACES_NATIVE_PROOF_STATE);
mkdirSync(root, { recursive: true });
protectStateDirectory(root);
const receiptFile = join(root, "settings.json");
if (existsSync(receiptFile))
  throw new Error(
    "Proof state already allocated; reconcile receipts without rerunning or retrying calls",
  );
let receipts = {
    __proof: {
      allocatedAt: new Date().toISOString(),
      maxNativeCalls: recovery ? 0 : 3,
      budgetPerCall: { timeoutMs: 90000, maxOutputTokens: 800 },
      ownedThreads: [],
      dispatchedCalls: 0,
    },
  },
  calls = 0,
  duplicateReceipts = 0;
const save = (value) => {
  receipts[value.clientId] = value;
  writeFileSync(receiptFile + ".tmp", JSON.stringify(receipts), {
    mode: 0o600,
  });
  renameSync(receiptFile + ".tmp", receiptFile);
};
// Allocate the durable run marker before connection or native thread creation.
writeFileSync(receiptFile, JSON.stringify(receipts), { mode: 0o600 });
const queue = new CodexQueueAdapter({
  persistReceipt: async (value) => save(value),
  loadReceipt: async (id) => receipts[id] ?? null,
});
const port = Number(process.env.AGENTSPACES_TEST_PORT ?? 43131);
const child = spawn(java, ["-cp", cp, "NativeQueueWorkProof", String(port)], {
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});
const fabric = new FabricAdapter({ stateRoot: root });
const work = "desktop-native-queue-work",
  other = "desktop-native-queue-other";
const requestType = "NativeQueueWorkProof$Request#v1",
  resultType = "NativeQueueWorkProof$Result#v1";
let output = "",
  buffer = "",
  diagnostics = "",
  failure = null,
  exited = null,
  callTail = Promise.resolve();
const requests = [],
  nativeAnswers = new Map();
let recoveredAnswers = null;
child.stderr.on("data", (b) => {
  diagnostics = (diagnostics + b).slice(-4000);
});
child.on("error", (e) => {
  failure = e;
});
child.on("exit", (code) => {
  exited = code;
});
child.stdout.on("data", (b) => {
  output += b;
  buffer += b;
  const lines = buffer.split("\n");
  buffer = lines.pop();
  for (const line of lines)
    if (line.startsWith("CALL=")) {
      callTail = callTail
        .then(async () => {
          const call = JSON.parse(
            Buffer.from(line.slice(5).trim(), "base64").toString("utf8"),
          );
          const request = requests.find((r) => r.requestId === call.requestId);
          assert(
            request &&
              request.entryId === call.requestEntryId &&
              request.target === call.target &&
              request.nativeThreadId === call.nativeThreadId,
            "Only this run's signed target work may dispatch a native question",
          );
          if (nativeAnswers.has(call.requestId) || (!recovery && calls >= 3))
            throw new Error(
              "Duplicate or over-budget native call refused; no retry",
            );
          const clientId =
            "asproof_" +
            createHash("sha256")
              .update(
                JSON.stringify([
                  request.entryId,
                  request.nativeThreadId,
                  "remote",
                ]),
              )
              .digest("hex")
              .slice(0, 48);
          const args = {
            threadId: request.nativeThreadId,
            clientId,
            question: request.question,
            grant: true,
            budget: { timeoutMs: 90000, maxOutputTokens: 800 },
          };
          let answer;
          if (recovery) answer = recoveredAnswers.get(call.requestId);
          else {
            calls++;
            save({
              ...receipts.__proof,
              clientId: "__proof",
              dispatchedCalls: calls,
            });
            answer = await queue.answer(args);
          }
          if (!answer)
            throw new Error("No acknowledged native result to recover");
          // Preserve actual answer and attribution before any downstream assertion.
          save({ ...answer.receipt, requestId: request.requestId, answer });
          assert.equal(answer.nativeThreadId, request.nativeThreadId);
          assert.equal(answer.receipt.status, "completed");
          assert(answer.nativeTurnId);
          assert.equal(
            answer.text.trim(),
            request.target === "targetA" ? "ORCHID" : "CEDAR",
          );
          // Receipt refusal is checked before any native queue mutation, not a second call.
          if (!recovery) {
            await assert.rejects(
              queue.answer(args),
              (error) =>
                error.code === "receipt_exists_reconcile_without_retry",
            );
            duplicateReceipts++;
          }
          nativeAnswers.set(call.requestId, answer);
          const result = {
            requestId: request.requestId,
            requestEntryId: request.entryId,
            target: request.target,
            nativeThreadId: answer.nativeThreadId,
            nativeTurnId: answer.nativeTurnId,
            queuedSubmissionId: answer.queuedSubmissionId,
            text: answer.text,
            usage: answer.usage,
            fixture: false,
          };
          child.stdin.write(
            "RESULT=" +
              Buffer.from(JSON.stringify(result)).toString("base64") +
              "\n",
          );
        })
        .catch((error) => {
          failure = error;
        });
    }
});
const wait = async (predicate, label, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (failure) throw failure;
    if (predicate()) return;
    if (exited !== null)
      throw new Error("Java worker exited " + exited + ": " + diagnostics);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(label + ": " + diagnostics);
};
const scratch =
  "/tmp/agentspaces-nativequeue-" + randomUUID().replaceAll("-", "");
try {
  await wait(
    () => /GROUP=([^\r\n]+)/.test(output),
    "Owning seed startup timeout",
  );
  const groupId = /GROUP=([^\r\n]+)/.exec(output)[1];
  await fabric.connect({ host: "127.0.0.1", port, groupId });
  if (!recovery)
    await new Promise((yes, no) => {
      const mkdir = spawn("ssh", ["remote", "mkdir -m 700 -- " + scratch], {
        windowsHide: true,
        stdio: "ignore",
      });
      mkdir.on("error", no);
      mkdir.on("exit", (code) =>
        code === 0 ? yes() : no(new Error("Owned scratch creation failed")),
      );
    });
  await queue.open();
  let A, B;
  if (recovery) {
    const originalPath = resolve(
      process.env.AGENTSPACES_NATIVE_PROOF_RECOVER_FROM,
    );
    const original = JSON.parse(
      readFileSync(join(originalPath, "settings.json"), "utf8"),
    );
    const recovered = await recoverOwnedNativeAnswers(queue, original);
    recoveredAnswers = recovered.answers;
    [A, B] = recovered.threads.map((permissionProof) => ({
      nativeThreadId: permissionProof.nativeThreadId,
      permissionProof,
    }));
    save({
      ...receipts.__proof,
      clientId: "__proof",
      recovery: true,
      recoveredFrom: originalPath,
      originalDispatchedCalls: original.__proof.dispatchedCalls,
      originalSignedSnapshotRecovered: false,
      ownedThreads: recovered.threads,
    });
  } else
    A = await queue.createOwnedThread({
      cwd: scratch,
      grant: true,
      ownedScratch: true,
    });
  save({
    ...receipts.__proof,
    clientId: "__proof",
    ownedThreads: [A.permissionProof],
    scratch: recovery ? A.permissionProof.cwd : scratch,
  });
  if (!recovery)
    B = await queue.createOwnedThread({
      cwd: scratch,
      grant: true,
      ownedScratch: true,
    });
  save({
    ...receipts.__proof,
    clientId: "__proof",
    ownedThreads: [A.permissionProof, B.permissionProof],
    scratch: recovery ? A.permissionProof.cwd : scratch,
  });
  assert.notEqual(A.nativeThreadId, B.nativeThreadId);
  const specs = [
    {
      requestId: "native-A-1",
      target: "targetA",
      nativeThreadId: A.nativeThreadId,
      question: "Remember codeword ORCHID; reply ORCHID only",
    },
    {
      requestId: "native-B-1",
      target: "targetB",
      nativeThreadId: B.nativeThreadId,
      question: "Remember codeword CEDAR; reply CEDAR only",
    },
    {
      requestId: "native-A-2",
      target: "targetA",
      nativeThreadId: A.nativeThreadId,
      question: "What codeword did I give you earlier? Reply only it",
    },
  ];
  for (const spec of specs) {
    const value = { ...spec, fixture: false };
    requests.push({
      ...value,
      entryId: fabric.write(work, requestType, value, "proof-owner"),
    });
  }
  const distractor = fabric.write(
    other,
    requestType,
    {
      requestId: "native-wrongspace",
      target: "targetA",
      nativeThreadId: A.nativeThreadId,
      question: "Never execute this unrelated-space question",
      fixture: false,
    },
    "proof-owner",
  );
  child.stdin.write("RUN\n");
  await wait(
    () => output.includes("DONE="),
    "Bounded native work did not complete; reconcile without retry",
    320000,
  );
  await callTail;
  let results = [];
  await wait(() => {
    fabric.peer.pullSpace(work);
    fabric.peer.pullSpace(other);
    results = fabric.read(work, resultType);
    return (
      results.length === 3 &&
      fabric.peer.states.has(distractor) &&
      requests.every(
        (r) => fabric.peer.states.get(r.entryId)?.completed === true,
      )
    );
  }, "Signed native results or completions missing");
  // Preserve exact signed CBOR state/claim bytes before validation can fail.
  save({
    ...receipts.__proof,
    clientId: "__proof",
    signedSnapshot: {
      capturedAt: new Date().toISOString(),
      groupId,
      foundingBase64: Buffer.from(cbor.dumps(fabric.peer.founding)).toString(
        "base64",
      ),
      entries: [
        ...requests.map((r) => r.entryId),
        ...results.map((r) => r.entryId),
        distractor,
      ].map((entryId) => ({
        entryId,
        stateBase64: Buffer.from(
          cbor.dumps(fabric.peer.states.get(entryId)),
        ).toString("base64"),
        claimBase64: fabric.peer.claims.has(entryId)
          ? Buffer.from(cbor.dumps(fabric.peer.claims.get(entryId))).toString(
              "base64",
            )
          : null,
      })),
    },
  });
  const retained = requests.map((request) => {
    const result = results.find((r) => r.value.requestId === request.requestId),
      answer = nativeAnswers.get(request.requestId);
    assert(result && answer);
    for (const key of [
      "nativeThreadId",
      "nativeTurnId",
      "queuedSubmissionId",
      "text",
    ])
      assert.equal(result.value[key], answer[key]);
    assert.deepEqual(
      Object.keys(result.value.usage).sort(),
      Object.keys(answer.usage).sort(),
    );
    for (const key of Object.keys(answer.usage))
      assert.equal(result.value.usage[key], answer.usage[key]);
    assert.equal(result.value.requestEntryId, request.entryId);
    assert.equal(result.value.target, request.target);
    assert.equal(result.value.fixture, false);
    assert(result.issuer.endsWith("/" + request.target));
    assert.equal(
      fabric.peer.claims.get(request.entryId)?.claim?.holder,
      result.issuer,
    );
    return {
      requestId: request.requestId,
      requestEntryId: request.entryId,
      resultEntryId: result.entryId,
      issuer: result.issuer,
      ...result.value,
      completionObserved: true,
    };
  });
  assert.equal(
    nativeAnswers.get("native-A-1").nativeThreadId,
    nativeAnswers.get("native-A-2").nativeThreadId,
  );
  assert.notEqual(
    nativeAnswers.get("native-A-1").nativeTurnId,
    nativeAnswers.get("native-A-2").nativeTurnId,
  );
  assert.equal(calls, recovery ? 0 : 3);
  assert.equal(duplicateReceipts, recovery ? 0 : 3);
  assert.equal(fabric.peer.claims.has(distractor), false);
  assert.notEqual(fabric.peer.states.get(distractor)?.completed, true);
  assert.equal(fabric.read(work, requestType).length, 0);
  const proofReport = {
    proof: recovery
      ? "fresh owning signed targeted work with recovered acknowledged native results; native effects not replayed"
      : "owning signed targeted work plus actual shared native queue; owned read-only threads only",
    groupId,
    nativeProviderCalls: calls,
    durableReceiptRefusals: duplicateReceipts,
    targetedRequests: retained,
    permissionProofs: [A.permissionProof, B.permissionProof],
    source: recovery
      ? "exact receipt-bound owned native turn reads"
      : "queue acknowledgement and native turn notifications",
    recovery,
    originalSignedSnapshotRecovered: recovery ? false : true,
    sameOriginalThreadContinuity: true,
    wrongSpaceUnclaimed: true,
    arbitraryExistingThreadsQualified: false,
    outputTokenCap: "post-completion check; no hard native output cap",
    durableReceiptPath: receiptFile,
  };
  save({
    ...receipts.__proof,
    clientId: "__proof",
    validationPassed: true,
    proofReport,
  });
  console.log(JSON.stringify(proofReport, null, 2));
  child.stdin.write("ACK\n");
} finally {
  queue.close();
  fabric.close();
  child.kill();
}
