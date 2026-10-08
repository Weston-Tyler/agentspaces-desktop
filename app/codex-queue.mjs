import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import { posix } from "node:path";

const fail = (code, uncertainOutcome = false, receipt = null) =>
  Object.assign(new Error(code), { code, uncertainOutcome, receipt });
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function finiteNativePolicy(sandbox, approval, reviewer, fullAccessGranted = false) {
  if (!sandbox || typeof sandbox !== "object" || !["readOnly", "workspaceWrite", "dangerFullAccess"].includes(sandbox.type)) return false;
  if (sandbox.type === "dangerFullAccess" && !fullAccessGranted) return false;
  if (sandbox.networkAccess !== undefined && typeof sandbox.networkAccess !== "boolean") return false;
  if (sandbox.type === "workspaceWrite") {
    if (sandbox.writableRoots !== undefined && (!Array.isArray(sandbox.writableRoots) || sandbox.writableRoots.some(root => typeof root !== "string" || !posix.isAbsolute(root)))) return false;
    if (["excludeSlashTmp", "excludeTmpdirEnvVar"].some(key => sandbox[key] !== undefined && typeof sandbox[key] !== "boolean")) return false;
  }
  if (!["user", "auto_review", "guardian_subagent"].includes(reviewer)) return false;
  if (typeof approval === "string") return ["untrusted", "on-request", "never"].includes(approval);
  const granular = approval?.granular, required = ["mcp_elicitations", "rules", "sandbox_approval"], optional = ["request_permissions", "skill_approval"];
  return !!(granular && Object.keys(approval).length === 1 && required.every(key => typeof granular[key] === "boolean") && Object.entries(granular).every(([key, value]) => [...required, ...optional].includes(key) && typeof value === "boolean"));
}
export class CodexQueueAdapter {
  constructor({
    host = "remote",
    spawnProcess = spawn,
    persistReceipt,
    loadReceipt = async () => null,
    persistPermissionProof,
    loadPermissionProof = async () => null,
  } = {}) {
    if (host !== "remote") throw fail("shared_daemon_host_not_qualified");
    Object.assign(this, { host, spawnProcess, persistReceipt, loadReceipt, persistPermissionProof, loadPermissionProof });
    this.events = new EventEmitter();
    this.pending = new Map();
    this.proofs = new Map();
    this.inflight = new Set();
    this.bindingThreads = new Set();
    this.nextId = 1;
  }
  async open() {
    if (this.child) return;
    const { default: WebSocket } = await import("ws");
    this.child = this.spawnProcess(
      "ssh",
      ["remote", "codex app-server proxy"],
      { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stderr.on("data", () => {});
    const disconnected = () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(fail("native_proxy_disconnected", true));
      }
      this.pending.clear();
      this.events.emit("disconnect");
    };
    this.child.on("error", disconnected);
    this.child.on("close", disconnected);
    // The native proxy relays raw UDS bytes. Use the standard WebSocket library
    // over that duplex; standalone app-server --stdio has a different JSONL transport.
    const bridge = Duplex.from({
      readable: this.child.stdout,
      writable: this.child.stdin,
    });
    this.websocket = new WebSocket("ws://localhost/", {
      createConnection: () => bridge,
      handshakeTimeout: 8000,
      maxPayload: 1024 * 1024,
      perMessageDeflate: false,
    });
    this.websocket.on("error", disconnected);
    this.websocket.on("close", disconnected);
    this.websocket.on("message", (payload, isBinary) => {
      if (isBinary) {
        this.close();
        return;
      }
      let message;
      try {
        message = JSON.parse(payload.toString("utf8"));
      } catch {
        this.close();
        return;
      }
      if (message.id !== undefined && !message.method) {
        const request = this.pending.get(message.id);
        if (request) {
          this.pending.delete(message.id);
          clearTimeout(request.timer);
          message.error
            ? request.reject(fail("native_rpc_rejected", true))
            : request.resolve(message.result);
        }
      } else if (message.method && message.id !== undefined) {
        if (message.method.includes("requestApproval")) {
          const params = message.params ?? {};
          this.events.emit("native-attention", { host: this.host, kind: "approval-required", method: message.method, requestId: message.id,
            nativeThreadId: params.threadId ?? null, nativeTurnId: params.turnId ?? null, action: "declined; native owner attention required" });
        }
        const result = message.method.includes("requestApproval")
          ? { decision: "decline" }
          : undefined;
        this.send(
          result
            ? { id: message.id, result }
            : {
                id: message.id,
                error: {
                  code: -32601,
                  message: "Unsupported approval interaction",
                },
              },
        );
      } else this.events.emit("notification", message);
    });
    await new Promise((resolve, reject) => {
      this.websocket.once("open", resolve);
      this.websocket.once("error", () =>
        reject(fail("native_websocket_handshake_failed")),
      );
      this.websocket.once("close", () =>
        reject(fail("native_proxy_disconnected")),
      );
    });
    const result = await this.request("initialize", {
      clientInfo: {
        name: "agentspaces_desktop_queue",
        title: "AgentSpaces Desktop",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized", params: {} });
    return result;
  }
  send(message) {
    if (this.websocket?.readyState !== 1)
      throw fail("native_websocket_not_ready");
    this.websocket.send(JSON.stringify(message));
  }
  request(method, params, timeoutMs = 8000) {
    if (!this.child) return Promise.reject(fail("native_proxy_not_connected"));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(fail("native_rpc_timeout", true));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(fail("native_proxy_disconnected", true));
      }
    });
  }
  close() {
    this.websocket?.terminate();
    this.child?.kill?.("SIGTERM");
    this.child = null;
  }
  async createOwnedThread({ cwd, grant, ownedScratch, model } = {}) {
    if (
      grant !== true ||
      ownedScratch !== true ||
      typeof cwd !== "string" ||
      !/^\/tmp\/agentspaces-[a-zA-Z0-9_-]+$/.test(cwd)
    )
      throw fail("owned_scratch_and_creation_grant_required");
    const config = { web_search: "disabled", mcp_servers: {} };
    for (const feature of [
      "hooks",
      "shell_tool",
      "unified_exec",
      "apps",
      "plugins",
      "browser_use",
      "computer_use",
      "image_generation",
      "view_image",
      "shell_snapshot",
      "skill_mcp_dependency_install",
    ])
      config["features." + feature] = false;
    const result = await this.request("thread/start", {
      cwd,
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: false,
      config,
      ...(model ? { model } : {}),
      developerInstructions:
        "Answer only from the supplied question and evidence. Never use tools, modify files, contact agents, or request escalations. Keep replies short.",
      serviceName: "agentspaces_desktop_owned_queue_proof",
    });
    const id = result.thread?.id;
    if (
      !id ||
      result.sandbox?.type !== "readOnly" ||
      result.sandbox.networkAccess === true ||
      result.cwd !== cwd ||
      result.approvalPolicy !== "never"
    )
      throw fail("native_readonly_permission_not_verified");
    const proof = {
      nativeThreadId: id,
      host: this.host,
      cwd,
      sandbox: result.sandbox,
      approvalPolicy: result.approvalPolicy,
      activePermissionProfile: result.activePermissionProfile ?? null,
      verifiedAt: new Date().toISOString(),
      source: "owned-native-thread-start-response",
    };
    this.proofs.set(id, proof);
    return {
      nativeThreadId: id,
      permissionProof: proof,
      limitations: [
        "Proof covers this owned session; arbitrary existing thread permission profiles are not exposed by metadata reads",
        "No hard native output-token cap",
        "Managed native configuration remains authoritative",
      ],
    };
  }
  async bindExistingThread({ threadId, cwd, grant } = {}) {
    const executionGranted = grant === true || grant?.execution === true;
    const fullAccessGranted = grant?.execution === true && grant.allowFullAccess === true;
    if (!executionGranted || !UUID.test(threadId ?? "") || typeof cwd !== "string" || !posix.isAbsolute(cwd) || cwd.includes("\0")) throw fail("existing_thread_identity_and_execution_grant_required");
    if (this.bindingThreads.has(threadId)) throw fail("existing_thread_bind_inflight");
    this.bindingThreads.add(threadId);
    try {
      const response = await this.request("thread/read", { threadId, includeTurns: false });
      const before = response.thread;
      if (!before || before.id !== threadId || before.cwd !== cwd) throw fail("native_existing_thread_identity_mismatch");
      if (!before.status || !["idle", "notLoaded"].includes(before.status.type)) throw fail("native_existing_thread_busy_or_unavailable");
      if (before.canAcceptDirectInput === false || before.ephemeral) throw fail("native_existing_thread_cannot_accept_input");
      // A native cold resume may dispatch its prior queue. Binding must not
      // activate unrelated messages before this exact targeted request exists.
      const queued = await this.request("thread/queue/list", { threadId, limit: 1 });
      if (!Array.isArray(queued.data) || queued.data.length || queued.nextCursor) throw fail("native_existing_thread_pending_queue");
      const resumed = await this.request("thread/resume", { threadId });
      const after = resumed.thread;
      if (!after || after.id !== threadId || after.cwd !== cwd || resumed.cwd !== cwd || after.status?.type !== "idle" || after.ephemeral || after.canAcceptDirectInput === false) throw fail("native_existing_thread_resume_not_eligible");
      if (!finiteNativePolicy(resumed.sandbox, resumed.approvalPolicy, resumed.approvalsReviewer, fullAccessGranted)) throw fail("native_existing_permission_policy_not_qualified");
      const proof = { nativeThreadId: threadId, host: this.host, cwd, sandbox: structuredClone(resumed.sandbox), approvalPolicy: structuredClone(resumed.approvalPolicy), approvalsReviewer: resumed.approvalsReviewer,
        activePermissionProfile: resumed.activePermissionProfile ?? null, fullAccessGranted, verifiedAt: new Date().toISOString(), source: "existing-native-thread-resume-response" };
      if (this.persistPermissionProof) await this.persistPermissionProof(structuredClone(proof));
      this.proofs.set(threadId, proof);
      return { nativeThreadId: threadId, permissionProof: proof, limitations: ["Native configuration and approvals preserved; no policy overrides", "Native tools follow preserved policy; approval escalations are declined and report owner attention", "Persisted permission evidence requires explicit rebind after restart", "Output token ceiling is checked after completion"] };
    } finally { this.bindingThreads.delete(threadId); }
  }
  async eligible(threadId) {
    const response = await this.request("thread/read", {
      threadId,
      includeTurns: false,
    });
    const thread = response.thread;
    if (!thread || thread.id !== threadId)
      return { eligible: false, reason: "native_thread_mismatch" };
    if (thread.status?.type === "notLoaded" || !thread.status)
      return {
        eligible: false,
        reason: "cold_thread_requires_native_owner_resume",
      };
    let proof = this.proofs.get(threadId);
    if (!proof) {
      const saved = await this.loadPermissionProof(threadId);
      if (saved?.nativeThreadId === threadId && saved.host === this.host && saved.source === "existing-native-thread-resume-response") {
        proof = { ...saved, requiresRebind: true }; this.proofs.set(threadId, proof);
      }
    }
    if (!proof)
      return {
        eligible: false,
        reason: "native_readonly_permission_not_verified",
      };
    if (proof.requiresRebind) return { eligible: false, reason: "native_permission_proof_requires_rebind" };
    if (proof.host !== this.host || proof.nativeThreadId !== threadId) return { eligible: false, reason: "native_permission_proof_identity_mismatch" };
    if (proof.source === "existing-native-thread-resume-response" && !finiteNativePolicy(proof.sandbox, proof.approvalPolicy, proof.approvalsReviewer, proof.fullAccessGranted === true)) return { eligible: false, reason: "native_existing_permission_policy_not_qualified" };
    if (
      thread.cwd !== proof.cwd ||
      thread.ephemeral ||
      thread.canAcceptDirectInput === false
    )
      return { eligible: false, reason: "native_thread_not_eligible" };
    return {
      eligible: true,
      nativeThreadId: threadId,
      status: thread.status.type,
      permissionProof: proof,
    };
  }
  async reconcile({ threadId, clientId, grant } = {}) {
    if (grant !== true || !this.proofs.has(threadId))
      throw fail("reconciliation_grant_and_permission_proof_required");
    const queue = await this.request("thread/queue/list", {
      threadId,
      limit: 100,
    });
    const pending = queue.data?.find(
      (item) => item.clientUserMessageId === clientId,
    );
    if (pending)
      return {
        status: "queued",
        nativeThreadId: threadId,
        clientId,
        queuedSubmissionId: pending.id,
      };
    const turns = await this.request("thread/turns/list", {
      threadId,
      limit: 100,
      itemsView: "full",
    });
    const turn = (turns.data ?? turns.turns ?? []).find((t) =>
      t.items?.some(
        (item) => item.type === "userMessage" && item.clientId === clientId,
      ),
    );
    if (!turn)
      return {
        status: "uncertain",
        nativeThreadId: threadId,
        clientId,
        retryAllowed: false,
      };
    return {
      status: turn.status,
      nativeThreadId: threadId,
      nativeTurnId: turn.id,
      clientId,
      retryAllowed: false,
    };
  }
  async answer(args = {}) {
    if (this.inflight.has(args.clientId))
      throw fail("request_already_inflight");
    this.inflight.add(args.clientId);
    try {
      return await this.executeAnswer(args);
    } finally {
      this.inflight.delete(args.clientId);
    }
  }
  async executeAnswer({
    threadId,
    clientId,
    question,
    grant,
    budget,
    signal,
    dispatchFence,
  } = {}) {
    if (dispatchFence !== undefined && typeof dispatchFence !== "function") throw fail("invalid_dispatch_fence");
    if (grant !== true || typeof this.persistReceipt !== "function")
      throw fail("execution_grant_and_durable_receipt_required");
    if (
      !Number.isInteger(budget?.timeoutMs) ||
      budget.timeoutMs <= 0 ||
      budget.timeoutMs > 90000 ||
      !Number.isInteger(budget?.maxOutputTokens) ||
      budget.maxOutputTokens <= 0 ||
      budget.maxOutputTokens > 800
    )
      throw fail("invalid_queue_budget");
    if (
      typeof question !== "string" ||
      !question.trim() ||
      question.length > 12000 ||
      typeof clientId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(clientId)
    )
      throw fail("invalid_queue_question_or_client_id");
    if (signal?.aborted) throw fail("cancelled");
    const existing = await this.loadReceipt(clientId);
    if (existing)
      throw fail(
        "receipt_exists_reconcile_without_retry",
        !["completed", "not-dispatched"].includes(existing.status),
        existing,
      );
    const eligible = await this.eligible(threadId);
    if (!eligible.eligible) throw fail(eligible.reason);
    const receipt = {
      clientId,
      nativeThreadId: threadId,
      host: this.host,
      status: "prepared",
      queuedSubmissionId: null,
      nativeTurnId: null,
      retryAllowed: false,
      preparedAt: new Date().toISOString(),
      permissionProof: structuredClone(eligible.permissionProof),
    };
    await this.persistReceipt({ ...receipt }); // Durable allocation before any queue mutation.
    const checkDispatchFence = async persist => {
      if (!dispatchFence) return;
      let allowed = false;
      try { allowed = (await dispatchFence()) !== false; } catch { /* Source grant details stay private. */ }
      if (allowed) return;
      receipt.status = "not-dispatched"; receipt.undispatched = true; receipt.retryAllowed = false;
      try { await persist(); } catch { throw fail("receipt_persistence_failed", false, { ...receipt }); }
      throw fail("native_dispatch_grant_revoked", false, { ...receipt });
    };
    await checkDispatchFence(() => this.persistReceipt({ ...receipt }));
    let usage = {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        known: false,
      },
      text = "",
      timer,
      settled = false,
      stopping = false;
    let saveTail = Promise.resolve();
    const save = () => {
      const copy = { ...receipt };
      saveTail = saveTail.then(() => this.persistReceipt(copy));
      return saveTail;
    };
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        this.events.off("notification", notification);
        this.events.off("disconnect", disconnect);
      };
      const finish = async (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          await saveTail;
        } catch {
          error = fail("receipt_persistence_failed", receipt.undispatched !== true, { ...receipt });
        }
        if (error) reject(error);
        else
          resolve({
            provider: "codex",
            host: this.host,
            executionKind: "native-shared-daemon-queue",
            nativeThreadId: threadId,
            nativeTurnId: receipt.nativeTurnId,
            queuedSubmissionId: receipt.queuedSubmissionId,
            clientId,
            text,
            usage,
            receipt: { ...receipt },
            limitations: [
              "Output token ceiling is post-completion checked",
              "Native source session owns configuration and approval rules",
            ],
          });
      };
      const stop = async (code) => {
        if (settled || stopping) return;
        stopping = true;
        let cancelled = false;
        try {
          if (receipt.nativeTurnId) {
            await this.request("turn/interrupt", {
              threadId,
              turnId: receipt.nativeTurnId,
            });
            cancelled = true;
          } else {
            const list = await this.request("thread/queue/list", {
              threadId,
              limit: 100,
            });
            const items =
              list.data?.filter(
                (item) => item.clientUserMessageId === clientId,
              ) ?? [];
            for (const item of items) {
              const result = await this.request("thread/queue/delete", {
                threadId,
                queuedSubmissionId: item.id,
              });
              cancelled ||= result.deleted === true;
            }
            if (!cancelled) {
              const history = await this.request("thread/turns/list", {
                threadId,
                limit: 100,
                itemsView: "full",
              });
              const turn = (history.data ?? history.turns ?? []).find((t) =>
                t.items?.some(
                  (item) =>
                    item.type === "userMessage" && item.clientId === clientId,
                ),
              );
              if (turn?.status === "inProgress") {
                receipt.nativeTurnId = turn.id;
                await this.request("turn/interrupt", {
                  threadId,
                  turnId: turn.id,
                });
                cancelled = true;
              }
            }
          }
        } catch {
          /* Preserve uncertainty if native cancellation cannot be acknowledged. */
        }
        receipt.status = cancelled ? "cancellation-requested" : "uncertain";
        await save().catch(() => {});
        await finish(fail(code, true, { ...receipt }));
      };
      const cancel = () => {
        void stop("cancelled");
      };
      const disconnect = () => {
        receipt.status = "uncertain";
        void save().then(
          () => finish(fail("native_proxy_disconnected", true, { ...receipt })),
          () =>
            finish(fail("receipt_persistence_failed", true, { ...receipt })),
        );
      };
      const notification = (event) => {
        const p = event.params ?? {};
        if (p.threadId !== threadId || settled || stopping) return;
        const item = p.item;
        if (item?.type === "userMessage" && item.clientId === clientId) {
          receipt.nativeTurnId = p.turnId;
          receipt.status = "running";
          void save().catch(() => stop("receipt_persistence_failed"));
        }
        if (
          !receipt.nativeTurnId ||
          (p.turnId ?? p.turn?.id) !== receipt.nativeTurnId
        )
          return;
        if (event.method === "thread/tokenUsage/updated") {
          const u = p.tokenUsage?.last;
          if (
            u &&
            Number.isFinite(u.inputTokens) &&
            Number.isFinite(u.outputTokens)
          )
            usage = {
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              totalTokens: u.totalTokens ?? u.inputTokens + u.outputTokens,
              known: true,
            };
        }
        if (
          eligible.permissionProof.source !== "existing-native-thread-resume-response" &&
          item &&
          [
            "commandExecution",
            "mcpToolCall",
            "fileChange",
            "webSearch",
          ].includes(item.type)
        ) {
          void stop("unexpected_native_tool_execution");
          return;
        }
        if (event.method === "item/completed" && item?.type === "agentMessage")
          text += (text ? "\n" : "") + (item.text ?? "");
        if (text.length > 16000) {
          void stop("native_answer_output_limit");
          return;
        }
        if (event.method === "turn/completed") {
          receipt.status =
            p.turn.status === "completed" ? "completed" : "failed";
          if (!text)
            text =
              p.turn.items
                ?.filter((item) => item.type === "agentMessage")
                .map((item) => item.text)
                .join("\n") ?? "";
          const error =
            receipt.status !== "completed" || !text
              ? fail("native_queue_turn_failed", true, { ...receipt })
              : usage.known && usage.outputTokens > budget.maxOutputTokens
                ? fail("native_queue_token_budget_exceeded", true, {
                    ...receipt,
                  })
                : null;
          void save().then(
            () => finish(error),
            () =>
              finish(fail("receipt_persistence_failed", true, { ...receipt })),
          );
        }
      };
      this.events.on("notification", notification);
      this.events.on("disconnect", disconnect);
      signal?.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => {
        void stop("native_queue_timeout");
      }, budget.timeoutMs);
      receipt.status = "dispatching";
      void save().then(
        async () => {
          if (settled || signal?.aborted) return;
          try {
            await checkDispatchFence(save);
            const response = await this.request("thread/queue/add", {
              threadId,
              clientUserMessageId: clientId,
              input: [
                {
                  type: "text",
                  text:
                    question +
                    "\nReply within " +
                    budget.maxOutputTokens +
                    " tokens." + (eligible.permissionProof.source === "existing-native-thread-resume-response" ? "" : " Do not use tools."),
                },
              ],
            });
            receipt.queuedSubmissionId = response.queuedSubmission?.id ?? null;
            if (!receipt.nativeTurnId && !settled) receipt.status = "queued";
            await save();
          } catch (error) {
            if (error.code === "native_dispatch_grant_revoked" || receipt.undispatched === true) { await finish(error); return; }
            if (!settled) {
              receipt.status = "uncertain";
              await save().catch(() => {});
              await stop("native_queue_ack_uncertain");
            }
          }
        },
        () => finish(fail("receipt_persistence_failed", false, { ...receipt })),
      );
    });
  }
}
