import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { Store } from "../app/store.mjs";
import { Engine } from "../app/engine.mjs";
import { FabricAdapter } from "../app/fabric.mjs";
import { startServer } from "../app/server.mjs";

const THREAD = "11111111-2222-4333-8444-555555555555";
async function setup(t, { installationGate } = {}) {
  const root = mkdtempSync(join(tmpdir(), "as-participant-http-"));
  const engine = new Engine(new Store(root), new FabricAdapter({ stateRoot: root }));
  engine.loadSample(); engine.mode = "workspace-connected";
  engine.probe = async () => { throw new Error("No native probe allowed in participant HTTP fixture"); };
  const source = engine.session("sample-claude-new");
  Object.assign(source, { fixture: false, host: "remote", nativeThreadId: THREAD,
    cwd: "/tmp/agentspaces-participant-server-fixture", status: "unknown" });
  engine.store.data.projects[source.project].fixture = false;
  engine.grant(source.id, { enrolled: true, content: true, share: true, retrieve: true });
  const installed = [], tunnels = []; let closedTunnels = 0;
  const app = await startServer({ root, port: 0, engine,
    participantInstallRemote: async input => {
      installed.push(input); if (installationGate) await installationGate;
      return { configPath: "/home/fixture/.agentspaces-desktop-native/connections/" + input.connectionId + "/participant.json",
        usageGuidePath: "/home/fixture/.agentspaces-desktop-native/connections/" + input.connectionId + "/USE.md",
        cliPath: "/home/fixture/.agentspaces-desktop-native/participant-runtime/participant-cli-" + createHash("sha256").update(input.source).digest("hex") + ".mjs",
        transportStatus: "verified-http-200" };
    },
    participantTunnelFactory: async options => {
      const child = new EventEmitter(), handle = { child, exited: false,
        close() { if (!handle.exited) { handle.exited = true; closedTunnels++; child.emit("close", 0); } } };
      tunnels.push({ options, handle }); return handle;
    },
  });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } }; t.after(close);
  const page = await fetch(app.address), cookie = page.headers.get("set-cookie").split(";")[0];
  const headers = { Cookie: cookie, Origin: app.address, "X-AgentSpaces": "local-companion", "Content-Type": "application/json" };
  const post = (data, customHeaders = headers) => fetch(app.address + "/api/native/participant/prepare",
    { method: "POST", headers: customHeaders, body: JSON.stringify(data) });
  return { root, app, engine, source, installed, tunnels, post, close, closedTunnelCount: () => closedTunnels };
}
const until = async predicate => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(yes => setTimeout(yes, 5)); }
  throw new Error("Expected fixture participant installation phase");
};

test("owner HTTP preparation binds exact source and returns credential-free CLI instructions", async t => {
  const f = await setup(t), before = JSON.stringify({ projects: f.engine.store.data.projects, grants: f.engine.store.data.grants });
  assert(f.app.participantConnections);
  const response = await f.post({ sessionId: f.source.id }); assert.equal(response.status, 200);
  const body = await response.text(), value = JSON.parse(body);
  assert.equal(f.installed.length, 1); assert.equal(f.tunnels.length, 1);
  const installation = f.installed[0], privateConfig = installation.config;
  assert.equal(privateConfig.sessionId, f.source.id); assert.equal(privateConfig.nativeThreadId, THREAD);
  assert.equal(privateConfig.provider, "claude"); assert.equal(privateConfig.host, "remote");
  assert.equal(privateConfig.authority, new URL(f.app.address).host);
  assert.equal(privateConfig.address, "http://127.0.0.1:" + f.tunnels[0].options.remotePort);
  assert.equal(f.tunnels[0].options.host, "remote"); assert.equal(f.tunnels[0].options.localPort, Number(new URL(f.app.address).port));
  assert.equal(f.engine.connector(privateConfig.token).sessionId, f.source.id);
  assert.equal(value.nativeThreadId, THREAD); assert.equal(value.host, "remote"); assert.equal(value.transportStatus, "verified-http-200");
  assert.equal(value.usageGuidePath, "/home/fixture/.agentspaces-desktop-native/connections/" + value.connectionId + "/USE.md");
  assert.deepEqual(value.usageCommand, ["node", value.cliPath, "--config", value.configPath, "--source", THREAD, "discover"]);
  assert.equal(value.token, undefined); assert(!body.includes(privateConfig.token)); assert(!body.includes(installation.source));
  assert.equal(JSON.stringify({ projects: f.engine.store.data.projects, grants: f.engine.store.data.grants }), before);
  assert.equal(f.engine.modelCalls, 0); assert.equal(f.engine.cache.size, 0);
  assert(!readdirSync(f.root).some(name => /mcp|claude|codex/i.test(name)), "The route must not write global native MCP settings");
});

