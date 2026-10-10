import { REMOTE_HOST, SSH_ALIAS } from "../app/remote-host.mjs";
import assert from "node:assert/strict";

/** Read only the two proof-owned native threads and three receipt-bound turns. */
export async function recoverOwnedNativeAnswers(queue, original) {
  const threads = original.__proof?.ownedThreads;
  assert.equal(original.__proof?.dispatchedCalls, 3);
  assert(Array.isArray(threads) && threads.length === 2);
  for (const proof of threads) {
    assert.equal(proof.host, REMOTE_HOST);
    assert.equal(proof.source, "owned-native-thread-start-response");
    assert.equal(proof.sandbox?.type, "readOnly");
    assert.equal(proof.sandbox?.networkAccess, false);
    assert(/^\/tmp\/agentspaces-nativequeue-[a-zA-Z0-9_-]+$/.test(proof.cwd));
  }
  const receipts = Object.values(original).filter((r) =>
    r.clientId?.startsWith("asproof_"),
  );
  assert.equal(receipts.length, 3);
  receipts.sort((a, b) => a.preparedAt.localeCompare(b.preparedAt));
  const order = ["native-A-1", "native-B-1", "native-A-2"];
  const expectedThread = [
    threads[0].nativeThreadId,
    threads[1].nativeThreadId,
    threads[0].nativeThreadId,
  ];
  const turnsByThread = new Map();
  for (const proof of threads) {
    const meta = await queue.request("thread/read", {
      threadId: proof.nativeThreadId,
      includeTurns: false,
    });
    assert.equal(meta.thread?.id, proof.nativeThreadId);
    assert.equal(meta.thread?.cwd, proof.cwd);
    const response = await queue.request("thread/turns/list", {
      threadId: proof.nativeThreadId,
      limit: 10,
      itemsView: "full",
    });
    turnsByThread.set(
      proof.nativeThreadId,
      response.data ?? response.turns ?? [],
    );
  }
  const answers = new Map();
  for (let i = 0; i < receipts.length; i++) {
    const receipt = receipts[i];
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.retryAllowed, false);
    assert.equal(receipt.nativeThreadId, expectedThread[i]);
    const turn = turnsByThread
      .get(receipt.nativeThreadId)
      .find((t) => t.id === receipt.nativeTurnId);
    assert(
      turn && turn.status === "completed",
      "Only the exact completed acknowledged native turn may be recovered",
    );
    assert(
      turn.items?.some(
        (item) =>
          item.type === "userMessage" && item.clientId === receipt.clientId,
      ),
      "Native user-message client ID must match the receipt",
    );
    const text = turn.items
      .filter((item) => item.type === "agentMessage")
      .map((item) => item.text ?? "")
      .join("\n");
    assert.equal(text.trim(), i === 1 ? "CEDAR" : "ORCHID");
    // Historical turn reads do not establish the live token notification; retain unknown unless durably captured.
    const usage = receipt.answer?.usage ?? {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      known: false,
    };
    answers.set(order[i], {
      provider: "codex",
      host: REMOTE_HOST,
      executionKind: "native-shared-daemon-queue-recovered",
      nativeThreadId: receipt.nativeThreadId,
      nativeTurnId: receipt.nativeTurnId,
      queuedSubmissionId: receipt.queuedSubmissionId,
      clientId: receipt.clientId,
      text,
      usage,
      receipt: { ...receipt },
      recovered: true,
      source: "exact completed turn read; no queue mutation",
    });
  }
  return { threads, answers };
}
