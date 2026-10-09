import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { CodexReadAdapter, openNativeSignIn } from "../app/native.mjs";
const path = process.cwd();
function adapterFactory(handler) {
  const calls = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit("exit");
  child.stdin = new Writable({
    write(chunk, _enc, next) {
      const request = JSON.parse(chunk.toString());
      calls.push(request);
      if (request.id)
        setImmediate(() =>
          child.stdout.write(
            JSON.stringify({
              id: request.id,
              result: request.method === "initialize" ? {} : handler(request),
            }) + "\n",
          ),
        );
      next();
    },
  });
  return {
    adapter: new CodexReadAdapter({ spawnProcess: () => child }),
    calls,
    child,
  };
}
test("native metadata adapter strips transcript preview and checks project path", async () => {
  const { adapter, calls } = adapterFactory(() => ({
    data: [
      {
        id: "native-one",
        name: "Known research",
        preview: "PRIVATE CONTENT",
        cwd: path,
        updatedAt: 100,
        status: { type: "idle" },
      },
      {
        id: "native-wrong",
        name: "Private project",
        cwd: path + "/other",
        updatedAt: 101,
      },
    ],
    nextCursor: "cursor-next",
  }));
  try {
    await adapter.open();
    const result = await adapter.discover(
      { id: "project", path, account: "private", metadataGrant: true },
      true,
    );
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].preview, undefined);
    assert.equal(result.nextCursor, "cursor-next");
    assert.ok(
      !calls.some((c) =>
        ["thread/resume", "turn/start", "thread/read"].includes(c.method),
      ),
    );
  } finally {
    adapter.close();
  }
});
test("native content adapter refuses a returned foreign project", async () => {
  const { adapter } = adapterFactory(() => ({
    thread: { cwd: path + "/other", turns: [] },
  }));
  try {
    await adapter.open();
    await assert.rejects(
      adapter.read(
        { id: "native", project: "p" },
        { id: "p", path, metadataGrant: true },
      ),
      /mismatch/,
    );
  } finally {
    adapter.close();
  }
});
test("native read boundary prohibits execution and inject methods", async () => {
  const { adapter } = adapterFactory(() => ({}));
  try {
    await adapter.open();
    assert.throws(() => adapter.rpc("turn/start", {}), /refuses/);
    assert.throws(() => adapter.rpc("thread/resume", {}), /refuses/);
    assert.throws(() => adapter.rpc("thread/inject_items", {}), /refuses/);
  } finally {
    adapter.close();
  }
});
test("native disconnect rejects pending calls without retry", async () => {
  const { adapter, child } = adapterFactory(() => ({}));
  await adapter.open();
  child.stdin = new Writable({
    write(_c, _e, next) {
      next();
    },
  });
  const pending = adapter.rpc("thread/list", {});
  child.emit("exit");
  await assert.rejects(pending, /closed/);
});
test("sign-in launcher rejects arbitrary providers and SSH hosts before launching a terminal", () => {
  assert.throws(
    () => openNativeSignIn("codex; arbitrary", "local"),
    /Unsupported|qualified/,
  );
  assert.throws(
    () => openNativeSignIn("codex", "unapproved-host"),
    /Unsupported|qualified/,
  );
});
test("remote Codex adapter uses SSH stdio and Linux path semantics", async () => {
  const data = adapterFactory(() => ({
    data: [
      { id: "linux-id", cwd: "/tmp/project/", name: "Research", updatedAt: 10 },
    ],
    nextCursor: null,
  }));
  let command, args;
  const adapter = new CodexReadAdapter({
    host: "remote",
    spawnProcess: (c, a) => {
      command = c;
      args = a;
      return data.child;
    },
  });
  try {
    await adapter.open();
    const result = await adapter.discover(
      {
        id: "p",
        path: "/tmp/project",
        account: "private",
        metadataGrant: true,
      },
      false,
    );
    assert.equal(command, "ssh");
    assert.deepEqual(args, ["remote", "codex", "app-server", "--stdio"]);
    assert.equal(result.sessions[0].host, "remote");
  } finally {
    adapter.close();
  }
});
