import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { Store } from "../app/store.mjs";
import { Engine } from "../app/engine.mjs";
import { startServer } from "../app/server.mjs";

// Real app HTTP/WebSocket and MCP stdio transports, synthetic source metadata
// and a tool-speaking test actor. No native CLI or model is launched.
for (const aliasProxy of [false, true]) test("Native channel stdio actor roundtrip " + (aliasProxy ? "through different-port TCP alias" : "direct loopback"), { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "as-channel-e2e-"));
  const engine = new Engine(new Store(root), { diagnostics: () => ({ status: "fixture-disconnected" }), close() {} }, {
    nativeFactory: () => { throw new Error("This transport fixture must never invoke native history or models"); },
  });
  engine.loadSample();
  const claudeId = "sample-claude-old", codexId = "sample-codex-old";
  const syntheticNative = engine.catalog.find((s) => s.id === claudeId);
  syntheticNative.fixture = false;
  syntheticNative.nativeThreadId = "synthetic-native-claude-source";
  syntheticNative.sourceVersion = "synthetic-native-catalog-v1";
  syntheticNative.title = "Synthetic native catalog entry for transport test";
  for (const id of [claudeId, codexId]) engine.grant(id, { enrolled: true, content: true, share: true, retrieve: true });
  const group = engine.discussions.create({ title: "Synthetic channel roundtrip", sessionIds: [claudeId, codexId] });
  const connector = engine.issueConnector(claudeId);
  const app = await startServer({ root, port: 0, engine });
  let channelAddress = app.address, proxy = null;
  const proxySockets = new Set();
  if (aliasProxy) {
    proxy = net.createServer((socket) => {
      const upstream = net.connect({ host: "127.0.0.1", port: new URL(app.address).port });
      for (const peer of [socket, upstream]) {
        proxySockets.add(peer);
        peer.on("close", () => proxySockets.delete(peer));
        peer.on("error", () => { socket.destroy(); upstream.destroy(); });
      }
      socket.pipe(upstream); upstream.pipe(socket);
    });
    await new Promise((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
    channelAddress = "http://127.0.0.1:" + proxy.address().port;
    assert.notEqual(channelAddress, app.address);
    const denied = await fetch(channelAddress + "/api/health", { headers: { Authorization: "Bearer " + app.admin } });
    assert.equal(denied.status, 403, "Alias transport must not bypass exact companion Host validation");
  }
  const client = new Client({ name: "synthetic-native-channel-test-actor", version: "1" });
  t.after(async () => {
    await client.close();
    for (const socket of proxySockets) socket.destroy();
    if (proxy) await new Promise((resolve) => proxy.close(resolve));
    await app.close();
  });
  const events = [];
  let resolveEvent;
  const eventReady = new Promise((resolve) => { resolveEvent = resolve; });
  client.setNotificationHandler(z.object({ method: z.literal("notifications/claude/channel"), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }) }), (notification) => {
    events.push(notification.params); resolveEvent(notification.params);
  });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("app/claude-channel.mjs")], env: { ...process.env, AGENTSPACES_URL: channelAddress, AGENTSPACES_COMPANION_AUTHORITY: new URL(app.address).host, AGENTSPACES_CONNECTOR_TOKEN: connector.token }, stderr: "ignore" });
  await client.connect(transport);
  const deadline = Date.now() + 4000;
  while (!app.channels.isConnected(claudeId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(app.channels.isConnected(claudeId), true, "Real channel WebSocket must connect after MCP initialization");
  const call = async (path, body) => {
    const response = await fetch(app.address + "/api/" + path, { method: "POST", headers: { Authorization: "Bearer " + app.admin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); return response.json();
  };
  assert.deepEqual(await call("native/channel/status", { sessionId: claudeId }), { connected: true, nativeIdentityVerified: false, mode: "native-interactive-channel" });
  const tools = await client.listTools();
  assert(tools.tools.some((tool) => tool.name === "reply"));
  const discovered = await client.callTool({ name: "discover_group_discussions", arguments: { query: "Synthetic channel" } });
  assert.equal(JSON.parse(discovered.content[0].text)[0].id, group.id);
  const message = { id: group.id, text: "Synthetic request: what retry decision should this group preserve?", targets: [claudeId], deliveryId: "fixture-channel-post-0001" };
  const posted = await call("discussions/post", message);
  let timer;
  const event = await Promise.race([eventReady, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Targeted MCP channel notification did not arrive")), 4000); })]).finally(() => clearTimeout(timer));
  assert.equal(event.content, message.text);
  assert.equal(event.meta.discussion_id, group.id);
  assert.equal(event.meta.message_id, posted.messages[0].id);
  assert.equal(posted.messages[0].targets[0].status, "delivered-to-native-transport");
  const read = await client.callTool({ name: "read_group_discussion", arguments: { id: group.id } });
  assert.equal(JSON.parse(read.content[0].text).messages[0].text, message.text);
  const replyArgs = { requestId: event.meta.request_id, discussionId: group.id, text: "Synthetic actor reply: reconcile the original operation before retrying.", deliveryId: "fixture-channel-reply-0001", nativeTurnId: "synthetic-self-reported-turn" };
  const reply = await client.callTool({ name: "reply", arguments: replyArgs });
  assert(!reply.isError);
  const result = JSON.parse(reply.content[0].text);
  assert.equal(result.receipt.status, "native-participant-contributed");
  assert.equal(result.attribution, "self-reported; not verified");
  const contribution = result.discussion.messages.at(-1);
  assert.equal(contribution.source.sessionId, claudeId);
  assert.equal(contribution.source.nativeThreadId, syntheticNative.nativeThreadId);
  assert.equal(contribution.replyTo, posted.messages[0].id);
  assert.equal(contribution.text, replyArgs.text);
  assert.equal(contribution.turnId, replyArgs.nativeTurnId);
  const duplicateReply = await client.callTool({ name: "reply", arguments: replyArgs });
  assert.equal(JSON.parse(duplicateReply.content[0].text).discussion.version, result.discussion.version);
  await call("discussions/post", message);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(events.length, 1, "Duplicate owner submission must not replay native notification");
  const foreignReply = await client.callTool({ name: "reply", arguments: { ...replyArgs, requestId: "fixture-unknown-request", deliveryId: "fixture-channel-reply-0002" } });
  assert.equal(foreignReply.isError, true);
  engine.grant(claudeId, { share: false });
  assert.equal((await call("native/channel/status", { sessionId: claudeId })).connected, false);
  const deniedReply = await client.callTool({ name: "reply", arguments: { ...replyArgs, deliveryId: "fixture-channel-reply-0003" } });
  assert.equal(deniedReply.isError, true);
  assert.equal(engine.discussions.view(engine.discussions.group(group.id)).messages.length, 0, "Revoked sharing hides cached group content");
  assert.equal(engine.modelCalls, 0);
});
