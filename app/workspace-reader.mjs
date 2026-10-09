import { readdir, lstat, realpath, readFile, stat } from "node:fs/promises";
import {
  resolve,
  join,
  relative,
  dirname,
  basename,
  isAbsolute,
  parse,
} from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const excludedNames = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "build",
  "dist",
  ".local",
  ".state",
  ".codex",
  ".claude",
  ".ssh",
  ".aws",
  ".azure",
  "logs",
  "credentials",
  "secrets",
  "tooling",
  "m2",
  "cache",
  "coverage",
  "sessions",
  "transcripts",
  "exports",
]);
export function sensitiveFileName(value) {
  const name = basename(value);
  return (
    ["runtime.json", "workspace-index.json", "settings.json"].includes(
      name.toLowerCase(),
    ) ||
    /^(?:auth|credentials?|secrets?|tokens?|cookies?|private[-_]key)(?:[._-]|$)|\.(?:pem|key|p12|pfx|kdbx)$/i.test(
      name,
    )
  );
}
export function normalizePath(value) {
  const p = resolve(value).replace(/[\\/]$/, "");
  return process.platform === "win32" ? p.toLowerCase() : p;
}
export function within(path, root) {
  const p = normalizePath(path),
    r = normalizePath(root);
  return (
    p === r || p.startsWith(r + (process.platform === "win32" ? "\\" : "/"))
  );
}
export function excludedPath(path, exclusions = []) {
  return (
    /(?:^|[\\/])patent[ _-]?foundations(?:[\\/]|$)/i.test(path) ||
    exclusions.some((root) => within(path, root))
  );
}
export async function gitRead(path, args) {
  const { stdout } = await execute(
    "git",
    ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", path, ...args],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  return stdout;
}
export function parseWorktrees(text) {
  return text
    .split("\0\0")
    .filter(Boolean)
    .map((block) => {
      const item = {};
      for (const field of block.split("\0")) {
        const space = field.indexOf(" "),
          key = space < 0 ? field : field.slice(0, space),
          value = space < 0 ? true : field.slice(space + 1);
        item[key] = value;
      }
      return {
        path: item.worktree,
        head: item.HEAD ?? null,
        branch: item.branch ?? null,
        bare: !!item.bare,
        locked: item.locked ?? false,
        prunable: item.prunable ?? false,
      };
    })
    .filter((w) => w.path);
}
export function parseStatus(text) {
  const parts = text.split("\0"),
    rows = [];
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    const xy = parts[i].slice(0, 2),
      path = parts[i].slice(3);
    rows.push({
      xy,
      path,
      original: xy.includes("R") || xy.includes("C") ? parts[++i] : null,
    });
  }
  return rows;
}
export function safeRemote(value) {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url
      .toString()
      .replace(/\.git$/, "")
      .replace(/\/$/, "");
  } catch {
    return trimmed.replace(/^[^@/]+@/, "").replace(/\.git$/, "");
  }
}
async function optionalGit(path, args, fallback = "") {
  try {
    return await gitRead(path, args);
  } catch {
    return fallback;
  }
}
async function checkScopeAliases(node) {
  for (const alias of node.scopeAliases ?? []) {
    if (normalizePath(await realpath(alias.requestedPath)) !== normalizePath(alias.canonicalPath)) throw new Error("Granted root alias changed; refresh inventory");
  }
}
export async function scanWorkspace(request) {
  if (request.action && request.action !== "scan")
    throw new Error("Unsupported workspace read");
  const scope = request.scope ?? {};
  if (!scope.filesGrant) throw new Error("Workspace inventory grant required");
  const host = scope.host ?? "local",
    exclusions = [...(scope.exclusions ?? [])],
    content = scope.contentGrant === true;
  const maxDirectories = Math.min(
      Number(request.maxDirectories ?? 12000),
      30000,
    ),
    maxFiles = Math.min(Number(request.maxFiles ?? 4000), 10000),
    maxDepth = Math.min(Number(request.maxDepth ?? 8), 16);
  const started = Date.now(),
    nodes = new Map((request.previous?.nodes ?? []).map((n) => [n.id, n])),
    edges = [...(request.previous?.edges ?? [])],
    repositories = new Map(
      (request.previous?.nodes ?? [])
        .filter((n) => n.kind === "repository")
        .map((n) => [n.id, n]),
    ),
    visited = new Set(request.cursor?.visited ?? []),
    documents = [],
    coverage = {
      directories: 0,
      files: 0,
      excluded: 0,
      symlinksSkipped: 0,
      errors: [],
      limits: [],
      roots: [],
    };
  const id = (kind, path) =>
    kind + ":" + digest(host + "\0" + normalizePath(path)).slice(0, 24);
  const add = (node) => {
    if (nodes.size < 14000) nodes.set(node.id, node);
    else if (!coverage.limits.includes("node limit"))
      coverage.limits.push("node limit");
  };
  const edge = (from, to, relation, evidence, confidence = "confirmed") => {
    if (edges.length < 24000)
      edges.push({ from, to, relation, evidence, confidence });
  };
  const rootNode = {
    id: "host:" + host,
    kind: "host",
    title: host,
    host,
    os: process.platform,
  };
  add(rootNode);
  const roots = scope.roots?.length
    ? scope.roots
    : [
        join(homedir(), "workspaces"),
        join(homedir(), "Documents", "Codex"),
        join(homedir(), "projects"),
        join(homedir(), "src"),
        ...(request.cwdHints ?? []),
      ];
  const validRoots = [], scopeAliases = [];
  for (const root of [...new Set(roots)].sort()) {
    if (
      typeof root !== "string" ||
      !isAbsolute(root) ||
      excludedPath(root, exclusions) ||
      normalizePath(root) === normalizePath(parse(root).root) ||
      (!scope.roots?.length && normalizePath(root) === normalizePath(homedir()))
    )
      continue;
    try {
      const s = await lstat(root);
      if (s.isSymbolicLink()) {
        coverage.symlinksSkipped++;
        continue;
      }
      if (!s.isDirectory()) continue;
      const canonicalPath = await realpath(root);
      if (excludedPath(canonicalPath, exclusions)) continue;
      validRoots.push(canonicalPath);
      if (normalizePath(root) !== normalizePath(canonicalPath)) scopeAliases.push({ requestedPath: resolve(root), canonicalPath });
    } catch {}
  }
  for (const exclusion of [...exclusions]) for (const alias of scopeAliases) {
    if (within(exclusion, alias.requestedPath)) exclusions.push(join(alias.canonicalPath, relative(alias.requestedPath, exclusion)));
    else if (within(alias.requestedPath, exclusion)) exclusions.push(alias.canonicalPath);
  }
  const compactRoots = validRoots.filter(
    (root) =>
      !validRoots.some((other) => other !== root && within(root, other)),
  );
  coverage.roots = compactRoots;
  const allowed = (path) =>
    !excludedPath(path, exclusions) &&
    (scope.automaticRoots !== false ||
      compactRoots.some((root) => within(path, root)));
  async function repositoryAt(path) {
    try {
      const common = (
        await gitRead(path, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ])
      ).trim();
      const repositoryId = id("repository", common);
      if (repositories.has(repositoryId)) return;
      const remote = safeRemote(
        await optionalGit(path, ["remote", "get-url", "origin"]),
      );
      const repo = {
        id: repositoryId,
        kind: "repository",
        title:
          basename(common) === ".git"
            ? basename(dirname(common))
            : basename(common),
        host,
        path: basename(common) === ".git" ? dirname(common) : path,
        commonDir: common,
        remote,
        observedAt: new Date().toISOString(),
      };
      repositories.set(repositoryId, repo);
      add(repo);
      edge(rootNode.id, repo.id, "contains repository", "Git common directory");
      const worktrees = parseWorktrees(
        await gitRead(path, ["worktree", "list", "--porcelain", "-z"]),
      ).map((w) => ({ ...w, gitPath: w.path, path: resolve(w.path) }));
      for (const w of worktrees) {
        if (w.bare) continue;
        if (excludedPath(w.path, exclusions)) {
          coverage.excluded++;
          continue;
        }
        const reportedPath = w.path;
        let exists = false;
        try {
          const meta = await lstat(w.path);
          exists = meta.isDirectory() && !meta.isSymbolicLink();
          if (exists) w.path = await realpath(w.path);
        } catch {}
        if (excludedPath(w.path, exclusions)) { coverage.excluded++; continue; }
        const worktreeId = id("worktree", w.path);
        let changes = [];
        if (exists && !w.bare)
          changes = parseStatus(
            await optionalGit(w.path, [
              "status",
              "--porcelain=v1",
              "-z",
              "--untracked-files=all",
            ]),
          );
        const trackedText =
          exists && !w.bare
            ? await optionalGit(w.path, [
                "ls-files",
                "--stage",
                "-z",
                "--",
                ":(glob)**/*.md",
                ":(glob)**/work/**",
                ":(glob)**/outputs/**",
                ":(glob)**/evidence/**",
                ":(glob)**/reports/**",
              ])
            : "";
        const tracked = Object.fromEntries(
          trackedText
            .split("\0")
            .filter(Boolean)
            .map((line) => {
              const tab = line.indexOf("\t");
              return [line.slice(tab + 1), line.slice(0, tab).split(" ")[1]];
            }),
        );
        const node = {
          id: worktreeId,
          kind: "worktree",
          title: basename(w.path),
          host,
          ...w,
          repositoryId,
          changes: changes.slice(0, 1000),
          changesTruncated: changes.length > 1000,
          dirty: changes.filter((c) => c.xy !== "??").length,
          untracked: changes.filter((c) => c.xy === "??").length,
          readAllowed: allowed(w.path),
          contentReadAllowed: content && allowed(w.path),
          comparisonAllowed: content && allowed(w.path) && !exclusions.some(exclusion => within(exclusion, w.path)),
          observedAt: new Date().toISOString(),
          verification: "unknown",
          integration: "unknown",
        };
        const aliases = scopeAliases.filter(alias => within(w.path, alias.canonicalPath));
        node.pathAliases = [...new Set([
          ...(normalizePath(reportedPath) !== normalizePath(w.path) ? [reportedPath] : []),
          ...aliases.map(alias => join(alias.requestedPath, relative(alias.canonicalPath, w.path))),
        ])];
        node.available = exists;
        node.trackedDocuments = tracked;
        node.readAllowed = node.readAllowed && exists;
        node.contentReadAllowed = node.contentReadAllowed && exists;
        add(node);
        edge(repo.id, node.id, "has worktree", "git worktree list");
        if (w.head) edge(node.id, repo.id, "checkout revision", w.head);
        if (exists && allowed(w.path) && !w.bare)
          queue.push({ path: w.path, depth: 0 });
      }
    } catch {
      if (coverage.errors.length < 40)
        coverage.errors.push({ path, reason: "Git metadata unavailable" });
    }
  }
  const queue = request.cursor?.queue?.length
    ? [...request.cursor.queue]
    : compactRoots.map((path) => ({ path, depth: 0 }));
  while (queue.length) {
    if (request.signal?.aborted) throw new Error("Workspace read cancelled");
    if (Date.now() - started > 45000) {
      coverage.limits.push("45 second scan budget");
      break;
    }
    if (coverage.directories >= maxDirectories || coverage.files >= maxFiles) {
      coverage.limits.push("inventory budget");
      break;
    }
    const current = queue.shift(),
      path = current.path;
    if (visited.has(normalizePath(path)) || !allowed(path)) continue;
    coverage.directories++;
    let entries;
    try {
      if ((await lstat(path)).isSymbolicLink()) {
        coverage.symlinksSkipped++;
        continue;
      }
      entries = (await readdir(path, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch {
      if (coverage.errors.length < 40)
        coverage.errors.push({ path, reason: "Directory inaccessible" });
      continue;
    }
    const bareLayout =
      entries.some((e) => e.name === "HEAD") &&
      entries.some((e) => e.name === "objects" && e.isDirectory()) &&
      entries.some((e) => e.name === "refs" && e.isDirectory());
    if (entries.some((e) => e.name === ".git") || bareLayout)
      await repositoryAt(path);
    if (bareLayout) {
      visited.add(normalizePath(path));
      continue;
    }
    let folderComplete = true;
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (
        entry.name.startsWith(".") ||
        excludedNames.has(entry.name.toLowerCase()) ||
        excludedPath(full, exclusions) ||
        sensitiveFileName(entry.name)
      ) {
        coverage.excluded++;
        continue;
      }
      if (entry.isSymbolicLink()) {
        coverage.symlinksSkipped++;
        continue;
      }
      if (entry.isDirectory()) {
        if (current.depth < maxDepth)
          queue.push({ path: full, depth: current.depth + 1 });
        else if (!coverage.limits.includes("directory depth"))
          coverage.limits.push("directory depth");
        continue;
      }
      if (!entry.isFile()) continue;
      const markdown = /\.md$/i.test(entry.name),
        artifact =
          /(?:^|[\\/])(work|outputs|evidence|reports)(?:[\\/]|$)/i.test(full);
      if (!markdown && !artifact) continue;
      if (nodes.has(id(markdown ? "document" : "artifact", full))) continue;
      if (coverage.files >= maxFiles) {
        folderComplete = false;
        break;
      }
      coverage.files++;
      try {
        const before = await lstat(full);
        if (before.isSymbolicLink() || !before.isFile()) {
          coverage.symlinksSkipped++;
          continue;
        }
        const node = {
          id: id(markdown ? "document" : "artifact", full),
          kind: markdown ? "document" : "artifact",
          title: entry.name,
          path: full,
          host,
          bytes: before.size,
          observedAt: new Date().toISOString(),
          modifiedAt: before.mtime.toISOString(),
          scratchLocation: /(?:^|[\\/])work(?:[\\/]|$)/i.test(full),
          verification: "unknown",
          integration: "unknown",
        };
        if (content && before.size <= 1048576) {
          const bytes = await readFile(full),
            after = await stat(full);
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
            node.unstable = true;
            node.hash = null;
          } else {
            node.hash = digest(bytes);
            if (markdown) {
              const text = bytes.toString("utf8");
              if (Buffer.from(text, "utf8").equals(bytes))
                node.normalizedTextHash = digest(text.replace(/\r\n/g, "\n"));
              node.nativeSessionReferences = [
                ...new Set(
                  text.match(
                    /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,
                  ) ?? [],
                ),
              ].slice(0, 50);
              node.title = (
                /^#{1,6}\s+(.+)$/m.exec(text)?.[1] ?? entry.name
              ).slice(0, 160);
              documents.push({ node, text });
            }
          }
        } else node.contentIndexed = false;
        add(node);
      } catch {
        if (coverage.errors.length < 40)
          coverage.errors.push({ path: full, reason: "File unavailable" });
      }
    }
    if (folderComplete) visited.add(normalizePath(path));
    else queue.unshift(current);
  }
  const trees = [...nodes.values()]
    .filter((n) => n.kind === "worktree")
    .sort((a, b) => b.path.length - a.path.length);
  for (const node of nodes.values()) {
    if (!["document", "artifact"].includes(node.kind)) continue;
    const tree = trees.find((w) => within(node.path, w.path));
    if (tree) {
      node.worktreeId = tree.id;
      node.repositoryId = tree.repositoryId;
      node.worktreeHead = tree.head;
      const relativePath = relative(tree.path, node.path).replace(/\\/g, "/");
      node.relativePath = relativePath;
      const change = tree.changes.find(
        (c) => c.path.replace(/\\/g, "/") === relativePath,
      );
      node.trackedBlob =
        tree.trackedDocuments?.[relativePath] ?? node.trackedBlob ?? null;
      node.localState =
        change?.xy ??
        (node.trackedBlob
          ? "tracked in Git index"
          : "not tracked in observed index; may be ignored");
      edge(tree.id, node.id, "contains file", "Observed filesystem path");
    } else {
      node.localState = "outside discovered Git worktrees";
      edge(rootNode.id, node.id, "contains file", "Observed filesystem path");
    }
  }
  const byPath = new Map(
    [...nodes.values()]
      .filter((n) => n.path && ["document", "artifact"].includes(n.kind))
      .map((n) => [normalizePath(n.path), n]),
  );
  for (const { node, text } of documents) {
    const withoutCode = text.replace(/(^|\n)(`{3,}|~{3,})[\s\S]*?\2/g, "");
    const matches = [...withoutCode.matchAll(/\[[^\]]*\]\(([^)\n]+)\)/g)].map(
        (m) => m[1],
      ),
      references = [...withoutCode.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)].map(
        (m) => m[1],
      );
    for (let raw of [...matches, ...references].slice(0, 100)) {
      raw = raw.replace(/^<|>$/g, "").split(/\s+["']/)[0];
      if (/^(?:https?:|mailto:|data:|javascript:|#)/i.test(raw)) continue;
      try {
        const target = resolve(
          dirname(node.path),
          decodeURIComponent(raw.split("#")[0]),
        );
        const other = byPath.get(normalizePath(target));
        if (other)
          edge(
            node.id,
            other.id,
            "links to document",
            "Explicit Markdown link",
          );
      } catch {}
    }
  }
  const hashes = new Map(),
    titles = new Map(),
    texts = new Map();
  for (const node of nodes.values())
    if (["document", "artifact"].includes(node.kind)) {
      if (node.hash) {
        const prior = hashes.get(node.hash);
        if (prior)
          edge(node.id, prior.id, "identical bytes", "SHA-256 " + node.hash);
        else hashes.set(node.hash, node);
      }
      if (node.normalizedTextHash) {
        const prior = texts.get(node.normalizedTextHash);
        if (prior && prior.hash !== node.hash)
          edge(
            node.id,
            prior.id,
            "same text, different line endings",
            "UTF-8 roundtrip plus CRLF-to-LF normalized SHA-256; bytes are different",
          );
        else texts.set(node.normalizedTextHash, node);
      }
      if (node.kind === "document") {
        const title = node.title.toLowerCase();
        const prior = titles.get(title);
        if (prior && prior.hash !== node.hash)
          edge(
            node.id,
            prior.id,
            "similar title",
            "Same title; no semantic or authority equivalence",
            "suggested",
          );
        else titles.set(title, node);
      }
    }
  for (const tree of trees) delete tree.trackedDocuments;
  const uniqueEdges = [
    ...new Map(
      edges.map((e) => [
        [e.from, e.to, e.relation, e.confidence].join("\0"),
        e,
      ]),
    ).values(),
  ];
  for (const node of nodes.values()) if (node.path) {
    const aliases = scopeAliases.filter(alias => within(node.path, alias.canonicalPath));
    if (aliases.length) node.scopeAliases = aliases;
  }
  return {
    schema: 1,
    host,
    observedAt: new Date().toISOString(),
    nodes: [...nodes.values()],
    edges: uniqueEdges,
    coverage,
    cursor: queue.length ? { queue, visited: [...visited] } : null,
    complete: coverage.limits.length === 0 && queue.length === 0,
    modelCalls: 0,
    authority:
      "Derived read-only view; Git/files/native sources remain owners. No verification, publication or retirement inferred.",
  };
}
export async function compareWorktrees(request) {
  const { left, right } = request;
  if (!left?.readAllowed || !right?.readAllowed)
    throw new Error("Worktree comparison outside the granted inventory");
  if (!left.contentReadAllowed || !right.contentReadAllowed)
    throw new Error(
      "Grant read-only code/document indexing before content comparisons",
    );
  if (left.comparisonAllowed === false || right.comparisonAllowed === false) throw new Error("Worktree comparison cannot honor excluded descendants");
  await Promise.all([checkScopeAliases(left), checkScopeAliases(right)]);
  if (left.repositoryId !== right.repositoryId)
    throw new Error(
      "Commit ancestry requires the same observed Git repository",
    );
  if (
    !/^[a-f0-9]{40,64}$/.test(left.head ?? "") ||
    !/^[a-f0-9]{40,64}$/.test(right.head ?? "")
  )
    throw new Error("Missing exact comparison revisions");
  const currentLeft = (await gitRead(left.path, ["rev-parse", "HEAD"])).trim(),
    currentRight = (await gitRead(right.path, ["rev-parse", "HEAD"])).trim();
  if (
    normalizePath(await realpath(left.path)) !== normalizePath(left.path) ||
    normalizePath(await realpath(right.path)) !== normalizePath(right.path)
  )
    throw new Error("Worktree path changed through a symbolic link; refresh");
  if (currentLeft !== left.head || currentRight !== right.head)
    throw new Error("Worktree head changed; refresh the map before comparing");
  const [base, counts, names, diff, leftStatus, rightStatus] =
    await Promise.all([
      gitRead(left.path, ["merge-base", left.head, right.head]),
      gitRead(left.path, [
        "rev-list",
        "--left-right",
        "--count",
        left.head + "..." + right.head,
      ]),
      gitRead(left.path, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--name-status",
        left.head,
        right.head,
      ]),
      gitRead(left.path, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--stat",
        left.head,
        right.head,
      ]),
      gitRead(left.path, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]),
      gitRead(right.path, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]),
    ]);
  const [leftOnly, rightOnly] = counts.trim().split(/\s+/).map(Number),
    a = parseStatus(leftStatus),
    b = parseStatus(rightStatus);
  const overlap = a
    .map((c) => c.path)
    .filter((path) => b.some((c) => c.path === path));
  const local = async (tree, status) => {
    const safe = status.filter(
      (c) => !/(?:^|[\\/])\./.test(c.path) && !sensitiveFileName(c.path),
    );
    const tracked = safe.filter((c) => c.xy !== "??").slice(0, 50),
      untracked = [];
    const patch = tracked.length
      ? await gitRead(tree.path, [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "HEAD",
          "--",
          ...tracked.map((c) => ":(top,literal)" + c.path),
        ])
      : "";
    for (const file of safe.filter((c) => c.xy === "??").slice(0, 50)) {
      const path = resolve(tree.path, file.path);
      if (!within(path, tree.path)) continue;
      try {
        const meta = await lstat(path);
        if (meta.isFile() && !meta.isSymbolicLink())
          untracked.push({
            path: file.path,
            bytes: meta.size,
            hash: meta.size <= 1048576 ? digest(await readFile(path)) : null,
          });
      } catch {}
    }
    return {
      patch: patch.slice(0, 64000),
      patchTruncated: patch.length > 64000,
      untracked,
      excludedSensitivePaths: status.length - safe.length,
      coverageLimit: tracked.length === 50 || untracked.length === 50,
    };
  };
  const [leftLocal, rightLocal] = await Promise.all([
    local(left, a),
    local(right, b),
  ]);
  await Promise.all([checkScopeAliases(left), checkScopeAliases(right)]);
  return {
    left: {
      id: left.id,
      head: left.head,
      branch: left.branch,
      localChanges: a,
      ...leftLocal,
    },
    right: {
      id: right.id,
      head: right.head,
      branch: right.branch,
      localChanges: b,
      ...rightLocal,
    },
    mergeBase: base.trim(),
    leftOnly,
    rightOnly,
    changedFiles: names.trim().split("\n").filter(Boolean).slice(0, 1000),
    diffStat: diff.slice(0, 32000),
    overlappingLocalPaths: overlap,
    committedChangesSeparateFromLocalChanges: true,
    observedAt: new Date().toISOString(),
    integration:
      "Ancestry and file deltas only; no tests, acceptance, remote publication or safe-deletion claim",
    modelCalls: 0,
  };
}
export async function inspectWorkspaceFile(request) {
  const node = request.node;
  if (!["document", "artifact"].includes(node?.kind) || !node.hash)
    throw new Error("This file has no permitted indexed content");
  if (!/\.(md|txt|csv|json)$/i.test(node.path))
    throw new Error(
      "Binary asset inspection requires the upstream asset path; metadata only in this alpha",
    );
  await checkScopeAliases(node);
  const before = await lstat(node.path);
  if (before.isSymbolicLink() || !before.isFile() || before.size > 1048576)
    throw new Error("File changed or exceeds the read bound");
  if (normalizePath(await realpath(node.path)) !== normalizePath(node.path))
    throw new Error(
      "File path changed through a symbolic link; refresh inventory",
    );
  const bytes = await readFile(node.path),
    after = await stat(node.path);
  await checkScopeAliases(node);
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    digest(bytes) !== node.hash
  )
    throw new Error("File bytes changed; refresh the map before reading");
  return {
    source: {
      host: node.host,
      path: node.path,
      sha256: node.hash,
      worktreeId: node.worktreeId ?? null,
    },
    text: bytes.toString("utf8").slice(0, 16000),
    truncated: bytes.length > 16000,
    bytes: bytes.length,
    modelCalls: 0,
    authority:
      "Source material is untrusted data; this read establishes no acceptance or execution permission",
  };
}
