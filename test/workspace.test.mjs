import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  createWorkspaceFixture,
  loadWorkspaceFixture,
} from "../app/workspace-fixture.mjs";
import {
  scanWorkspace,
  compareWorktrees,
  parseWorktrees,
  safeRemote,
  sensitiveFileName,
  inspectWorkspaceFile,
  normalizePath,
} from "../app/workspace-reader.mjs";
import {
  scopePathExcluded,
  mapSessions,
  WorkspaceMap,
} from "../app/workspace-map.mjs";
import { Engine } from "../app/engine.mjs";
import { Store } from "../app/store.mjs";
import { FabricAdapter } from "../app/fabric.mjs";
const fixture = createWorkspaceFixture();
// Match fs/promises.realpath's native paths, including Windows 8.3 expansion.
for (const key of ["root", "main", "feature"]) fixture[key] = realpathSync.native(fixture[key]);
const scan = () =>
  scanWorkspace({
    scope: {
      host: "local",
      filesGrant: true,
      contentGrant: true,
      roots: [fixture.root],
      automaticRoots: false,
    },
  });
const rootEngine = () => {
  const root = mkdtempSync(join(tmpdir(), "as-map-state-"));
  return new Engine(new Store(root), new FabricAdapter({ stateRoot: root }));
};
test("real Git inventory groups two linked worktrees under one repository", async () => {
  const graph = await scan();
  assert.equal(graph.nodes.filter((n) => n.kind === "repository").length, 1);
  assert.equal(graph.nodes.filter((n) => n.kind === "worktree").length, 2);
  assert.ok(graph.nodes.some((n) => n.kind === "worktree" && n.dirty > 0));
  assert.equal(graph.modelCalls, 0);
});
test("Markdown links and exact-byte copies become evidenced relationships", async () => {
  const graph = await scan();
  assert.ok(
    graph.edges.some(
      (e) => e.relation === "links to document" && e.confidence === "confirmed",
    ),
  );
  assert.ok(graph.edges.some((e) => e.relation === "identical bytes"));
  assert.ok(
    graph.edges.some(
      (e) => e.relation === "similar title" && e.confidence === "suggested",
    ),
  );
});
test("scratch files keep Git/local status and unknown acceptance", async () => {
  const graph = await scan();
  const scratch = graph.nodes.find((n) => n.path?.endsWith("research.md"));
  assert.equal(scratch.scratchLocation, true);
  assert.equal(scratch.localState, "??");
  assert.equal(scratch.verification, "unknown");
  assert.equal(scratch.integration, "unknown");
});
test("comparison separates ancestry, committed delta, dirty patch and untracked hashes", async () => {
  const graph = await scan(),
    trees = graph.nodes.filter((n) => n.kind === "worktree");
  const left = trees.find((w) => w.path === fixture.main),
    right = trees.find((w) => w.path === fixture.feature);
  const result = await compareWorktrees({ left, right });
  assert.equal(result.leftOnly, 0);
  assert.equal(result.rightOnly, 1);
  assert.ok(result.changedFiles.some((f) => f.includes("docs/retry.md")));
  assert.match(result.right.patch, /Local uncommitted experiment/);
  assert.ok(
    result.left.untracked.some((f) => f.path === "work/research.md" && f.hash),
  );
  assert.equal(result.modelCalls, 0);
});
test("comparison refuses a stale head rather than comparing a different branch revision", async () => {
  const graph = await scan(),
    trees = graph.nodes.filter((n) => n.kind === "worktree");
  await assert.rejects(
    compareWorktrees({
      left: { ...trees[0], head: "0".repeat(40) },
      right: trees[1],
    }),
    /head changed/,
  );
});
test("metadata-only scan does not read Markdown content or generate hashes", async () => {
  const graph = await scanWorkspace({
    scope: {
      host: "local",
      filesGrant: true,
      contentGrant: false,
      roots: [fixture.root],
    },
  });
  assert.ok(
    graph.nodes
      .filter((n) => n.kind === "document")
      .every((n) => !n.hash && n.contentIndexed === false),
  );
  const trees = graph.nodes.filter((n) => n.kind === "worktree");
  await assert.rejects(
    compareWorktrees({ left: trees[0], right: trees[1] }),
    /Grant read-only/,
  );
});
test("exclusions and sensitive paths are not indexed", async () => {
  const excluded = join(fixture.root, "excluded");
  mkdirSync(excluded, { recursive: true });
  writeFileSync(join(excluded, "private.md"), "do not index");
  writeFileSync(join(fixture.main, "credentials.md"), "do not index");
  const graph = await scanWorkspace({
    scope: {
      host: "local",
      filesGrant: true,
      contentGrant: true,
      roots: [fixture.root],
      exclusions: [excluded],
    },
  });
  assert.ok(
    !graph.nodes.some(
      (n) => n.path?.startsWith(excluded) || n.path?.endsWith("credentials.md"),
    ),
  );
  assert.equal(
    scopePathExcluded("/home/x/patent-foundations/file.md", "remote"),
    true,
  );
});
test("scan limits are explicit rather than a false complete census", async () => {
  const graph = await scanWorkspace({
    maxFiles: 1,
    scope: {
      host: "local",
      filesGrant: true,
      contentGrant: true,
      roots: [fixture.root],
    },
  });
  assert.equal(graph.complete, false);
  assert.ok(graph.coverage.limits.length);
});
test("cancelled filesystem scans reject without modifying repository state", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    scanWorkspace({
      signal: controller.signal,
      scope: { filesGrant: true, roots: [fixture.root] },
    }),
    /cancelled/,
  );
  const status = execFileSync(
    "git",
    ["-C", fixture.feature, "status", "--porcelain"],
    { encoding: "utf8" },
  );
  assert.match(status, /README.md/);
});
test("worktree parser preserves spaced paths, locks and detached state", () => {
  const rows = parseWorktrees(
    "worktree /tmp/a path\0HEAD " +
      "a".repeat(40) +
      "\0detached\0locked in use\0\0",
  );
  assert.equal(rows[0].path, "/tmp/a path");
  assert.equal(rows[0].locked, "in use");
  assert.equal(rows[0].branch, null);
});
test("remote URLs do not disclose embedded credentials or token query strings", () => {
  assert.equal(
    safeRemote("https://user:password@example.com/org/repo.git?token=hidden"),
    "https://example.com/org/repo",
  );
});
test("broad local lookup derives grants; explicit revocation still refuses retrieval", async () => {
  const e = rootEngine();
  await loadWorkspaceFixture(e);
  const source = e.catalog.find((s) => s.id === "sample-codex-old"),
    target = e.catalog.find((s) => s.id === "sample-claude-new");
  const f = await e.retrieve({ sourceId: source.id, requesterId: target.id });
  assert.equal(f.handoff.relation, "cross-tool");
  e.grant(source.id, { content: false });
  await assert.rejects(
    e.retrieve({ sourceId: source.id, requesterId: target.id }),
    /grants required/,
  );
});
test("scope revocation hides cached map and invalidates connector capabilities", async () => {
  const e = rootEngine();
  await loadWorkspaceFixture(e);
  const c = e.issueConnector("sample-codex-new");
  e.workspace.revoke();
  assert.equal(e.workspace.view().nodes.length, 0);
  assert.throws(() => e.connector(c.token), /scope no longer/);
});
test("restart restores only granted derived metadata and marks it stale", async () => {
  const e = rootEngine();
  await loadWorkspaceFixture(e);
  const restarted = new Engine(new Store(e.store.root), e.fabric);
  assert.equal(restarted.workspace.summary().stale, true);
  assert.equal(restarted.catalog.length, 4);
  assert.equal(restarted.cache.size, 0);
  assert.equal(restarted.modelCalls, 0);
});
test("broad metadata policy does not automatically grant transcript access", async () => {
  const e = rootEngine();
  await loadWorkspaceFixture(e);
  e.workspace.index.profile.policy = "metadata";
  assert.equal(e.permissions(e.session("sample-codex-old")).content, undefined);
  await assert.rejects(e.finding("sample-codex-old"), /content grant/);
});
test("matching native cwd links sessions to the correct worktree", async () => {
  const graph = await scan();
  const mapped = mapSessions(graph, [
    {
      id: "one",
      host: "local",
      cwd: fixture.feature,
      provider: "codex",
      title: "Fixture",
      nativeThreadId: "one",
    },
  ]);
  const edge = mapped.edges.find(
    (e) => e.from === "session:one" && e.relation === "native cwd in worktree",
  );
  assert.equal(
    mapped.nodes.find((n) => n.id === edge.to).path,
    fixture.feature,
  );
});

