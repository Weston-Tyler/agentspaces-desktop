import { createHash, randomBytes } from "node:crypto";
import { isAbsolute, resolve, posix } from "node:path";
import { sampleSessions, sampleFindings } from "./fixtures.mjs";
import { detectTools, CodexReadAdapter } from "./native.mjs";
import { usageSummary } from "./usage.mjs";
import { TYPES } from "./fabric.mjs";
import { ClaudeReadAdapter } from "./claude-adapter.mjs";
import { WorkspaceMap } from "./workspace-map.mjs";
import { Discussions } from "./discussions.mjs";
import { hostOS } from "./platform.mjs";
import { Ask } from "./ask.mjs";
const hash = (s) => createHash("sha256").update(s).digest("hex");
export class Engine {
  constructor(
    store,
    fabric,
    {
      clock = Date.now,
      answerFactory,
      nativeFactory = (context) =>
        context.provider === "claude"
          ? new ClaudeReadAdapter(context)
          : new CodexReadAdapter(context),
    } = {},
  ) {
    this.store = store;
    this.fabric = fabric;
    this.clock = clock;
    this.nativeFactory = nativeFactory;
    this.catalog = [];
    this.cache = new Map();
    this.mode = "empty";
    this.modelCalls = 0;
    this.tools = [];
    this.fabricProject = null;
    this.published = store.data.published ?? {};
    this.workspace = new WorkspaceMap(this);
    this.discussions = new Discussions(this);
    this.ask = new Ask(this, { answerFactory });
  }
  async initialize() {
    this.tools = await detectTools();
  }
  async probe(host) {
    const tools = await detectTools(host);
    this.tools = this.tools
      .filter((t) => (t.host ?? "local") !== host)
      .concat(tools);
    this.store.audit("Native tool versions detected", { host });
    return tools;
  }
  target(session) {
    const project = this.project(session.project);
    return (
      project.targets?.[(session.host ?? "local") + ":" + session.provider] ??
      project
    );
  }
  loadSample() {
    this.mode = "fixture";
    this.catalog = structuredClone(sampleSessions);
    this.store.data.projects["sample-research"] = {
      id: "sample-research",
      account: "sample-private",
      path: "sample://research",
      metadataGrant: true,
      fixture: true,
    };
    this.store.audit("Sample workspace loaded", { fixture: true });
    return this.snapshot();
  }
  project(id) {
    const p = this.store.data.projects[id];
    if (!p || !p.metadataGrant)
      throw new Error("Project metadata discovery is not granted");
    return p;
  }
  session(id) {
    const s = this.catalog.find((s) => s.id === id);
    if (!s) throw new Error("Unknown session; discover metadata first");
    this.project(s.project);
    if (s.scopeId && !this.workspace.sessionAllowed(s))
      throw new Error("Workspace scope no longer permits this session");
    return s;
  }
  permissions(s) {
    if (s.scopeId && !this.workspace.sessionAllowed(s)) return {};
    return {
      ...this.workspace.grantFor(s),
      ...(this.store.data.grants[s.id] ?? {}),
    };
  }
  grant(id, changes) {
    const s = this.session(id);
    const old = this.permissions(s);
    const allowed = ["enrolled", "content", "share", "retrieve"];
    const next = { ...old };
    for (const key of allowed)
      if (key in changes) {
        if (typeof changes[key] !== "boolean")
          throw new Error("Invalid permission");
        next[key] = changes[key];
      }
    if (changes.enrolled === false) {
      next.content = false;
      next.share = false;
      next.retrieve = false;
    }
    if ((next.content || next.share || next.retrieve) && !next.enrolled)
      throw new Error("Enroll this session before granting content access");
    const stored = { ...(this.store.data.grants[id] ?? {}), ...changes };
    if (changes.enrolled === false) {
      stored.content = false;
      stored.share = false;
      stored.retrieve = false;
    }
    if (changes.content === false) stored.share = false;
    this.store.data.grants[id] = s.scopeId ? stored : next;
    if (!next.enrolled || !next.content) {
      this.cache.delete(id);
      this.store.data.grants[id].share = false;
    }
    this.store.audit("Session permissions changed", {
      sessionId: id,
      fixture: !!s.fixture,
      permissions: next,
    });
    return next;
  }
  discover({
    query = "",
    provider = "all",
    status = "all",
    project = "sample-research",
    scopeId = null,
    limit = 100,
  } = {}) {
    const p = project === "all" ? null : this.project(project);
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    return this.catalog
      .filter(
        (s) =>
          (project === "all" || s.project === project) &&
          (!p || s.account === p.account) &&
          (!scopeId || s.scopeId === scopeId) &&
          (!s.scopeId || this.workspace.sessionAllowed(s)) &&
          (provider === "all" || s.provider === provider) &&
          (status === "all" || s.status === status),
      )
      .map((s) => {
        const text = [s.title, ...s.topics].join(" ").toLowerCase();
        return {
          ...s,
          score: words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0),
          grants: this.permissions(s),
        };
      })
      .filter((s) => !words.length || s.score > 0)
      .sort(
        (a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt),
      )
      .slice(0, Math.max(1, Math.min(Number(limit) || 100, 200)));
  }
  async finding(id) {
    const s = this.session(id),
      g = this.permissions(s);
    if (!g.enrolled || !g.content)
      throw new Error("Explicit source content grant required");
    let value = this.cache.get(id);
    if (!value) {
      if (s.fixture) {
        value = sampleFindings[id];
        if (!value)
          throw new Error("No sample finding attached to this session");
      } else {
        if (s.scopeId && !s.cwd)
          throw new Error(
            "Native working directory is missing; metadata retained, content lookup not qualified",
          );
        const adapter = this.nativeFactory({
          host: s.host ?? "local",
          provider: s.provider,
        });
        try {
          await adapter.open();
          value = await adapter.read(s, this.target(s));
        } finally {
          adapter.close();
        }
      }
      if (
        !value ||
        typeof value.summary !== "string" ||
        Buffer.byteLength(value.artifact?.text ?? "") > 16384
      )
        throw new Error("Finding exceeds the bounded artifact contract");
      value = {
        ...structuredClone(value),
        source: {
          threadId: s.nativeThreadId ?? s.id,
          participantId: s.id,
          host: s.host ?? "sample-local",
          provider: s.provider,
          account: s.account,
          project: s.project,
          version: value.sourceVersion,
        },
        fixture: !!s.fixture,
      };
      value.artifact = {
        ...value.artifact,
        digest: hash(value.artifact.text),
        bytes: Buffer.byteLength(value.artifact.text),
      };
      this.cache.set(id, value);
    }
    if (Date.parse(value.expiresAt) <= this.clock())
      throw new Error("Stale context; refresh under the source grant");
    return value;
  }
  async retrieve({ sourceId, requesterId }) {
    const source = this.session(sourceId),
      target = this.session(requesterId),
      sg = this.permissions(source),
      tg = this.permissions(target);
    if (
      !sg.enrolled ||
      !sg.content ||
      !sg.share ||
      !tg.enrolled ||
      !tg.retrieve
    )
      throw new Error("Source sharing and requester retrieval grants required");
    const broad =
      source.scopeId &&
      source.scopeId === target.scopeId &&
      this.workspace.index?.profile?.policy === "local-retrieval" &&
      this.workspace.sessionAllowed(source) &&
      this.workspace.sessionAllowed(target);
    if (
      (!broad && source.project !== target.project) ||
      source.account !== target.account
    )
      throw new Error("Account or project boundary denied");
    let f = await this.finding(sourceId);
    let viaFabric = false;
    const publication = this.published[sourceId];
    if (publication) {
      if (
        this.fabric.status !== "connected" ||
        this.fabricProject !== source.project ||
        publication.groupId !== this.fabric.peer.group
      )
        throw new Error(
          "Published source requires its original fabric connection",
        );
      const record = this.fabric
        .read("desktop-fixture-context", TYPES.finding)
        .find(
          (r) =>
            r.entryId === publication.entryId &&
            r.issuer === publication.issuer,
        );
      if (!record)
        throw new Error(
          "Signed finding not yet observed; refresh without republishing",
        );
      f = record.value;
      if (
        !f?.source ||
        f.source.threadId !== sourceId ||
        f.source.version !== publication.version ||
        f.source.project !== source.project ||
        f.source.account !== source.account ||
        Date.parse(f.expiresAt) <= this.clock()
      )
        throw new Error("Fabric provenance or freshness mismatch");
      this.fabric.participant(requesterId);
      viaFabric = true;
    }
    if (hash(f.artifact.text) !== f.artifact.digest)
      throw new Error("Artifact digest mismatch");
    this.store.audit("Finding retrieved", {
      sourceId,
      requesterId,
      fixture: !!f.fixture,
      artifactDigest: f.artifact.digest,
      modelCalls: 0,
      viaFabric,
    });
    return {
      ...f,
      handoff: {
        requesterId,
        relation:
          source.provider === target.provider ? "same-tool" : "cross-tool",
        retrievedAt: new Date(this.clock()).toISOString(),
        modelCalls: 0,
        coordination: viaFabric
          ? "real AgentSpaces loopback; synthetic source payload"
          : f.fixture
            ? "fixture; no fabric connection"
            : "local permitted native excerpt; not yet fabric-published",
      },
    };
  }
  async connectFabric(config) {
    const p = this.project(config.project);
    if (!p.fixture)
      throw new Error(
        "Native private-content fabric admission is not qualified; local fixture project only",
      );
    await this.fabric.connect(config);
    this.fabricProject = p.id;
    this.store.audit("Loopback fabric connected", { project: p.id });
    return this.fabric.diagnostics();
  }
  async publish(id) {
    const s = this.session(id),
      g = this.store.data.grants[id] ?? {};
    if (!s.fixture || !g.enrolled || !g.content || !g.share)
      throw new Error(
        "Fixture source enrollment, content and sharing grants required",
      );
    if (this.fabricProject !== s.project || this.fabric.status !== "connected")
      throw new Error(
        "Connect this fixture project to the loopback fabric first",
      );
    const f = await this.finding(id),
      prior = this.published[id];
    if (prior) {
      if (prior.groupId !== this.fabric.peer.group)
        throw new Error(
          "Source already published in a different group; reconcile explicitly",
        );
      return { ...prior, duplicate: true };
    }
    const issuer = this.fabric.participant(id).agentId;
    const entryId = this.fabric.write(
      "desktop-fixture-context",
      TYPES.finding,
      f,
      id,
    );
    const publication = {
      entryId,
      issuer,
      groupId: this.fabric.peer.group,
      version: f.source.version,
      project: s.project,
      at: new Date(this.clock()).toISOString(),
    };
    this.published[id] = publication;
    this.store.data.published = this.published;
    this.store.audit("Fixture finding emitted to upstream fabric", {
      sourceId: id,
      entryId,
      fixture: true,
    });
    return {
      ...publication,
      acknowledgement:
        "Unacknowledged write; retrieval reconciles this exact signed entry identifier. No automatic retry.",
    };
  }
  async discoverNative({
    id,
    path,
    account,
    archived = false,
    provider = "codex",
    host = "local",
    cursor = null,
  }) {
    if (
      !["local", "remote"].includes(host) ||
      !["codex", "claude"].includes(provider)
    )
      throw new Error("Unsupported host or provider");
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(id ?? "") ||
      ["constructor", "__proto__", "prototype"].includes(id)
    )
      throw new Error("Invalid project label");
    const normalize = host === "remote" ? posix.normalize : resolve;
    if (
      typeof id !== "string" ||
      !id ||
      typeof account !== "string" ||
      !account ||
      typeof path !== "string" ||
      !(host === "remote" ? posix.isAbsolute(path) : isAbsolute(path))
    )
      throw new Error(
        "Explicit project ID, absolute path and account boundary required",
      );
    const existing = this.store.data.projects[id],
      targetKey = host + ":" + provider,
      oldTarget = existing?.targets?.[targetKey];
    if (
      (existing && (existing.fixture || existing.account !== account)) ||
      (oldTarget && normalize(oldTarget.path) !== normalize(path))
    )
      throw new Error("Project identity cannot be rebound");
    const project = {
      id,
      path: normalize(path),
      account,
      host,
      provider,
      metadataGrant: true,
      fixture: false,
    };
    const tool = this.tools.find(
      (t) => t.provider === provider && (t.host ?? "local") === host,
    );
    if (!tool?.versionMatches)
      throw new Error(
        "Installed native version is not qualified for this read adapter; detect this host first",
      );
    const adapter = this.nativeFactory({ host, provider });
    let result;
    try {
      await adapter.open();
      result = await adapter.discover(project, archived, cursor);
    } finally {
      adapter.close();
    }
    project.nextCursor = result.nextCursor ?? null;
    project.archived = archived;
    this.store.data.projects[id] = {
      id,
      account,
      metadataGrant: true,
      fixture: false,
      targets: { ...existing?.targets, [targetKey]: project },
    };
    this.store.save();
    for (const s of result.sessions) {
      const session = {
        ...s,
        host,
        nativeThreadId: s.nativeThreadId ?? s.id,
        id: provider + "@" + host + ":" + (s.nativeThreadId ?? s.id),
      };
      this.catalog = this.catalog.filter((old) => old.id !== session.id);
      this.catalog.push(session);
    }
    this.mode = "native-read-only";
    this.store.audit("Native metadata discovery", {
      project: id,
      host,
      provider,
      archived,
      count: result.sessions.length,
    });
    return result;
  }
  async moreNative({ projectId, targetKey }) {
    const target = this.project(projectId).targets?.[targetKey];
    if (!target?.metadataGrant || target.nextCursor === null)
      throw new Error("No granted metadata page available");
    return this.discoverNative({ ...target, cursor: target.nextCursor });
  }
  issueConnector(id) {
    const s = this.session(id),
      g = this.permissions(s);
    if (!g?.enrolled || !g.retrieve)
      throw new Error("Enrolled retrieval participant required");
    const token = randomBytes(32).toString("hex");
    this.store.data.connectors[hash(token)] = {
      sessionId: id,
      project: s.project,
      account: s.account,
      scopeId: s.scopeId ?? null,
    };
    this.store.save();
    return { token, sessionId: id, project: s.project };
  }
  connector(token) {
    const binding = this.store.data.connectors[hash(token)];
    if (!binding) throw new Error("Connector denied");
    const s = this.session(binding.sessionId);
    if (
      s.project !== binding.project ||
      s.account !== binding.account ||
      !this.permissions(s).enrolled ||
      !this.permissions(s).retrieve
    )
      throw new Error("Connector revoked");
    return binding;
  }
  snapshot() {
    const answerReceipts = Object.values(
      this.store.data.askReceipts ?? {},
    ).filter((receipt) => receipt.dispatchCounted);
    const knownAnswers = answerReceipts.filter(
      (receipt) => receipt.result?.usage?.known === true,
    );
    const answerUsage = {
      requests: answerReceipts.length,
      completed: answerReceipts.filter(
        (receipt) => receipt.state === "completed",
      ).length,
      uncertain: answerReceipts.filter(
        (receipt) => receipt.state === "uncertain",
      ).length,
      unknownMetrics: answerReceipts.length - knownAnswers.length,
      reportedInputTokens: knownAnswers.reduce(
        (sum, receipt) => sum + receipt.result.usage.inputTokens,
        0,
      ),
      reportedOutputTokens: knownAnswers.reduce(
        (sum, receipt) => sum + receipt.result.usage.outputTokens,
        0,
      ),
      scope:
        "One fresh native question receipt per request; known provider token totals only, not billing or reconstructed native turn identity",
    };
    return {
      answerUsage,
      localOS: hostOS("local"),
      mode: this.mode,
      tools: this.tools,
      projects: Object.values(this.store.data.projects),
      sessions: this.catalog
        .filter(
          (s) =>
            this.store.data.projects[s.project]?.metadataGrant &&
            this.store.data.projects[s.project]?.account === s.account &&
            (!s.scopeId || this.workspace.sessionAllowed(s)),
        )
        .map((s) => ({ ...s, grants: this.permissions(s) })),
      activity: this.store.data.audit,
      usage: usageSummary(this.store),
      modelCalls: this.modelCalls,
      fabric: this.fabric.diagnostics(),
      workspace: this.workspace.summary(),
      nativeExecution:
        "Original-thread execution requires separate qualification; fresh Ask questions use version/authentication/grant/budget checks",
    };
  }
}
