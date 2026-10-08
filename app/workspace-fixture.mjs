import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { scanWorkspace } from "./workspace-reader.mjs";
import { mapSessions } from "./workspace-map.mjs";
export function createWorkspaceFixture() {
  const root = mkdtempSync(join(tmpdir(), "as-workspace-fixture-")),
    main = join(root, "research-repo"),
    feature = join(root, "adapter-worktree");
  mkdirSync(join(main, "docs"), { recursive: true });
  const git = (cwd, ...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=" + join(root, "no-hooks"),
        "-c",
        "commit.gpgsign=false",
        "-c",
        "init.templateDir=" + join(root, "empty-template"),
        "-C",
        cwd,
        ...args,
      ],
      { windowsHide: true, stdio: "pipe" },
    );
  git(main, "init", "-b", "main");
  git(main, "config", "user.name", "Fixture");
  git(main, "config", "user.email", "fixture@example.invalid");
  git(main, "config", "core.autocrlf", "false");
  writeFileSync(
    join(main, "README.md"),
    "# Research client\n\nSee [Architecture](docs/architecture.md), [Retry notes](docs/retry.md), and [scratch research](work/research.md).\n\nSynthetic workspace fixture.\n",
  );
  writeFileSync(
    join(main, "docs", "architecture.md"),
    "# Architecture\n\n[Return to README](../README.md)\n\nSynthetic shared foundation. This document is not acceptance evidence.\n",
  );
  writeFileSync(
    join(main, "docs", "retry.md"),
    "# Retry decisions\n\nRetain operation identifiers before retrying.\n",
  );
  git(main, "add", ".");
  git(main, "commit", "-m", "Add synthetic research foundation");
  git(main, "worktree", "add", "-b", "adapter-experiment", feature);
  writeFileSync(
    join(feature, "docs", "retry.md"),
    "# Retry decisions\n\nRetain operation identifiers and reconcile lost acknowledgements before retrying.\n",
  );
  git(feature, "add", "docs/retry.md");
  git(feature, "commit", "-m", "Add synthetic acknowledgement reconciliation");
  mkdirSync(join(main, "work"), { recursive: true });
  mkdirSync(join(feature, "work"), { recursive: true });
  writeFileSync(
    join(main, "work", "research.md"),
    "# Research scratch\n\n[Retry reference](../docs/retry.md)\n\nCandidate notes only. Never accepted merely because they exist.\n",
  );
  writeFileSync(
    join(feature, "work", "research-copy.md"),
    "# Research scratch\n\n[Retry reference](../docs/retry.md)\n\nCandidate notes only. Never accepted merely because they exist.\n",
  );
  writeFileSync(
    join(main, "work", "timings.csv"),
    "operation,millis\nsynthetic-a,3\n",
  );
  writeFileSync(
    join(feature, "README.md"),
    "# Research client\n\nLocal uncommitted experiment; synthetic fixture.\n",
  );
  return { root, main, feature };
}
export async function loadWorkspaceFixture(engine) {
  if (engine.workspace.running)
    throw new Error("Cancel the active inventory before loading a fixture");
  const fixture = createWorkspaceFixture();
  engine.loadSample();
  const profile = {
    id: "workspace-fixture",
    hosts: ["local"],
    providers: ["codex", "claude"],
    account: "sample-private",
    policy: "local-retrieval",
    indexFiles: true,
    roots: { local: [fixture.root] },
    exclusions: {},
    active: true,
  };
  const sessions = engine.catalog
    .filter((s) => s.project === "sample-research")
    .map((s, i) => ({
      ...s,
      host: "local",
      cwd: i === 1 ? fixture.feature : fixture.main,
      scopeId: profile.id,
      nativeThreadId: s.id,
    }));
  const graph = await scanWorkspace({
    scope: {
      host: "local",
      filesGrant: true,
      contentGrant: true,
      roots: [fixture.root],
      automaticRoots: false,
    },
  });
  engine.workspace.index = {
    ...mapSessions(graph, sessions),
    profile,
    fixture: true,
    coverage: [{ host: "local", ...graph.coverage }],
    errors: [],
    cursors: {},
    stale: false,
  };
  engine.workspace.restore(sessions);
  engine.workspace.save();
  engine.mode = "fixture";
  engine.store.audit("Synthetic workspace map loaded", {
    repositories: 1,
    worktrees: 2,
    modelCalls: 0,
  });
  return engine.workspace.summary();
}