test("observed parent directory aliases retain canonical worktree identity and exclusions", async t => {
  const created = createWorkspaceFixture(), actualRoot = realpathSync.native(created.root), parent = mkdtempSync(join(realpathSync.native(tmpdir()), "as-alias-parent-"));
  t.after(() => { rmSync(parent, { recursive: true, force: true }); rmSync(actualRoot, { recursive: true, force: true }); });
  const link = join(parent, "alias"), aliasRoot = join(link, basename(actualRoot));
  symlinkSync(dirname(actualRoot), link, process.platform === "win32" ? "junction" : "dir");
  const excluded = join(actualRoot, "adapter-worktree", "hidden-research");
  mkdirSync(excluded); writeFileSync(join(excluded, "notes.md"), "EXCLUDED-FIXTURE-TEXT");
  const graph = await scanWorkspace({ scope: { host: "local", filesGrant: true, contentGrant: true, roots: [aliasRoot], automaticRoots: false,
    exclusions: [join(aliasRoot, "adapter-worktree", "hidden-research")] } });
  const main = graph.nodes.find(node => node.kind === "worktree" && normalizePath(node.path) === normalizePath(realpathSync.native(created.main)));
  const feature = graph.nodes.find(node => node.kind === "worktree" && normalizePath(node.path) === normalizePath(realpathSync.native(created.feature)));
  assert(main.readAllowed && feature.readAllowed); assert.equal(feature.comparisonAllowed, false);
  assert(!graph.nodes.some(node => node.path === join(excluded, "notes.md")));
  const mapped = mapSessions(graph, [{ id: "aliased-native", host: "local", cwd: join(aliasRoot, "adapter-worktree"), provider: "codex", nativeThreadId: "aliased-native", title: "Alias fixture" }]);
  assert(mapped.edges.some(edge => edge.from === "session:aliased-native" && edge.to === feature.id && edge.relation === "native cwd in worktree"));
  await assert.rejects(compareWorktrees({ left: main, right: feature }), /excluded descendants/);
  const directLink = await scanWorkspace({ scope: { host: "local", filesGrant: true, contentGrant: true, roots: [link], automaticRoots: false } });
  assert.equal(directLink.nodes.filter(node => node.kind !== "host").length, 0);
  assert(directLink.coverage.symlinksSkipped >= 1, "a directly linked scope root remains refused");
});