test("participant bearer capabilities cannot prepare another capability or change owner policy", async t => {
  const f = await setup(t), connector = f.engine.issueConnector(f.source.id);
  const before = JSON.stringify(f.engine.store.data.connectors);
  const response = await f.post({ sessionId: f.source.id, nativePolicyGranted: true, token: "caller-injected-token" },
    { Authorization: "Bearer " + connector.token, "Content-Type": "application/json" });
  assert.equal(response.status, 400); assert.match((await response.json()).error, /capability denied/);
  assert.equal(JSON.stringify(f.engine.store.data.connectors), before);
  assert.equal(f.installed.length, 0); assert.equal(f.tunnels.length, 0);
  assert.notEqual(f.engine.store.data.desktopPreferences?.allowNativeFullAccess, true);
});

test("unenrolled or revoked source grants refuse before config transfer or capability allocation", async t => {
  const f = await setup(t);
  for (const changes of [{ enrolled: false }, { enrolled: true, content: true, share: true, retrieve: false },
    { enrolled: true, content: true, share: false, retrieve: true }]) {
    f.engine.grant(f.source.id, changes); const before = JSON.stringify(f.engine.store.data.connectors);
    const response = await f.post({ sessionId: f.source.id }); assert.equal(response.status, 400);
    assert.equal(JSON.stringify(f.engine.store.data.connectors), before);
  }
  assert.equal(f.installed.length, 0); assert.equal(f.tunnels.length, 0); assert.equal(f.engine.cache.size, 0);
});

test("revocation during private transfer revokes its allocated capability and does not leak a token", async t => {
  let release; const gate = new Promise(yes => release = yes), f = await setup(t, { installationGate: gate });
  t.after(() => release());
  const preparing = f.post({ sessionId: f.source.id }); await until(() => f.installed.length === 1);
  const issued = f.installed[0].config.token;
  f.engine.grant(f.source.id, { enrolled: false }); release();
  const response = await preparing; assert.equal(response.status, 400); const body = await response.text();
  assert(!body.includes(issued)); assert.equal(Object.keys(f.engine.store.data.connectors).length, 0);
  assert.throws(() => f.engine.connector(issued), /denied|revoked/);
  assert.equal(f.closedTunnelCount(), 1);
});

test("source-scoped remote preparations reuse only the owned tunnel and server close disposes it", async t => {
  const f = await setup(t);
  const first = await f.post({ sessionId: f.source.id }); assert.equal(first.status, 200);
  const second = await f.post({ sessionId: f.source.id }); assert.equal(second.status, 200);
  const A = await first.json(), B = await second.json();
  assert.notEqual(A.connectionId, B.connectionId); assert.equal(f.installed.length, 2); assert.equal(f.tunnels.length, 1);
  assert.equal(A.usageGuidePath, A.configPath.replace(/participant\.json$/, "USE.md"));
  assert.equal(B.usageGuidePath, B.configPath.replace(/participant\.json$/, "USE.md"));
  assert.notEqual(A.usageGuidePath, B.usageGuidePath);
  assert.equal(f.installed[0].config.nativeThreadId, THREAD); assert.equal(f.installed[1].config.nativeThreadId, THREAD);
  assert.notEqual(f.installed[0].config.token, f.installed[1].config.token);
  await f.close(); assert.equal(f.closedTunnelCount(), 1); assert.equal(f.app.participantConnections.tunnels.size, 0);
});
