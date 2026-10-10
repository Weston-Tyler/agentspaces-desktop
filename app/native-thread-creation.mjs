import { REMOTE_HOST } from "./remote-host.mjs";
import { createHash } from "node:crypto";
import { CodexReadAdapter } from "./native.mjs";
import { CodexQueueAdapter } from "./codex-queue.mjs";
import { hostPaths, normalizeHostPath } from "./platform.mjs";
import { scopePathExcluded } from "./workspace-map.mjs";
import { nativeAdapterCompatible } from "./native-versions.mjs";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code, receipt = null) => Object.assign(new Error(code), { code, receipt });
const pendingByEngine = new WeakMap();
function bounded(operation, milliseconds, code) {
  let timer;
  return Promise.race([Promise.resolve(operation), new Promise((_, reject) => {
    timer = setTimeout(() => reject(fail(code)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
const defaultAdapter = ({ host }) => host === REMOTE_HOST
  ? new CodexQueueAdapter({ host })
  : new CodexReadAdapter({ host, enableThreadCreation: true });

// Receipts describe a native side effect. They are neither a work registry nor
// a scheduler, and never authorize a native turn, resume, queue or model call.
export class NativeThreadCreation {
  constructor(engine, { adapterFactory = defaultAdapter, registerSource } = {}) {
    if (typeof adapterFactory !== "function" || registerSource !== undefined && typeof registerSource !== "function") throw fail("invalid_native_thread_creation_configuration");
    Object.assign(this, { engine, adapterFactory, registerSource });
    engine.store.data.nativeThreadCreationReceipts ??= {};
    if (!pendingByEngine.has(engine)) pendingByEngine.set(engine, new Map());
    this.pending = pendingByEngine.get(engine);
  }
  authorize(binding, { host, cwd } = {}) {
    const caller = this.engine.discussions.participant(binding), grant = this.engine.permissions(caller);
    const index = this.engine.workspace.index, profile = index?.profile;
    if (!grant.content || !UUID.test(caller.nativeThreadId ?? "")) throw fail("native_thread_creation_source_denied");
    if (!profile?.active || index.fixture || profile.policy !== "local-retrieval" || caller.scopeId !== profile.id || caller.account !== profile.account) throw fail("native_thread_creation_scope_unavailable");
    const targetHost = host ?? caller.host;
    if (!["local", REMOTE_HOST].includes(targetHost) || !profile.hosts.includes(targetHost) || !profile.providers.includes("codex")) throw fail("native_thread_creation_target_denied");
    if (targetHost !== caller.host && cwd === undefined) throw fail("native_thread_creation_cross_host_cwd_required");
    const targetCwd = cwd ?? caller.cwd;
    if (typeof targetCwd !== "string" || !targetCwd || targetCwd.length > 4096 || /[\x00-\x1f\x7f]/.test(targetCwd) || !hostPaths(targetHost).isAbsolute(targetCwd)) throw fail("native_thread_creation_absolute_cwd_required");
    if (scopePathExcluded(targetCwd, targetHost, profile.exclusions?.[targetHost] ?? [])) throw fail("native_thread_creation_target_excluded");
    const tool = this.engine.tools.find(tool => tool.host === targetHost && tool.provider === "codex");
    if (!tool?.installed || !nativeAdapterCompatible(tool)) throw fail("native_thread_creation_host_capability_unavailable");
    return { caller, host: targetHost, cwd: hostPaths(targetHost).normalize(targetCwd), identity: {
      sessionId: caller.id, nativeThreadId: caller.nativeThreadId, provider: caller.provider, host: caller.host,
      account: caller.account, project: caller.project, scopeId: caller.scopeId,
    } };
  }
  async create(input = {}, binding) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["title", "deliveryId", "host", "cwd"].includes(key)) || typeof input.title !== "string" || !input.title.trim() || input.title.length > 200 || /[\x00-\x1f\x7f]/.test(input.title) || !/^[a-zA-Z0-9-]{8,100}$/.test(input.deliveryId ?? "")) throw fail("native_thread_creation_bounded_request_required");
    const target = this.authorize(binding, input), title = input.title.trim();
    const signature = hash({ title, host: target.host, cwd: normalizeHostPath(target.cwd, target.host), identity: target.identity });
    const key = hash(input.deliveryId), receipts = this.engine.store.data.nativeThreadCreationReceipts;
    let receipt = receipts[key];
    if (receipt) {
      if (receipt.sourceId !== target.caller.id) throw fail("native_thread_creation_delivery_id_owned_by_another_source");
      if (receipt.fingerprint !== signature) throw fail("native_thread_creation_delivery_id_conflict");
      if (this.pending.has(key)) return this.pending.get(key);
      if (UUID.test(receipt.nativeThreadId ?? "")) return this.result(receipt, true);
      if (receipt.state !== "prepared") throw fail("native_thread_creation_acceptance_unknown_no_retry", this.result(receipt, true));
    } else {
      receipt = receipts[key] = { sourceId: target.caller.id, deliveryId: input.deliveryId, fingerprint: signature,
        host: target.host, cwd: target.cwd, title, identity: target.identity, state: "prepared",
        at: new Date().toISOString(), naming: "pending", registration: "pending" };
      this.engine.store.save();
    }
    const operation = this.perform(receipt, target, binding);
    this.pending.set(key, operation);
    try { return await operation; }
    finally { if (this.pending.get(key) === operation) this.pending.delete(key); }
  }
  assertCurrent(receipt, binding) {
    const target = this.authorize(binding, receipt);
    if (hash({ title: receipt.title, host: target.host, cwd: normalizeHostPath(target.cwd, target.host), identity: target.identity }) !== receipt.fingerprint) throw fail("native_thread_creation_source_changed");
  }
  async perform(receipt, target, binding) {
    let adapter;
    try {
      adapter = this.adapterFactory({ host: target.host, provider: "codex" });
      await bounded(adapter.open(), 20000, "native_thread_creation_transport_open_timeout");
      this.assertCurrent(receipt, binding);
      // Persist before transmitting. A restart or timeout from this point is an
      // unknown acceptance, even if no native UUID has reached this process.
      receipt.state = "dispatching";
      this.engine.store.save();
      const response = await bounded(target.host === REMOTE_HOST
        ? adapter.request("thread/start", { cwd: target.cwd, ephemeral: false }, 8000)
        : adapter.createEmptyThread(target.cwd), 12000, "native_thread_creation_request_timeout");
      const id = response?.thread?.id;
      if (!UUID.test(id ?? "")) throw fail("native_thread_creation_response_unknown");
      // Record known identity before naming or registration can fail. Never
      // recreate a known native thread to repair metadata.
      receipt.nativeThreadId = id;
      receipt.state = "created";
      receipt.createdAt = new Date().toISOString();
      this.engine.store.save();
      const observedCwd = response?.thread?.cwd ?? response?.cwd;
      if (observedCwd !== undefined && (typeof observedCwd !== "string" || normalizeHostPath(observedCwd, target.host) !== normalizeHostPath(target.cwd, target.host))) {
        receipt.metadataError = "native_thread_creation_returned_cwd_mismatch";
        receipt.naming = receipt.registration = "blocked";
        this.engine.store.save();
        return this.result(receipt, false);
      }
      try {
        this.assertCurrent(receipt, binding);
        await bounded(target.host === REMOTE_HOST
          ? adapter.request("thread/name/set", { threadId: id, name: receipt.title }, 8000)
          : adapter.setThreadName(id, receipt.title), 12000, "native_thread_creation_naming_timeout");
        receipt.naming = "named";
      } catch { receipt.naming = "failed"; }
      try {
        this.assertCurrent(receipt, binding);
        if (this.registerSource) {
          const registration = await bounded(this.registerSource({ nativeThreadId: id, host: target.host,
            provider: "codex", cwd: target.cwd, title: receipt.title }), 12000, "native_thread_creation_registration_timeout");
          receipt.registration = "registered";
          receipt.sessionId = typeof registration?.sessionId === "string" ? registration.sessionId : "codex@" + target.host + ":" + id;
        } else receipt.registration = "unavailable";
      } catch { receipt.registration = "failed"; }
      this.engine.store.save();
      return this.result(receipt, false);
    } catch {
      if (receipt.nativeThreadId) {
        // Even persistence or transport cleanup failure cannot erase a known ID.
        receipt.metadataError ??= "native_thread_creation_metadata_incomplete";
        try { this.engine.store.save(); } catch {}
        return this.result(receipt, false);
      }
      if (receipt.state === "dispatching") {
        receipt.state = "uncertain";
        try { this.engine.store.save(); } catch {}
        throw fail("native_thread_creation_acceptance_unknown_no_retry", this.result(receipt, false));
      }
      // Opening/validation failed before thread/start. A prepared receipt has no
      // native effect and can be safely retried with the exact same request.
      throw fail("native_thread_creation_transport_or_scope_unavailable", this.result(receipt, false));
    } finally {
      if (adapter) {
        try { await bounded(adapter.close(), 1500, "native_thread_creation_transport_close_timeout"); } catch {}
      }
    }
  }
  result(receipt, cached) {
    return { deliveryId: receipt.deliveryId, sourceId: receipt.sourceId, provider: "codex", host: receipt.host,
      cwd: receipt.cwd, title: receipt.title, nativeThreadId: receipt.nativeThreadId ?? null,
      sessionId: receipt.sessionId ?? null, state: receipt.state, naming: receipt.naming,
      registration: receipt.registration, ...(receipt.metadataError ? { metadataError: receipt.metadataError } : {}),
      cached, modelCalls: 0, turnStarted: false };
  }
}