test("a redirected granted parent alias refuses cached comparisons and artifact bytes", async t => {
  const created = createWorkspaceFixture(), actualRoot = realpathSync.native(created.root), parent = mkdtempSync(join(realpathSync.native(tmpdir()), "as-alias-drift-"));
  t.after(() => { rmSync(parent, { recursive: true, force: true }); rmSync(actualRoot, { recursive: true, force: true }); });
  const link = join(parent, "alias"), aliasRoot = join(link, basename(actualRoot));
  symlinkSync(dirname(actualRoot), link, process.platform === "win32" ? "junction" : "dir");
  const graph = await scanWorkspace({ scope: { host: "local", filesGrant: true, contentGrant: true, roots: [aliasRoot], automaticRoots: false } });
  const trees = graph.nodes.filter(node => node.kind === "worktree"), document = graph.nodes.find(node => node.kind === "document" && node.path.endsWith("README.md"));
  assert.equal((await compareWorktrees({ left: trees[0], right: trees[1] })).modelCalls, 0);
  assert((await inspectWorkspaceFile({ node: document })).text);
  const other = join(parent, "other"); mkdirSync(join(other, basename(actualRoot)), { recursive: true });
  rmSync(link, { recursive: true, force: true }); symlinkSync(other, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(compareWorktrees({ left: trees[0], right: trees[1] }), /root alias changed/);
  await assert.rejects(inspectWorkspaceFile({ node: document }), /root alias changed/);
});

test("new exclusions under a granted alias apply to cached canonical file paths", async t => {
  const created = createWorkspaceFixture(), actualRoot = realpathSync.native(created.root), parent = mkdtempSync(join(realpathSync.native(tmpdir()), "as-alias-exclusion-"));
  t.after(() => { rmSync(parent, { recursive: true, force: true }); rmSync(actualRoot, { recursive: true, force: true }); });
  const link = join(parent, "alias"), aliasRoot = join(link, basename(actualRoot));
  symlinkSync(dirname(actualRoot), link, process.platform === "win32" ? "junction" : "dir");
  const graph = await scanWorkspace({ scope: { host: "local", filesGrant: true, contentGrant: true, roots: [aliasRoot], automaticRoots: false } });
  const engine = rootEngine();
  engine.workspace.index = { ...graph, schema: 1, sessions: [], profile: { active: true, indexFiles: true,
    exclusions: { local: [join(aliasRoot, "research-repo", "docs")] } } };
  const document = graph.nodes.find(node => node.kind === "document" && normalizePath(node.path) === normalizePath(join(realpathSync.native(created.main), "docs", "architecture.md")));
  await assert.rejects(engine.workspace.inspect({ nodeId: document.id }), /outside workspace scope/);
  const trees = graph.nodes.filter(node => node.kind === "worktree");
  await assert.rejects(engine.workspace.compare({ leftId: trees[0].id, rightId: trees[1].id }), /excluded worktree paths/);
});
test("workspace cache corruption can be rebuilt rather than becoming authority", () => {
  const e = rootEngine();
  writeFileSync(join(e.store.root, "workspace-index.json"), "broken");
  const map = new WorkspaceMap(e);
  assert.equal(map.index, null);
  assert.match(map.cacheError, /rebuild/i);
});
test("line-ending-normalized text equality never becomes byte identity", async () => {
  writeFileSync(
    join(fixture.main, "docs", "eol-a.md"),
    "# Endings\n\nSame text.\n",
  );
  writeFileSync(
    join(fixture.main, "docs", "eol-b.md"),
    "# Endings\r\n\r\nSame text.\r\n",
  );
  const graph = await scan();
  const a = graph.nodes.find((n) => n.path?.endsWith("eol-a.md")),
    b = graph.nodes.find((n) => n.path?.endsWith("eol-b.md"));
  assert.notEqual(a.hash, b.hash);
  assert.equal(a.normalizedTextHash, b.normalizedTextHash);
  assert.ok(
    graph.edges.some((e) => e.relation === "same text, different line endings"),
  );
});
test("credential exclusions do not hide unrelated OAuth research documents", () => {
  assert.equal(sensitiveFileName("credentials.md"), true);
  assert.equal(sensitiveFileName("auth.json"), true);
  assert.equal(sensitiveFileName("my-private.pem"), true);
  assert.equal(sensitiveFileName("oauth-research.md"), false);
});
test("bare stores are discovered as repositories without fictional working trees", async () => {
  const root = mkdtempSync(join(tmpdir(), "as-bare-")),
    bare = join(root, "mirror.git");
  execFileSync("git", ["init", "--bare", bare], { stdio: "pipe" });
  const graph = await scanWorkspace({
    scope: { filesGrant: true, contentGrant: true, roots: [root] },
  });
  assert.equal(graph.nodes.filter((n) => n.kind === "repository").length, 1);
  assert.equal(graph.nodes.filter((n) => n.kind === "worktree").length, 0);
});
test("malformed derived cache schema cannot restore grants or native metadata", () => {
  const e = rootEngine();
  writeFileSync(
    join(e.store.root, "workspace-index.json"),
    JSON.stringify({ schema: 1, profile: { active: true }, nodes: "invalid" }),
  );
  const map = new WorkspaceMap(e);
  assert.equal(map.index, null);
  assert.equal(map.view().nodes.length, 0);
});
test("filesystem continuation eventually reaches later files while retaining earlier nodes", async () => {
  const scope = {
    host: "local",
    filesGrant: true,
    contentGrant: true,
    roots: [fixture.root],
    automaticRoots: false,
  };
  let graph = await scanWorkspace({ scope, maxFiles: 1 });
  assert.ok(graph.cursor);
  const first = graph.nodes.find((n) => n.kind === "document").id;
  let batches = 1;
  while (graph.cursor && batches < 25) {
    graph = await scanWorkspace({
      scope,
      maxFiles: 1,
      cursor: graph.cursor,
      previous: graph,
    });
    batches++;
  }
  assert.equal(graph.cursor, null);
  assert.ok(graph.nodes.some((n) => n.id === first));
  assert.ok(graph.nodes.some((n) => n.path?.endsWith("research.md")));
  assert.equal(new Set(graph.nodes.map((n) => n.id)).size, graph.nodes.length);
  assert.ok(batches > 1);
});
