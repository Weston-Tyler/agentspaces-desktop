import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { NativeTerminals, terminalLaunch } from "../app/native-terminal.mjs";

function fixture() {
  const children = [];
  const terms = new NativeTerminals({ spawnProcess: (...argv) => {
    const child = new EventEmitter(); child.messages = []; child.argv = argv;
    child.send = message => { child.messages.push(message); if (message.type === "start") queueMicrotask(() => child.emit("message", { type: "ready" })); };
    child.kill = () => child.emit("exit", 0); children.push(child); return child;
  } });
  return { terms, children };
}
test("native launch preserves interactive defaults and shell-quotes remote cwd/args", () => {
  assert.deepEqual(terminalLaunch({ provider: "claude" }).args, []);
  assert.deepEqual(terminalLaunch({ provider: "codex", intent: "login" }).args, ["login"]);
  const remote = terminalLaunch({ provider: "codex", host: "remote", cwd: "/tmp/a'b;touch bad" }, ["--resume", "source'uuid"]);
  assert.equal(remote.file, process.platform === "win32" ? "ssh.exe" : "ssh"); assert.deepEqual(remote.args.slice(0, 2), ["-tt", "remote"]);
  assert(remote.args[2].includes("'\\''"));
  assert.throws(() => terminalLaunch({ provider: "other" }), /Unsupported/);
  assert.throws(() => terminalLaunch({ provider: "codex", host: "evil" }), /Unsupported/);
  assert.throws(() => terminalLaunch({ provider: "codex", cwd: "relative" }), /absolute/);
  assert.throws(() => terminalLaunch({ provider: "claude" }, ["--dangerously-skip-permissions"]), /interactive/);
});
test("isolated Node worker has no stdout/stderr logs; metadata contains no terminal content", async t => {
  const { terms, children } = fixture(); t.after(() => terms.closeAll());
  const meta = await terms.create({ provider: "codex" });
  assert.equal(meta.status, "running"); assert.equal(children[0].argv[2].shell, false);
  assert.deepEqual(children[0].argv[2].stdio, ["ignore", "ignore", "ignore", "ipc"]);
  children[0].emit("message", { type: "data", data: "PRIVATE_TERMINAL_TEXT" });
  assert(!JSON.stringify(terms.list()).includes("PRIVATE_TERMINAL_TEXT"));
  let received = "";
  const detach = terms.attach(meta.id, { onData: data => received += data, onExit() {} });
  assert.equal(received, "PRIVATE_TERMINAL_TEXT");
  assert.throws(() => terms.attach(meta.id, { onData() {}, onExit() {} }), /attached/);
  terms.write(meta.id, "user-owned-input"); terms.resize(meta.id, 120, 40);
  assert.equal(children[0].messages.at(-2).type, "input");
  assert.equal(children[0].messages.at(-1).type, "resize");
  detach(); assert.equal(terms.get(meta.id).status, "closed");
});
test("terminal count, caller args, input and dimensions are bounded", async t => {
  const { terms } = fixture(); t.after(() => terms.closeAll());
  const first = await terms.create({ provider: "codex" });
  await terms.create({ provider: "claude" }); await terms.create({ provider: "codex", host: "remote" });
  await assert.rejects(terms.create({ provider: "codex" }), /Three/);
  assert.throws(() => terms.write(first.id, "x".repeat(8193)), /8192/);
  assert.throws(() => terms.resize(first.id, 10000, 24), /dimensions/);
  terms.closeAll();
  await assert.rejects(terms.create({ provider: "codex", launchArgs: ["arbitrary prompt"] }), /internal/);
});
test("ephemeral pre-attachment output stays bounded and disappears on close", async t => {
  const { terms, children } = fixture(); t.after(() => terms.closeAll());
  const meta = await terms.create({ provider: "codex" });
  for (let i = 0; i < 80; i++) children[0].emit("message", { type: "data", data: "界".repeat(2730) });
  let bytes = 0; terms.attach(meta.id, { onData: data => { bytes += Buffer.byteLength(data); }, onExit() {} });
  assert(bytes <= 256 * 1024);
  terms.close(meta.id); assert.throws(() => terms.write(meta.id, "input"), /closed/);
});
test("worker failure exposes a generic code and never the native error stream", async () => {
  const { terms, children } = fixture();
  const meta = await terms.create({ provider: "codex" }); let event;
  terms.attach(meta.id, { onData() {}, onExit: value => event = value });
  children[0].emit("message", { type: "error", code: "PRIVATE_ERROR_DETAIL" });
  assert.equal(event.code, "native_terminal_failed"); assert.equal(terms.get(meta.id).status, "failed");
});
test("prepared connection resolver is internal, validated and supports only loopback SSH reverse forwarding", async t => {
  const { children } = fixture(); let observed;
  const terms = new NativeTerminals({ spawnProcess: (...argv) => {
    const child = new EventEmitter(); child.messages = []; child.argv = argv;
    child.send = message => { child.messages.push(message); if (message.type === "start") queueMicrotask(() => child.emit("message", { type: "ready" })); };
    child.kill = () => child.emit("exit", 0); children.push(child); return child;
  }, resolveLaunch: async options => { observed = options; return { args: ["--resume", "native-source-id"],
    sshOptions: ["-o", "ExitOnForwardFailure=yes", "-R", "127.0.0.1:43145:127.0.0.1:43127"] }; } });
  t.after(() => terms.closeAll());
  const connectionId = "11111111-2222-3333-4444-555555555555";
  const meta = await terms.create({ provider: "claude", host: "remote", connectionId });
  assert.equal(observed.connectionId, connectionId); assert.equal(meta.connectionId, connectionId);
  assert(children[0].messages[0].launch.args.includes("127.0.0.1:43145:127.0.0.1:43127"));
  await assert.rejects(terms.create({ provider: "claude", connectionId: "shell;command" }), /identifier/);
  assert.throws(() => terminalLaunch({ provider: "claude", host: "remote" }, [], ["-R", "0.0.0.0:3:evil:4"]), /loopback/);
});
