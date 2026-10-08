import test from "node:test";
import assert from "node:assert/strict";
import { readSdk } from "../app/claude-reader.mjs";
import { ClaudeReadAdapter } from "../app/claude-adapter.mjs";
const p = {
  id: "research",
  path: process.cwd(),
  account: "private",
  host: "local",
  metadataGrant: true,
};
test("Claude metadata uses explicit directory, no worktree widening and no inference APIs", async () => {
  let options;
  const sdk = {
    listSessions: async (o) => {
      options = o;
      return [
        {
          sessionId: "one",
          cwd: p.path,
          summary: "Prior research",
          firstPrompt: "PRIVATE FULL PROMPT",
          lastModified: 100,
        },
        {
          sessionId: "foreign",
          cwd: p.path + "/other",
          summary: "Private",
          lastModified: 200,
        },
      ];
    },
    query: () => {
      throw new Error("No inference");
    },
  };
  const result = await readSdk({ action: "list", project: p }, sdk);
  assert.equal(options.dir, p.path);
  assert.equal(options.includeWorktrees, false);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].firstPrompt, undefined);
  assert.equal(result.sessions[0].status, "unknown");
});
test("Claude rejects an unsupported archived-only claim", async () => {
  await assert.rejects(
    readSdk({ action: "list", project: p, archived: true }, {}),
    /does not expose archive/,
  );
});
test("Claude content checks native cwd before requesting messages", async () => {
  const sdk = {
    getSessionInfo: async () => ({ cwd: p.path + "/other" }),
    getSessionMessages: () => {
      throw new Error("Must not read");
    },
  };
  await assert.rejects(
    readSdk({ action: "read", project: p, session: { id: "one" } }, sdk),
    /mismatch/,
  );
});
test("Claude reads a bounded assistant excerpt without resuming", async () => {
  let options;
  const sdk = {
    getSessionInfo: async () => ({
      cwd: p.path,
      sessionId: "one",
      lastModified: 400,
    }),
    getSessionMessages: async (_id, o) => {
      options = o;
      return [
        {
          type: "user",
          message: { content: [{ type: "text", text: "private prompt" }] },
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Permitted finding" }] },
        },
      ];
    },
  };
  const f = await readSdk(
    { action: "read", project: p, session: { id: "one", title: "Research" } },
    sdk,
  );
  assert.equal(f.artifact.text, "Permitted finding");
  assert.equal(options.limit, 32);
  assert.equal(options.includeSystemMessages, false);
});
test("Claude helper refuses missing metadata grant and execution actions", async () => {
  await assert.rejects(
    readSdk({ action: "list", project: { ...p, metadataGrant: false } }, {}),
    /grant/,
  );
  await assert.rejects(readSdk({ action: "query", project: p }, {}), /refuses/);
});
test("Claude adapter uses injected supported SDK without spawning a model", async () => {
  const adapter = new ClaudeReadAdapter({
    sdkLoader: async () => ({ listSessions: async () => [] }),
  });
  assert.equal((await adapter.discover(p)).sessions.length, 0);
  adapter.close();
});
