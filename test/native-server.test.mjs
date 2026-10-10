import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { Engine } from "../app/engine.mjs";
import { Store } from "../app/store.mjs";
import { FabricAdapter } from "../app/fabric.mjs";
import { startServer } from "../app/server.mjs";

class FixtureTerminals {
  constructor() { this.items = new Map(); this.writes = []; this.sizes = []; this.creates = []; this.detached = []; this.closeAllCalls = 0; }
  async create(options) {
    this.creates.push(options);
    const id = "11111111-2222-3333-4444-" + String(this.items.size + 1).padStart(12, "0");
    const item = { id, provider: options.provider, host: options.host ?? "local", status: "running" };
    this.items.set(id, item); return { ...item };
  }
  get(id) { const item = this.items.get(id); if (!item) throw new Error("Unknown terminal"); return { id, provider: item.provider, host: item.host, status: item.status }; }
  list() { return [...this.items.keys()].map(id => this.get(id)); }
  attach(id, callbacks) {
    const item = this.items.get(id);
    if (!item || item.status !== "running" || item.callbacks) throw new Error("Attached or closed");
    item.callbacks = callbacks;
    return () => { if (item.callbacks === callbacks) { item.callbacks = null; this.close(id); } };
  }
  write(id, data) {
    if (typeof data !== "string" || Buffer.byteLength(data) > 8192) throw new Error("Invalid input");
    this.writes.push({ id, data });
  }
  resize(id, cols, rows) {
    if (!Number.isInteger(cols) || cols < 20 || cols > 300 || !Number.isInteger(rows) || rows < 5 || rows > 150) throw new Error("Invalid dimensions");
    this.sizes.push({ id, cols, rows });
  }
  close(id) {
    const item = this.items.get(id); if (!item || item.status === "closed") return;
    item.callbacks = null; this.detached.push(id);
  }
  closeAll() { this.closeAllCalls++; for (const id of this.items.keys()) this.close(id); }
  output(id, data) { this.items.get(id).callbacks?.onData(data); }
  exit(id) { this.items.get(id).callbacks?.onExit({ exitCode: 0 }); }
}
async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "as-native-server-"));
  const engine = new Engine(new Store(root), new FabricAdapter({ stateRoot: root }));
  engine.loadSample(); const terminals = new FixtureTerminals();
  const app = await startServer({ root, port: 0, engine, terminals });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(close);
  const page = await fetch(app.address), cookie = page.headers.get("set-cookie").split(";")[0];
  const headers = { Cookie: cookie, Origin: app.address, "X-AgentSpaces": "local-companion", "Content-Type": "application/json" };
  const post = (path, value, extra = {}) => fetch(app.address + path, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(value) });
  const open = async () => {
    const response = await post("/api/native/terminal/open", { provider: "codex", host: "local", intent: "chat" });
    assert.equal(response.status, 200); return response.json();
  };
  return { app, terminals, engine, cookie, headers, post, open, close };
}
const url = (app, id) => app.address.replace("http:", "ws:") + "/api/native/terminal/" + id;
async function connect(app, id, headers) {
  const ws = new WebSocket(url(app, id), { headers });
  await new Promise((yes, no) => { ws.once("open", yes); ws.once("error", no); });
  return ws;
}
async function refused(app, id, headers) {
  return new Promise((yes, no) => {
    const ws = new WebSocket(url(app, id), { headers });
    const timer = setTimeout(() => { ws.terminate(); no(new Error("Expected refused handshake")); }, 3000);
    ws.on("error", () => {});
    ws.once("open", () => { clearTimeout(timer); ws.close(); no(new Error("Forbidden terminal handshake opened")); });
    ws.once("unexpected-response", (_request, response) => { clearTimeout(timer); response.resume(); ws.terminate(); yes(response.statusCode); });
  });
}
const socketClosed = ws => new Promise(yes => ws.once("close", (code, reason) => yes({ code, reason: reason.toString() })));
const nextMessage = ws => new Promise(yes => ws.once("message", data => yes(JSON.parse(data.toString()))));
const until = async predicate => {
  for (let i = 0; i < 50; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error("Expected terminal lifecycle effect");
};

test("native terminal HTTP controls require owner authentication, origin and CSRF", async t => {
  const { app, terminals, post, open } = await setup(t);
  assert.equal((await fetch(app.address + "/api/native/terminal/open", { method: "POST", body: "{}" })).status, 401);
  assert.equal((await post("/api/native/terminal/open", {}, { "X-AgentSpaces": "" })).status, 403);
  assert.equal((await post("/api/native/terminal/open", {}, { Origin: "https://evil.example" })).status, 403);
  assert.equal(terminals.creates.length, 0);
  const terminal = await open(); assert.equal(terminals.creates.length, 1);
  const list = await post("/api/native/terminal/list", {}); assert.equal(list.status, 200);
  assert.equal((await list.json())[0].id, terminal.id);
  assert.equal((await post("/api/native/terminal/close", { id: terminal.id })).status, 200);
  assert.deepEqual(terminals.detached, [terminal.id]);
});

test("participant capabilities cannot open, enumerate, close or attach owner terminals", async t => {
  const { app, engine, terminals, open } = await setup(t), terminal = await open();
  engine.grant("sample-claude-new", { enrolled: true, retrieve: true });
  const connector = engine.issueConnector("sample-claude-new");
  for (const action of ["open", "list", "close"]) {
    const response = await fetch(app.address + "/api/native/terminal/" + action, {
      method: "POST", headers: { Authorization: "Bearer " + connector.token, "Content-Type": "application/json" },
      body: JSON.stringify({ id: terminal.id, provider: "claude" }),
    });
    assert.equal(response.status, 400); assert.match((await response.json()).error, /capability denied/);
  }
  assert.equal(await refused(app, terminal.id, { Origin: app.address, Authorization: "Bearer " + connector.token }), 403);
  assert.equal(terminals.creates.length, 1); assert.equal(terminals.detached.length, 0);
});

test("terminal WebSocket rejects absent/stale owner cookies, wrong origin/host and cross-site access", async t => {
  const { app, cookie, open } = await setup(t), terminal = await open();
  const attempts = [
    { Origin: app.address }, { Origin: app.address, Cookie: "as_session=deadbeef" },
    { Cookie: cookie }, { Cookie: cookie, Origin: "https://evil.example" },
    { Cookie: cookie, Origin: app.address, Host: "evil.example" },
    { Cookie: cookie, Origin: app.address, "Sec-Fetch-Site": "cross-site" },
  ];
  for (const headers of attempts) assert.equal(await refused(app, terminal.id, headers), 403);
  assert.equal(await refused(app, "99999999-2222-3333-4444-555555555555", { Cookie: cookie, Origin: app.address }), 403);
});

test("authenticated WebSocket routes native input/resize/output and detaches its terminal on disconnect", async t => {
  const { app, terminals, cookie, engine, open } = await setup(t), terminal = await open();
  const ws = await connect(app, terminal.id, { Cookie: cookie, Origin: app.address }); t.after(() => ws.terminate());
  const secret = "SYNTHETIC_NATIVE_INPUT";
  ws.send(JSON.stringify({ type: "input", data: secret }));
  ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
  await until(() => terminals.writes.length === 1 && terminals.sizes.length === 1);
  assert.deepEqual(terminals.writes, [{ id: terminal.id, data: secret }]);
  assert.deepEqual(terminals.sizes, [{ id: terminal.id, cols: 120, rows: 40 }]);
  const output = nextMessage(ws); terminals.output(terminal.id, "SYNTHETIC_NATIVE_OUTPUT");
  assert.deepEqual(await output, { type: "output", data: "SYNTHETIC_NATIVE_OUTPUT" });
  assert(!JSON.stringify(engine.store.data).includes(secret));
  const closed = socketClosed(ws); ws.close(); await closed;
  await until(() => terminals.detached.includes(terminal.id));
});

test("duplicate attachment and malformed or oversized terminal messages fail closed", async t => {
  const { app, terminals, cookie, open } = await setup(t), terminal = await open();
  const headers = { Cookie: cookie, Origin: app.address };
  const first = await connect(app, terminal.id, headers); t.after(() => first.terminate());
  const second = new WebSocket(url(app, terminal.id), { headers }); second.on("error", () => {});
  assert.equal((await socketClosed(second)).code, 1008);
  assert.equal(terminals.detached.length, 0, "Rejected duplicate attachment must not close the real owner connection");
  const closed = socketClosed(first); first.send(JSON.stringify({ type: "input", data: "x".repeat(8193) }));
  assert.equal((await closed).code, 1008);
  await until(() => terminals.detached.includes(terminal.id)); assert.equal(terminals.writes.length, 0);
  const another = await open(), ws = await connect(app, another.id, headers);
  const malformed = socketClosed(ws); ws.send("not json"); assert.equal((await malformed).code, 1008);
});

test("native exit and server shutdown release attachments and all terminal handles", async t => {
  const { app, terminals, cookie, open, close } = await setup(t), terminal = await open();
  const headers = { Cookie: cookie, Origin: app.address };
  const ws = await connect(app, terminal.id, headers), message = nextMessage(ws), exited = socketClosed(ws);
  terminals.exit(terminal.id);
  assert.deepEqual(await message, { type: "exit", exitCode: 0 }); await exited;
  await until(() => terminals.detached.includes(terminal.id));
  const another = await open(), active = await connect(app, another.id, headers), closed = socketClosed(active);
  await close(); await closed;
  assert.equal(terminals.closeAllCalls, 1); assert(terminals.detached.includes(another.id));
});
