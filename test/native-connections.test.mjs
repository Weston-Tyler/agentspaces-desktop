import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { NativeConnections, installChannelAssets } from "../app/native-connections.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "agentspaces-native-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = { id: "native-reference", nativeThreadId: "00000000-0000-4000-8000-000000000001", provider: "claude", host: "local", cwd: root, status: "dormant", fixture: false, account: "own-account", project: "own-project" };
  const grant = { enrolled: true, content: true, share: true, retrieve: true }, store = { data: { connectors: {} }, save() {} };
  let issued = 0;
  const engine = { store, session: () => source, permissions: () => grant, target: () => ({ path: root }), issueConnector: () => { issued++; const token = "synthetic-app-capability-" + issued; store.data.connectors[createHash("sha256").update(token).digest("hex")] = { sessionId: source.id }; return { token }; } };
  return { root, source, grant, store, engine, issued: () => issued, connections: new NativeConnections(engine, { root, address: "http://127.0.0.1:43127" }) };
}
test("source grants and active native owner refuse before issuing capability or writing config", async t => {
  const f = fixture(t); f.grant.share = false;
  await assert.rejects(f.connections.prepare({ sessionId: f.source.id }), /grant/);
  f.grant.share = true; f.source.status = "current";
  await assert.rejects(f.connections.prepare({ sessionId: f.source.id }), /active/);
  f.source.status = "dormant"; f.source.fixture = true;
  await assert.rejects(f.connections.prepare({ sessionId: f.source.id }), /native Claude/);
  f.source.fixture = false; f.source.host = "unsupported";
  await assert.rejects(f.connections.prepare({ sessionId: f.source.id }), /host/);
  assert.equal(f.issued(), 0); assert.ok(!existsSync(join(f.root, "native-connections")));
});
test("local preparation preserves native login and configs and exposes no provider credentials", async t => {
  const f = fixture(t); const result = await f.connections.prepare({ sessionId: f.source.id });
  const config = JSON.parse(readFileSync(result.configPath, "utf8")), mcp = config.mcpServers.agentspaces;
  assert.equal(mcp.command, "node");
  assert.equal(mcp.args[0], fileURLToPath(new URL("../app/claude-channel.mjs", import.meta.url)));
  assert.equal(mcp.env.AGENTSPACES_URL, "http://127.0.0.1:43127");
  assert.deepEqual(Object.keys(mcp.env).sort(), ["AGENTSPACES_CONNECTOR_TOKEN", "AGENTSPACES_URL"]);
  assert.ok(!JSON.stringify(result).includes(mcp.env.AGENTSPACES_CONNECTOR_TOKEN));
  const launch = f.connections.resolveLaunch({ connectionId: result.connectionId, provider: "claude", host: "local", cwd: f.root, intent: "chat" });
  assert.ok(launch.args.includes("--resume")); assert.ok(launch.args.includes("--dangerously-load-development-channels"));
  for (const flag of ["--bare", "--print", "--strict-mcp-config", "--dangerously-skip-permissions"]) assert.ok(!launch.args.includes(flag));
});
test("linked existing parent is rejected before token allocation or outside writes", async t => {
  const f = fixture(t), outside = join(f.root, "outside"), state = join(f.root, "owned-state"); mkdirSync(outside); mkdirSync(state);
  symlinkSync(outside, join(state, "native-connections"), process.platform === "win32" ? "junction" : "dir");
  const connections = new NativeConnections(f.engine, { root: state, address: "http://127.0.0.1:43127" });
  await assert.rejects(connections.prepare({ sessionId: f.source.id }), /unlinked/);
  assert.equal(f.issued(), 0); assert.deepEqual(readdirSync(outside), []);
});
test("prepared launch refuses caller tampering, source drift and revoked grants", async t => {
  const f = fixture(t), prepared = await f.connections.prepare({ sessionId: f.source.id });
  const input = { connectionId: prepared.connectionId, provider: "claude", host: "local", cwd: f.root, intent: "chat" };
  assert.throws(() => f.connections.resolveLaunch({ ...input, provider: "codex" }), /match/);
  assert.throws(() => f.connections.resolveLaunch({ ...input, intent: "login" }), /match/);
  f.source.account = "other-account"; assert.throws(() => f.connections.resolveLaunch(input), /changed/);
  f.source.account = "own-account"; f.source.cwd = join(f.root, "another-root"); assert.throws(() => f.connections.resolveLaunch(input), /changed/);
  f.source.cwd = f.root; f.grant.retrieve = false; assert.throws(() => f.connections.resolveLaunch(input), /grant/);
  f.grant.retrieve = true; f.store.data.connectors = {};
  assert.throws(() => f.connections.resolveLaunch(input), /revoked/);
});
test("remote preparation scopes reverse forwarding and revokes capability after failed install", async t => {
  const f = fixture(t); f.source.host = "remote"; f.source.cwd = "/home/test/owned-project";
  let received;
  const connections = new NativeConnections(f.engine, { root: f.root, address: "http://127.0.0.1:43127", remoteInstall: async input => { received = input; return "/home/test/.agentspaces-desktop-native/" + input.id + "/mcp.json"; } });
  const prepared = await connections.prepare({ sessionId: f.source.id });
  assert.match(received.address, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(!JSON.stringify(prepared).includes(received.token));
  const launch = connections.resolveLaunch({ connectionId: prepared.connectionId, provider: "claude", host: "remote", cwd: f.source.cwd, intent: "chat" });
  assert.ok(launch.sshOptions.includes("ExitOnForwardFailure=yes")); assert.match(launch.sshOptions.at(-1), /^127\.0\.0\.1:\d+:127\.0\.0\.1:43127$/);
  const before = Object.keys(f.store.data.connectors).length;
  const failing = new NativeConnections(f.engine, { root: f.root, address: "http://127.0.0.1:43127", remoteInstall: async () => { throw new Error("installation failed"); } });
  await assert.rejects(failing.prepare({ sessionId: f.source.id })); assert.equal(Object.keys(f.store.data.connectors).length, before);
});
test("partial runtime never becomes ready; retry verifies before atomic immutable module/config creation", t => {
  const f = fixture(t), base = join(f.root, "remote-assets"), source = "export const fixture = true;", payload = { id: randomUUID(), source, address: "http://127.0.0.1:43127", token: "synthetic-app-capability" };
  let installs = 0, importsReady = false;
  const runtime = join(base, "runtime-mcp-1.32.1-ws-8.22.0-zod-4.6.5");
  assert.throws(() => installChannelAssets({ base, payload, installDependencies: () => { installs++; return false; }, verifyDependencies: () => importsReady }), /not ready/);
  assert.ok(!existsSync(join(runtime, "READY"))); assert.ok(!existsSync(join(base, payload.id)));
  const file = installChannelAssets({ base, payload, installDependencies: () => { installs++; importsReady = true; return true; }, verifyDependencies: () => importsReady });
  assert.equal(installs, 2); assert.ok(existsSync(join(runtime, "READY")));
  const first = JSON.parse(readFileSync(file, "utf8")).mcpServers.agentspaces.args[0];
  assert.equal(readFileSync(first, "utf8"), source); assert.ok(!readdirSync(runtime).some(name => name.endsWith(".tmp")));
  const next = installChannelAssets({ base, payload: { ...payload, id: randomUUID(), source: source + "\n" }, installDependencies: () => { throw new Error("ready runtime must not reinstall"); }, verifyDependencies: () => true });
  const second = JSON.parse(readFileSync(next, "utf8")).mcpServers.agentspaces.args[0];
  assert.notEqual(first, second); assert.equal(readFileSync(first, "utf8"), source);
  writeFileSync(second, "changed module");
  assert.throws(() => installChannelAssets({ base, payload: { ...payload, id: randomUUID(), source: source + "\n" }, installDependencies: () => true, verifyDependencies: () => true }), /bytes changed/);
});
