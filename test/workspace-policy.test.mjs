import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../app/store.mjs";
import { Engine } from "../app/engine.mjs";
import { FabricAdapter } from "../app/fabric.mjs";
import { WorkspaceMap } from "../app/workspace-map.mjs";
import { loadWorkspaceFixture } from "../app/workspace-fixture.mjs";
import { readSdk } from "../app/claude-reader.mjs";
const make = () => {
  const root = mkdtempSync(join(tmpdir(), "as-wide-policy-"));
  return new Engine(new Store(root), new FabricAdapter({ stateRoot: root }));
};
function configure(e, { repeat = false, fail = false } = {}) {
  const calls = [];
  e.probe = async (host) => {
    e.tools = e.tools
      .filter((t) => t.host !== host)
      .concat([
        { provider: "codex", host, versionMatches: true },
        { provider: "claude", host, versionMatches: true },
      ]);
  };
  e.nativeFactory = ({ host, provider }) => ({
    open: async () => {},
    close: () => {},
    discover: async (p, archived, cursor) => {
      calls.push({ host, provider, archived, cursor, all: p.allMetadataGrant });
      if (fail) throw new Error("Disconnected");
      return {
        sessions: [
          {
            id: host + provider + archived + (cursor ?? "0"),
            provider,
            host,
            cwd: host === "remote" ? "/tmp/allowed" : process.cwd(),
            title: "Research",
            sourceVersion: "1",
            updatedAt: "2026-10-08",
            topics: [],
            status: "unknown",
          },
        ],
        nextCursor: repeat ? "same" : cursor === null ? "next" : null,
      };
    },
  });
  e.workspace = new WorkspaceMap(e, {
    adapterFactory: (host) => ({
      close: () => {},
      scan: async () => ({
        nodes: [{ id: "host:" + host, kind: "host", host, title: host }],
        edges: [],
        coverage: { limits: [] },
      }),
    }),
  });
  return calls;
}
const scope = {
  hosts: ["local", "remote"],
  providers: ["codex", "claude"],
  account: "private",
  policy: "metadata",
  indexFiles: false,
  roots: {},
  exclusions: {},
};
test("connect-everything reads supported catalogs, both Codex archive states and all older pages", async () => {
  const e = make(),
    calls = configure(e);
  await e.workspace.scan(scope);
  assert.equal(calls.length, 12);
  assert.ok(calls.every((c) => c.all === true));
  assert.equal(e.workspace.index.sessions.length, 12);
  assert.equal(e.modelCalls, 0);
});
test("a repeated native cursor terminates visibly without discarding discovered older work", async () => {
  const e = make();
  configure(e, { repeat: true });
  await e.workspace.scan({ ...scope, hosts: ["local"], providers: ["claude"] });
  assert.equal(e.workspace.index.sessions.length, 2);
  assert.ok(e.workspace.index.errors.length > 0);
  assert.equal(e.workspace.summary().hasMore, true);
});
test("unavailable providers do not trigger raw transcript or inference fallback", async () => {
  const e = make();
  configure(e, { fail: true });
  await e.workspace.scan(scope);
  assert.equal(e.workspace.index.sessions.length, 0);
  assert.ok(
    e.workspace.index.errors.every((err) =>
      err.reason.includes("no inference"),
    ),
  );
  assert.equal(e.cache.size, 0);
});
test("host-specific exclusions remove native metadata before index persistence", async () => {
  const e = make();
  configure(e);
  await e.workspace.scan({
    ...scope,
    hosts: ["remote"],
    providers: ["claude"],
    exclusions: { remote: ["/tmp"] },
  });
  assert.equal(e.workspace.index.sessions.length, 0);
  assert.ok(!readFileSync(e.workspace.path, "utf8").includes("Research"));
});
test("cancellation preserves the previous map and does not commit partial replacement", async () => {
  const e = make();
  await loadWorkspaceFixture(e);
  const prior = e.workspace.index;
  let resume;
  e.probe = () => new Promise((r) => (resume = r));
  const pending = e.workspace.scan(scope);
  await new Promise((r) => setImmediate(r));
  e.workspace.cancel();
  resume();
  await assert.rejects(pending, /cancelled/i);
  assert.equal(e.workspace.index, prior);
});
test("scope default permissions are not accidentally promoted into permanent per-session grants", async () => {
  const e = make();
  await loadWorkspaceFixture(e);
  e.grant("sample-codex-new", { retrieve: false });
  e.workspace.index.profile.policy = "metadata";
  assert.equal(e.permissions(e.session("sample-codex-new")).content, undefined);
  assert.equal(e.permissions(e.session("sample-codex-new")).retrieve, false);
});
test("changed indexed bytes are refused before artifact return", async () => {
  const e = make();
  await loadWorkspaceFixture(e);
  const doc = e.workspace.index.nodes.find(
    (n) => n.kind === "document" && n.hash,
  );
  writeFileSync(doc.path, "changed");
  await assert.rejects(e.workspace.inspect({ nodeId: doc.id }), /changed/);
});
test("Claude all-metadata discovery omits dir while preserving bounded title metadata", async () => {
  let options;
  const sdk = {
    listSessions: async (o) => {
      options = o;
      return [
        { sessionId: "1", cwd: "/project/a", summary: "A", lastModified: 10 },
        { sessionId: "2", cwd: "/project/b", summary: "B", lastModified: 20 },
      ];
    },
  };
  const result = await readSdk(
    {
      action: "list",
      project: {
        metadataGrant: true,
        allMetadataGrant: true,
        host: "remote",
        account: "private",
        id: "scope",
      },
    },
    sdk,
  );
  assert.equal(options.dir, undefined);
  assert.equal(result.sessions.length, 2);
  assert.equal(result.sessions[0].cwd, "/project/a");
});
test("native rows with no working directory remain discoverable but do not gain content rights", async () => {
  const e = make();
  configure(e);
  e.nativeFactory = ({ host, provider }) => ({
    open: async () => {},
    close: () => {},
    discover: async () => ({
      sessions: [
        {
          id: "location-unknown",
          nativeThreadId: "location-unknown",
          host,
          provider,
          title: "Forgotten native session",
          updatedAt: "2026-10-08",
          topics: [],
          status: "unknown",
        },
      ],
      nextCursor: null,
    }),
  });
  await e.workspace.scan({
    ...scope,
    hosts: ["local"],
    providers: ["claude"],
    policy: "local-retrieval",
  });
  assert.equal(e.workspace.index.sessions.length, 1);
  const session = e.session("claude@local:location-unknown");
  assert.equal(e.permissions(session).content, false);
  assert.ok(
    e.workspace.index.edges.some(
      (edge) => edge.relation === "native location unknown",
    ),
  );
});
