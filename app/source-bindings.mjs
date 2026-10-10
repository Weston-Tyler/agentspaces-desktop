import { REMOTE_HOST } from "./remote-host.mjs";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, lstatSync, existsSync, renameSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { assertUnlinkedParents } from "./native-connections.mjs";
import { scopePathExcluded, mapSessions } from "./workspace-map.mjs";
import { hostPaths, normalizeHostPath } from "./platform.mjs";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const hash = value => createHash("sha256").update(value).digest("hex");
const failure = code => Object.assign(new Error(code), { code });
export class SourceBindings {
  constructor(engine, { root, address, resolveMetadata = async () => null } = {}) {
    if (typeof root !== "string" || !isAbsolute(root) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(address ?? "") || !new URL(address).port || typeof resolveMetadata !== "function") throw failure("invalid_registration_configuration");
    Object.assign(this, { engine, root, address, resolveMetadata });
    engine.store.data.nativeRegistrationDevices ??= {};
    engine.store.data.nativeSourceBindings ??= {};
    this.pending = new Map();
  }
  profile() {
    const index = this.engine.workspace.index, profile = index?.profile;
    if (!profile?.active || index.fixture || profile.policy !== "local-retrieval") throw failure("native_registration_scope_unavailable");
    return profile;
  }
  issueDevice({ host, provider }) {
    const profile = this.profile();
    if (!["local", REMOTE_HOST].includes(host) || !["codex", "claude"].includes(provider) || !profile.hosts.includes(host) || !profile.providers.includes(provider)) throw failure("native_registration_device_scope_denied");
    const token = randomBytes(32).toString("hex");
    this.engine.store.data.nativeRegistrationDevices[hash(token)] = { host, provider, scopeId: profile.id, account: profile.account, role: "native-registration-only", at: new Date().toISOString() };
    this.engine.store.save();
    return { token, host, provider };
  }
  device(token) {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw failure("native_registration_device_denied");
    const device = this.engine.store.data.nativeRegistrationDevices[hash(token)], profile = this.profile();
    if (!device || device.role !== "native-registration-only" || device.scopeId !== profile.id || device.account !== profile.account || !profile.hosts.includes(device.host) || !profile.providers.includes(device.provider)) throw failure("native_registration_device_revoked");
    return { ...device };
  }
  register(token, input = {}) {
    const device = this.device(token);
    if (input.host !== undefined && input.host !== device.host || input.provider !== undefined && input.provider !== device.provider) return Promise.reject(failure("native_registration_device_identity_mismatch"));
    if (input.nativeThreadId !== undefined && !UUID.test(input.nativeThreadId) || input.nativeSessionId !== undefined && !UUID.test(input.nativeSessionId) || !input.nativeThreadId && !input.nativeSessionId) return Promise.reject(failure("source_pending"));
    const key = hash(JSON.stringify([hash(token), input.nativeThreadId ?? null, input.nativeSessionId ?? null, input.cwd ?? null]));
    if (this.pending.has(key)) return this.pending.get(key);
    const operation = this.bind(token, { nativeThreadId: input.nativeThreadId, nativeSessionId: input.nativeSessionId, cwd: input.cwd, nativeClientSupplied: true });
    this.pending.set(key, operation);
    return operation.finally(() => { if (this.pending.get(key) === operation) this.pending.delete(key); });
  }
  async bind(token, input) {
    const device = this.device(token), profile = this.profile();
    let source = input.nativeThreadId ? this.engine.catalog.find(source => !source.fixture && source.host === device.host && source.provider === device.provider && source.nativeThreadId === input.nativeThreadId) : null;
    if (!source || input.nativeSessionId && source.nativeSessionId !== input.nativeSessionId) {
      let observed;
      try { observed = await this.resolveMetadata({ host: device.host, provider: device.provider, nativeThreadId: input.nativeThreadId, nativeSessionId: input.nativeSessionId }); } catch { throw failure("source_pending"); }
      this.device(token); // The owner may revoke/change scope while observation runs.
      if (!observed || observed.nativeObserved !== true || !UUID.test(observed.nativeThreadId ?? "") || observed.host !== device.host || observed.provider !== device.provider || observed.fixture || input.nativeThreadId && observed.nativeThreadId !== input.nativeThreadId || input.nativeSessionId && observed.nativeSessionId !== input.nativeSessionId) throw failure("source_pending");
      if (observed.account !== undefined && observed.account !== profile.account) throw failure("native_registration_account_mismatch");
      source = { id: device.provider + "@" + device.host + ":" + observed.nativeThreadId, nativeThreadId: observed.nativeThreadId, nativeSessionId: observed.nativeSessionId ?? null,
        host: device.host, provider: device.provider, cwd: observed.cwd, account: profile.account, scopeId: profile.id, fixture: false,
        title: typeof observed.title === "string" ? observed.title.slice(0, 200) : "Native session", sourceVersion: String(observed.sourceVersion ?? "unknown").slice(0, 200), status: ["current", "dormant", "archived", "unknown"].includes(observed.status) ? observed.status : "unknown", topics: [],
        registrationProvenance: { nativeClientSupplied: true, metadataObserved: true, attribution: "locally bound; native caller not cryptographically verified" } };
      this.validateSource(source, device, profile, input.cwd, false);
      const overrides = this.engine.store.data.grants[source.id] ?? {};
      if (["enrolled", "content", "share", "retrieve"].some(key => overrides[key] === false)) throw failure("native_registration_source_revoked");
      this.engine.workspace.restore([source]);
      const index = this.engine.workspace.index;
      const sessions = [...index.sessions.filter(item => item.id !== source.id), source], sessionNodes = new Set(index.nodes.filter(node => node.kind === "session").map(node => node.id));
      const rebuilt = mapSessions({ ...index, nodes: index.nodes.filter(node => node.kind !== "session"), edges: index.edges.filter(edge => !sessionNodes.has(edge.from) && !sessionNodes.has(edge.to)) }, sessions);
      rebuilt.edges = [...new Map(rebuilt.edges.map(edge => [JSON.stringify(edge), edge])).values()];
      rebuilt.nativeRegistrationObservedAt = new Date().toISOString();
      this.engine.workspace.index = rebuilt; this.engine.workspace.save(); this.engine.store.save();
    }
    this.validateSource(source, device, this.profile(), input.cwd, true);
    const identity = { sessionId: source.id, nativeThreadId: source.nativeThreadId, host: source.host, provider: source.provider, cwd: normalizeHostPath(source.cwd, source.host), account: source.account, project: source.project, scopeId: source.scopeId };
    const key = hash(JSON.stringify([source.host, source.provider, source.nativeThreadId]));
    const folder = join(this.root, "native-connections", "auto-" + key), configPath = join(folder, "participant.json"), fingerprint = hash(JSON.stringify([identity, this.address]));
    assertUnlinkedParents(folder);
    const records = this.engine.store.data.nativeSourceBindings, old = records[key];
    if (old?.connectorKey && !this.engine.store.data.connectors[old.connectorKey]) throw failure("source_connector_revoked");
    if (old?.fingerprint === fingerprint) {
      if (!existsSync(configPath) || lstatSync(configPath).isSymbolicLink() || !lstatSync(configPath).isFile()) throw failure("native_registration_private_config_unavailable");
      let config; try { config = JSON.parse(readFileSync(configPath, "utf8")); } catch { throw failure("native_registration_private_config_changed"); }
      if (config.schema !== 1 || config.address !== this.address || config.authority !== new URL(this.address).host || typeof config.token !== "string" || config.nativeThreadId !== source.nativeThreadId || config.sessionId !== source.id || config.host !== source.host || config.provider !== source.provider || hash(config.token) !== old.connectorKey) throw failure("native_registration_private_config_changed");
      this.engine.connector(config.token);
      return this.result(config, configPath, true);
    }
    if (existsSync(configPath) && (lstatSync(configPath).isSymbolicLink() || !lstatSync(configPath).isFile())) throw failure("native_registration_private_config_linked");
    mkdirSync(folder, { recursive: true, mode: 0o700 }); assertUnlinkedParents(folder);
    const connector = this.engine.issueConnector(source.id);
    try {
      this.device(token); this.validateSource(this.engine.session(source.id), device, this.profile(), input.cwd, true);
      const config = { schema: 1, address: this.address, authority: new URL(this.address).host, token: connector.token, sessionId: source.id, nativeThreadId: source.nativeThreadId, host: source.host, provider: source.provider };
      const temp = join(folder, "participant-" + randomUUID() + ".tmp"); writeFileSync(temp, JSON.stringify(config), { flag: "wx", mode: 0o600 }); renameSync(temp, configPath);
      if (old?.connectorKey) delete this.engine.store.data.connectors[old.connectorKey];
      records[key] = { fingerprint, connectorKey: hash(connector.token), configPath, identity, provenance: { nativeClientSupplied: true, attribution: "locally bound; native caller not cryptographically verified" } };
      this.engine.store.save(); return this.result(config, configPath, false);
    } catch { delete this.engine.store.data.connectors[hash(connector.token)]; this.engine.store.save(); throw failure("native_registration_binding_failed"); }
  }
  validateSource(source, device, profile, suppliedCwd, requireGrants) {
    if (!source?.cwd || typeof source.cwd !== "string" || !hostPaths(device.host).isAbsolute(source.cwd)) throw failure("source_pending");
    if (source.host !== device.host || source.provider !== device.provider || source.account !== profile.account || source.scopeId !== profile.id || !profile.hosts.includes(source.host) || !profile.providers.includes(source.provider)) throw failure("native_registration_source_scope_denied");
    if (scopePathExcluded(source.cwd, source.host, profile.exclusions[device.host] ?? [])) throw failure("native_registration_source_excluded");
    if (suppliedCwd !== undefined && (typeof suppliedCwd !== "string" || normalizeHostPath(suppliedCwd, device.host) !== normalizeHostPath(source.cwd, device.host))) throw failure("native_registration_source_cwd_mismatch");
    if (requireGrants) { const grant = this.engine.permissions(this.engine.session(source.id)); if (!grant.enrolled || !grant.content || !grant.share || !grant.retrieve) throw failure("native_registration_source_revoked"); }
  }
  result(config, configPath, cached) { return { configPath, config, token: config.token, sessionId: config.sessionId, nativeThreadId: config.nativeThreadId, host: config.host, provider: config.provider, cached, attribution: "locally bound; native caller not cryptographically verified" }; }
}
