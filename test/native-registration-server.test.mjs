import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Store } from "../app/store.mjs";
import { Engine } from "../app/engine.mjs";
import { startServer } from "../app/server.mjs";
const THREAD = "00000000-0000-4000-8000-000000000001", UNKNOWN = "00000000-0000-4000-8000-000000000002";
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "as-registration-http-"));
  const engine = new Engine(new Store(root), { diagnostics: () => ({ status: "synthetic-disconnected" }), close() {} }, { nativeFactory: () => { throw new Error("No native or model call permitted by registration fixture"); } });
  engine.workspace.index = { schema: 1, fixture: false, profile: { id: "synthetic-owned-scope", active: true, account: "synthetic-owner", hosts: ["local"], providers: ["claude", "codex"], policy: "local-retrieval", indexFiles: true, roots: {}, exclusions: {} }, nodes: [{ id: "host:local", kind: "host", host: "local" }], edges: [], sessions: [], coverage: [], errors: [] };
  const source = { id: "claude@local:" + THREAD, nativeThreadId: THREAD, host: "local", provider: "claude", cwd: join(root, "fictional-work"), account: "synthetic-owner", scopeId: "synthetic-owned-scope", fixture: false, status: "unknown", title: "Synthetic native source metadata", sourceVersion: "synthetic-v1", topics: ["synthetic"] };
  engine.workspace.restore([source]); engine.workspace.index.sessions.push(source);
  const app = await startServer({ root, port: 0, engine, sourceMetadataResolver: async () => null });
  t.after(() => app.close());
  const call = async (path, body = {}, token = app.admin, method = "POST") => {
    const response = await fetch(app.address + path, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const device = await call("/api/native/registration/device", { host: "local", provider: "claude" });
  assert.equal(device.status, 200);
  return { app, engine, source, call, device: device.body };
}
test("Registration-only capability cannot read content, manage rooms, grant rights or mint other devices", async (t) => {
  const { call, device } = await fixture(t);
  const attempts = [
    ["/api/state", {}, "GET"], ["/api/health", {}, "GET"],
    ["/api/finding", { id: "any" }], ["/api/retrieve", { sourceId: "any" }],
    ["/api/discussions/create", { title: "unauthorized", sessionIds: [] }],
    ["/api/discussions/policy", { id: UNKNOWN, agentInitiation: true }],
    ["/api/grant", { id: "any", changes: { enrolled: true } }],
    ["/api/native/registration/device", { host: "local", provider: "codex" }],
  ];
  for (const [path, body, method = "POST"] of attempts) {
    const result = await call(path, body, device.token, method);
    assert.equal(result.status, 403, path);
    assert(!JSON.stringify(result.body).includes(device.token));
  }
});
test("Known registration mints scoped source tools and preserves discussion attribution over HTTP", async (t) => {
  const { app, engine, source, call, device } = await fixture(t);
  const registration = await call("/api/native/register", { nativeThreadId: THREAD, cwd: source.cwd }, device.token);
  assert.equal(registration.status, 200);
  const config = registration.body.participantConfig;
  assert.equal(config.nativeThreadId, THREAD); assert.equal(config.sessionId, source.id);
  assert.notEqual(config.token, device.token);
  assert.equal(new URL(config.address).host, new URL(app.address).host);
  const discover = await call("/api/discover", { query: "Synthetic", project: "all" }, config.token);
  assert.equal(discover.status, 200); assert.equal(discover.body[0].id, source.id);
  assert.equal((await call("/api/discussions/create", { title: "not-owner", sessionIds: [source.id] }, config.token)).status, 400);
  const group = engine.discussions.create({ title: "Synthetic registered group", sessionIds: [source.id] });
  assert.equal((await call("/api/discussions/context", { id: group.id }, config.token)).status, 200);
  const contribution = await call("/api/discussions/contribute", { id: group.id, text: "Synthetic registered participant reply", nativeTurnId: "synthetic-self-reported-turn", deliveryId: "synthetic-register-reply-0001" }, config.token);
  assert.equal(contribution.status, 200);
  assert.equal(contribution.body.messages.at(-1).source.sessionId, source.id);
  assert.equal(contribution.body.messages.at(-1).turnId, "synthetic-self-reported-turn");
  assert.equal(engine.modelCalls, 0);
});
test("Unknown registration remains pending without grants and revoked connectors cannot be recreated", async (t) => {
  const { engine, call, device } = await fixture(t);
  const pending = await call("/api/native/register", { nativeThreadId: UNKNOWN }, device.token);
  assert.equal(pending.status, 400); assert.match(pending.body.error, /source_pending/);
  assert.equal(engine.catalog.length, 1); assert.deepEqual(engine.store.data.grants, {});
  assert.equal(Object.keys(engine.store.data.connectors).length, 0);
  const registration = await call("/api/native/register", { nativeThreadId: THREAD }, device.token), config = registration.body.participantConfig;
  delete engine.store.data.connectors[createHash("sha256").update(config.token).digest("hex")];
  const revoked = await call("/api/native/register", { nativeThreadId: THREAD }, device.token);
  assert.equal(revoked.status, 400); assert.match(revoked.body.error, /source_connector_revoked/);
  assert.equal((await call("/api/discover", {}, config.token)).status, 401);
  engine.workspace.index.profile.active = false;
  assert.equal((await call("/api/native/register", { nativeThreadId: THREAD }, device.token)).status, 401);
  assert.equal(engine.modelCalls, 0);
});
