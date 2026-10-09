import test from "node:test";
import assert from "node:assert/strict";
import { readSdk } from "../app/claude-reader.mjs";
import { ClaudeReadAdapter, CLAUDE_SDK_PIN } from "../app/claude-adapter.mjs";
import { dependencyVersions } from "../app/dependency-versions.mjs";
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const p = {
  id: "research",
  path: process.cwd(),
  account: "private",
  host: "local",
  metadataGrant: true,
};

test('remote Claude metadata uses the installed pinned read SDK and injected SSH transport', async () => {
  let source = '', launches = 0;
  const adapter = new ClaudeReadAdapter({ host: 'remote', spawnProcess: (command, args) => {
    launches++; assert.equal(command, 'ssh'); assert.equal(args[0], 'remote');
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
    child.stdin.on('data', chunk => source += chunk);
    child.stdin.on('finish', () => setImmediate(() => { child.stdout.end(JSON.stringify({ sessions: [], nextCursor: null })); child.emit('close', 0); }));
    return child;
  } });
  const result = await adapter.discover({ ...p, host: 'remote', path: '/fictional/project' });
  assert.equal(launches, 1); assert.deepEqual(result.sessions, []);
  assert.match(source, /homedir\(\)/); assert.match(source, /\.agentspaces-desktop-native/); assert.ok(source.includes(JSON.stringify(CLAUDE_SDK_PIN))); assert.equal(CLAUDE_SDK_PIN, dependencyVersions().claude);
  assert.doesNotMatch(source, /\/tmp\/agentspaces-desktop-sdk|sdk\.query\(/); adapter.close();
});
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
