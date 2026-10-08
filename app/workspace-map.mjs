import { readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { WorkspaceAdapter } from "./workspace-adapter.mjs";
import { hostPaths, normalizeHostPath } from "./platform.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
function previousHostGraph(index, host) {
  const nodes = index.nodes.filter(
      (n) => n.host === host && n.kind !== "session",
    ),
    ids = new Set(nodes.map((n) => n.id));
  return {
    host,
    nodes,
    edges: index.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
  };
}
export function scopePathExcluded(path, host, exclusions = []) {
  if (
    typeof path !== "string" ||
    /(?:^|[\\/])patent[ _-]?foundations(?:[\\/]|$)/i.test(path)
  )
    return true;
  const norm = (p) => normalizeHostPath(p, host);
  const actual = norm(path),
    sep = hostPaths(host).sep;
  return exclusions.some(
    (p) => actual === norm(p) || actual.startsWith(norm(p) + sep),
  );
}
export function mapSessions(graph, sessions) {
  const nodes = [...graph.nodes],
    edges = [...graph.edges],
    trees = nodes
      .filter((n) => n.kind === "worktree")
      .sort((a, b) => b.path.length - a.path.length);
  const content = new Map(),
    remotes = new Map();
  for (const node of nodes) {
    if (node.hash) {
      const prior = content.get(node.hash);
      if (prior && prior.host !== node.host)
        edges.push({
          from: node.id,
          to: prior.id,
          relation: "identical bytes across hosts",
          evidence: "SHA-256 " + node.hash,
          confidence: "confirmed",
        });
      else content.set(node.hash, node);
    }
    if (node.kind === "repository" && node.remote) {
      const prior = remotes.get(node.remote);
      if (prior && prior.id !== node.id)
        edges.push({
          from: node.id,
          to: prior.id,
          relation: "possible clone family",
          evidence:
            "Matching sanitized origin URL; not shared repository identity",
          confidence: "suggested",
        });
      else remotes.set(node.remote, node);
    }
  }
  for (const s of sessions) {
    const node = {
      id: "session:" + s.id,
      kind: "session",
      title: s.title,
      host: s.host,
      provider: s.provider,
      nativeThreadId: s.nativeThreadId,
      participantId: s.id,
      path: s.cwd,
      status: s.status,
      sourceVersion: s.sourceVersion,
      scopeId: s.scopeId,
      fixture: !!s.fixture,
    };
    nodes.push(node);
    const norm = (value) => normalizeHostPath(value, s.host);
    const path = norm(s.cwd ?? "");
    const tree = s.cwd
      ? trees.find(
          (w) =>
            w.host === s.host &&
            (path === norm(w.path) ||
              path.startsWith(
                norm(w.path) + hostPaths(s.host).sep,
              )),
        )
      : null;
    edges.push({
      from: node.id,
      to: tree?.id ?? "host:" + s.host,
      relation: tree
        ? "native cwd in worktree"
        : s.cwd
          ? "native session on host"
          : "native location unknown",
      evidence: s.cwd
        ? "Supported native catalog working directory"
        : "Native catalog omitted working directory; no path guessed",
      confidence: "confirmed",
    });
  }
  const sessionsById = new Map();
  for (const node of nodes.filter((n) => n.kind === "session")) {
    const key = node.nativeThreadId.toLowerCase();
    const list = sessionsById.get(key) ?? [];
    list.push(node);
    sessionsById.set(key, list);
  }
  for (const node of nodes.filter((n) => n.kind === "document"))
    for (const reference of node.nativeSessionReferences ?? []) {
      const matches = sessionsById.get(reference.toLowerCase()) ?? [];
      for (const session of matches)
        edges.push({
          from: node.id,
          to: session.id,
          relation: "mentions native session ID",
          evidence:
            "Explicit UUID mention in indexed Markdown; not proof of authorship",
          confidence: matches.length === 1 ? "confirmed" : "suggested",
        });
    }
  return { ...graph, nodes, edges, sessions };
}
export class WorkspaceMap {
  constructor(
    engine,
    { adapterFactory = (host) => new WorkspaceAdapter(host) } = {},
  ) {
    this.engine = engine;
    this.adapterFactory = adapterFactory;
    this.path = join(engine.store.root, "workspace-index.json");
    this.running = false;
    this.cancelled = false;
    this.currentAdapter = null;
    this.progress = { stage: "idle" };
    try {
      this.index = existsSync(this.path)
        ? JSON.parse(readFileSync(this.path, "utf8"))
        : null;
    } catch {
      this.index = null;
      this.cacheError =
        "Derived cache unreadable; rebuild from native/Git/filesystem sources";
    }
    if (
      this.index?.schema !== 1 ||
      !Array.isArray(this.index?.nodes) ||
      !Array.isArray(this.index?.edges) ||
      !Array.isArray(this.index?.sessions)
    )
      this.index = null;
    if (this.index?.profile?.active) {
      this.index.stale = true;
      this.restore(this.index.sessions ?? []);
    }
  }
  restore(sessions) {
    const e = this.engine;
    for (const s of sessions) {
      const location = s.cwd ?? "unknown-location:" + s.nativeThreadId;
      const old = e.catalog.find((item) => item.id === s.id);
      if (
        old &&
        (old.scopeId !== s.scopeId ||
          old.account !== s.account ||
          old.sourceVersion !== s.sourceVersion)
      )
        e.cache.delete(s.id);
      const id =
        "auto-" +
        hash(s.host + "\0" + location + "\0" + s.account).slice(0, 24);
      s.project = id;
      e.store.data.projects[id] = {
        id,
        account: s.account,
        metadataGrant: true,
        derived: true,
        targets: {
          ...(e.store.data.projects[id]?.targets ?? {}),
          [s.host + ":" + s.provider]: {
            id,
            path: s.cwd,
            account: s.account,
            host: s.host,
            provider: s.provider,
            metadataGrant: true,
            scopeId: s.scopeId,
          },
        },
      };
      e.catalog = e.catalog.filter((old) => old.id !== s.id);
      e.catalog.push(s);
    }
  }
  validate(input) {
    const hosts = input.hosts ?? ["local"],
      providers = input.providers ?? ["codex", "claude"];
    if (
      !hosts.length ||
      hosts.some((h) => !["local", "remote"].includes(h)) ||
      !providers.length ||
      providers.some((p) => !["codex", "claude"].includes(p))
    )
      throw new Error("Choose supported hosts and native tools");
    if (!["metadata", "local-retrieval"].includes(input.policy ?? "metadata"))
      throw new Error("Invalid broad lookup policy");
    if (
      typeof input.account !== "string" ||
      !input.account.trim() ||
      input.account.length > 96
    )
      throw new Error("Account boundary label required");
    const exclusions = input.exclusions ?? {},
      roots = input.roots ?? {};
    for (const host of hosts)
      for (const path of [...(exclusions[host] ?? []), ...(roots[host] ?? [])])
        if (
          typeof path !== "string" ||
          !hostPaths(host).isAbsolute(path)
        )
          throw new Error(
            "Workspace roots/exclusions must be absolute on their host",
          );
    return {
      id: this.index?.profile?.id ?? "scope-" + randomUUID(),
      hosts: [...new Set(hosts)],
      providers: [...new Set(providers)],
      policy: input.policy ?? "metadata",
      account: input.account.trim(),
      indexFiles: input.indexFiles === true,
      exclusions,
      roots,
      active: true,
    };
  }
  async scan(input, { continuePages = false, catalogOnly = false } = {}) {
    if (continuePages && this.index?.fixture)
      throw new Error(
        "Fixture metadata never triggers a native discovery pass",
      );
    if (this.running)
      throw new Error("A workspace inventory is already running");
    const profile = this.validate(input);
    this.running = true;
    this.cancelled = false;
    this.progress = { stage: "native metadata", completed: 0 };
    const e = this.engine,
      errors = [],
      cursors = {},
      collected = new Map();
    if (continuePages && this.index?.profile.id === profile.id)
      for (const s of this.index.sessions ?? []) collected.set(s.id, s);
    const started = Date.now();
    try {
      for (const host of profile.hosts) {
        if (this.cancelled)
          throw new Error("Inventory cancelled; previous index preserved");
        await e.probe(host);
        for (const provider of profile.providers) {
          const tool = e.tools.find(
            (t) => t.provider === provider && t.host === host,
          );
          if (!tool?.versionMatches) {
            errors.push({
              host,
              provider,
              reason:
                "Native version unavailable or outside qualified adapter boundary",
            });
            continue;
          }
          const archives = provider === "codex" ? [false, true] : [false];
          for (const archived of archives) {
            const key = host + ":" + provider + ":" + archived;
            let cursor = continuePages
              ? (this.index?.cursors?.[key] ?? null)
              : null;
            if (continuePages && this.index?.cursors?.[key] === null) {
              cursors[key] = null;
              continue;
            }
            const adapter = e.nativeFactory({ host, provider });
            this.currentAdapter = adapter;
            try {
              await adapter.open();
              let pages = 0;
              const seen = new Set();
              do {
                if (this.cancelled) throw new Error("Inventory cancelled");
                const result = await adapter.discover(
                  {
                    id: "broad-discovery",
                    account: profile.account,
                    host,
                    metadataGrant: true,
                    allMetadataGrant: true,
                  },
                  archived,
                  cursor,
                );
                for (const item of result.sessions) {
                  if (
                    item.cwd
                      ? scopePathExcluded(
                          item.cwd,
                          host,
                          profile.exclusions[host] ?? [],
                        )
                      : profile.exclusions[host]?.length
                  )
                    continue;
                  const nativeThreadId = item.nativeThreadId ?? item.id,
                    id = provider + "@" + host + ":" + nativeThreadId;
                  const s = {
                    ...item,
                    id,
                    nativeThreadId,
                    host,
                    provider,
                    account: profile.account,
                    scopeId: profile.id,
                  };
                  collected.set(id, s);
                }
                pages++;
                this.progress = {
                  stage: "native metadata",
                  host,
                  provider,
                  sessions: collected.size,
                  pages,
                };
                const next = result.nextCursor ?? null;
                if (next !== null && seen.has(String(next)))
                  throw new Error(
                    "Repeated native pagination cursor; earlier pages preserved",
                  );
                if (next !== null) seen.add(String(next));
                cursor = next;
              } while (
                cursor !== null &&
                pages < 20 &&
                Date.now() - started < 120000
              );
              cursors[key] = cursor;
            } catch {
              errors.push({
                host,
                provider,
                reason: this.cancelled
                  ? "Cancelled"
                  : "Native metadata read unavailable; no inference or private endpoint fallback",
              });
              cursors[key] = cursor;
            } finally {
              adapter.close();
              this.currentAdapter = null;
            }
          }
        }
      }
      const graphs = [];
      for (const host of profile.hosts) {
        if (this.cancelled)
          throw new Error("Inventory cancelled; previous index preserved");
        if (catalogOnly) {
          const retain = this.index?.profile?.active && !this.index.fixture && this.index.profile.account === profile.account && JSON.stringify(this.index.profile.roots) === JSON.stringify(profile.roots);
          const prior = retain ? previousHostGraph(this.index, host) : { nodes: [], edges: [] };
          const nodes = prior.nodes.filter(node => !node.path || !scopePathExcluded(node.path, host, profile.exclusions[host] ?? [])), ids = new Set(nodes.map(node => node.id));
          graphs.push({ host, nodes, edges: prior.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)), cursor: retain ? this.index.filesystemCursors?.[host] ?? null : null, coverage: { roots: [], directories: 0, files: 0, excluded: 0, errors: [], limits: [nodes.length ? "Native metadata refreshed; file index retains its prior captured revisions" : "Thread catalog only; repository and file inventory has not run"] } });
          continue;
        }
        this.progress = {
          stage: "repositories, worktrees and files",
          host,
          sessions: collected.size,
        };
        const adapter = this.adapterFactory(host);
        this.currentAdapter = adapter;
        const previous =
          continuePages && this.index
            ? previousHostGraph(this.index, host)
            : null;
        try {
          const cursor = continuePages
            ? this.index?.filesystemCursors?.[host]
            : null;
          if (continuePages && this.index?.filesystemCursors?.[host] === null) {
            graphs.push({
              ...previous,
              coverage: this.index.coverage.find((c) => c.host === host) ?? {
                limits: [],
              },
              cursor: null,
            });
          } else
            graphs.push(
              await adapter.scan(
                {
                  host,
                  roots: profile.roots[host] ?? [],
                  automaticRoots: !profile.roots[host]?.length,
                  exclusions: profile.exclusions[host] ?? [],
                  filesGrant: true,
                  contentGrant: profile.indexFiles,
                },
                [...collected.values()]
                  .filter((s) => s.host === host)
                  .map((s) => s.cwd)
                  .filter(Boolean),
                { previous, cursor },
              ),
            );
        } catch {
          errors.push({
            host,
            reason:
              "Workspace filesystem/Git read unavailable; no directory changes made",
          });
          if (previous)
            graphs.push({
              ...previous,
              cursor: this.index.filesystemCursors?.[host] ?? null,
              coverage: this.index.coverage.find((c) => c.host === host) ?? {
                limits: ["host read unavailable"],
              },
            });
        } finally {
          adapter.close();
          this.currentAdapter = null;
        }
      }
      if (this.cancelled)
        throw new Error("Inventory cancelled; previous index preserved");
      const sessions = [...collected.values()].filter(
          (s) =>
            profile.hosts.includes(s.host) &&
            profile.providers.includes(s.provider) &&
            s.account === profile.account &&
            (s.cwd
              ? !scopePathExcluded(
                  s.cwd,
                  s.host,
                  profile.exclusions[s.host] ?? [],
                )
              : !profile.exclusions[s.host]?.length),
        ),
        combined = {
          schema: 1,
          profile,
          observedAt: new Date().toISOString(),
          nodes: graphs.flatMap((g) => g.nodes),
          edges: graphs.flatMap((g) => g.edges),
          coverage: graphs.map((g) => ({ host: g.host, ...g.coverage })),
          errors,
          cursors,
          stale: false,
          modelCalls: 0,
        };
      for (const host of profile.hosts)
        if (!combined.nodes.some((n) => n.id === "host:" + host))
          combined.nodes.push({
            id: "host:" + host,
            kind: "host",
            title: host,
            host,
          });
      combined.filesystemCursors = Object.fromEntries(
        profile.hosts.map((host) => [
          host,
          graphs.find((g) => g.host === host)?.cursor ?? null,
        ]),
      );
      const next = mapSessions(combined, sessions);
      this.index = next;
      e.catalog = e.catalog.filter((s) => !s.scopeId);
      this.restore(sessions);
      this.save();
      e.mode = "workspace-connected";
      e.store.audit("Broad workspace inventory batch complete", {
        scopeId: profile.id,
        sessions: sessions.length,
        nodes: next.nodes.length,
        errors: errors.length,
        policy: profile.policy,
        modelCalls: 0,
      });
      return this.summary();
    } finally {
      this.running = false;
      this.progress = { stage: this.cancelled ? "cancelled" : "idle" };
    }
  }
  save() {
    const temp = this.path + ".tmp";
    writeFileSync(temp, JSON.stringify(this.index), { mode: 0o600 });
    renameSync(temp, this.path);
  }
  summary() {
    const index = this.index;
    return {
      running: this.running,
      progress: this.progress,
      profile: index?.profile ?? null,
      observedAt: index?.observedAt ?? null,
      stale: !!index?.stale,
      counts: Object.fromEntries(
        [
          "host",
          "session",
          "repository",
          "worktree",
          "document",
          "artifact",
        ].map((kind) => [
          kind,
          index?.profile?.active
            ? index.nodes.filter((n) => n.kind === kind).length
            : 0,
        ]),
      ),
      missingNativeLocations:
        index?.sessions?.filter((s) => !s.cwd).length ?? 0,
      coverage: index?.coverage ?? [],
      errors: index?.errors ?? [],
      hasMore:
        Object.values(index?.cursors ?? {}).some((v) => v !== null) ||
        Object.values(index?.filesystemCursors ?? {}).some((v) => v !== null),
      fixture: !!index?.fixture,
      authority:
        "Derived view; no new work registry, no model execution, no automatic archive/delete/publish.",
    };
  }
  view() {
    if (!this.index?.profile?.active)
      return { ...this.summary(), nodes: [], edges: [] };
    return { ...this.index, ...this.summary() };
  }
  search({ query = "", kind = "all", limit = 20 } = {}) {
    if (!this.index?.profile?.active)
      throw new Error("Workspace scope revoked");
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const matches = this.index.nodes.filter(
      (n) =>
        (kind === "all" || n.kind === kind) &&
        words.every((w) =>
          [n.title, n.path, n.branch, n.provider, n.host]
            .join(" ")
            .toLowerCase()
            .includes(w),
        ),
    );
    return {
      items: matches
        .slice(0, Math.max(1, Math.min(Number(limit) || 20, 50)))
        .map((n) => ({
          ...n,
          changes: undefined,
          relationships: this.index.edges
            .filter((e) => e.from === n.id || e.to === n.id)
            .slice(0, 12),
        })),
      total: matches.length,
      observedAt: this.index.observedAt,
      stale: !!this.index.stale,
      scopeId: this.index.profile.id,
      modelCalls: 0,
      authority:
        "Derived relationships; source links and hash equality are evidence, suggested links are not authority",
    };
  }
  grantFor(session) {
    const p = this.index?.profile;
    if (!this.sessionAllowed(session)) return {};
    return p.policy === "local-retrieval"
      ? {
          enrolled: true,
          content: !!session.cwd,
          share: !!session.cwd,
          retrieve: true,
        }
      : {};
  }
  sessionAllowed(session) {
    const p = this.index?.profile;
    return !!(
      p?.active &&
      session.scopeId === p.id &&
      session.account === p.account &&
      p.hosts.includes(session.host) &&
      p.providers.includes(session.provider) &&
      (session.cwd
        ? !scopePathExcluded(
            session.cwd,
            session.host,
            p.exclusions[session.host] ?? [],
          )
        : !p.exclusions[session.host]?.length)
    );
  }
  cancel() {
    this.cancelled = true;
    this.currentAdapter?.close();
    return { status: "Cancellation requested; previous index retained" };
  }
  revoke() {
    if (this.running) this.cancel();
    if (this.index) {
      this.index.profile.active = false;
      this.save();
    }
    for (const s of this.engine.catalog)
      if (s.scopeId === this.index?.profile.id) this.engine.cache.delete(s.id);
    this.engine.store.audit("Broad workspace scope revoked");
    return this.summary();
  }
  async compare({ leftId, rightId }) {
    if (!this.index?.profile?.active)
      throw new Error("Workspace scope revoked");
    const left = this.index.nodes.find(
        (n) => n.id === leftId && n.kind === "worktree",
      ),
      right = this.index.nodes.find(
        (n) => n.id === rightId && n.kind === "worktree",
      );
    if (!left || !right) throw new Error("Select two indexed worktrees");
    if (left.host !== right.host)
      throw new Error(
        "Cross-host ancestry is not qualified; use file-hash relationships",
      );
    const adapter = this.adapterFactory(left.host);
    try {
      return await adapter.compare(left, right);
    } finally {
      adapter.close();
    }
  }
  async inspect({ nodeId }) {
    const p = this.index?.profile;
    if (!p?.active || !p.indexFiles)
      throw new Error("Workspace file-content scope is not granted");
    const node = this.index.nodes.find(
      (n) => n.id === nodeId && ["document", "artifact"].includes(n.kind),
    );
    if (
      !node ||
      scopePathExcluded(node.path, node.host, p.exclusions[node.host] ?? [])
    )
      throw new Error("File outside workspace scope");
    const adapter = this.adapterFactory(node.host);
    try {
      return await adapter.inspect(node);
    } finally {
      adapter.close();
    }
  }
}
