import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../app/store.mjs";
import { Engine } from "../app/engine.mjs";
import { FabricAdapter } from "../app/fabric.mjs";
import { startServer } from "../app/server.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import http from "node:http";
import { loadWorkspaceFixture } from "../app/workspace-fixture.mjs";
async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "as-http-"));
  const engine = new Engine(
    new Store(root),
    new FabricAdapter({ stateRoot: root }),
  );
  engine.loadSample();
  const app = await startServer({ root, port: 0, engine });
  t.after(() => app.close());
  return app;
}
test("loopback API enforces local auth, origin, host and CSRF", async (t) => {
  const app = await setup(t);
  assert.equal((await fetch(app.address + "/api/state")).status, 401);
  const page = await fetch(app.address);
  assert.match(
    page.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  const cookie = page.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (await fetch(app.address + "/api/state", { headers: { Cookie: cookie } }))
      .status,
    200,
  );
  assert.equal(
    (
      await fetch(app.address + "/api/state", {
        headers: { Cookie: cookie, Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(app.address + "/api/sample", {
        method: "POST",
        headers: { Cookie: cookie },
      })
    ).status,
    403,
  );
  const wrongHost = await new Promise((yes, no) => {
    http
      .get(
        app.address + "/api/state",
        { headers: { Cookie: cookie, Host: "evil.example" } },
        (response) => {
          response.resume();
          yes(response.statusCode);
        },
      )
      .on("error", no);
  });
  assert.equal(wrongHost, 403);
});
test("server denies path traversal and unsupported native execution routes", async (t) => {
  const app = await setup(t);
  const headers = { Authorization: `Bearer ${app.admin}` };
  assert.equal(
    (await fetch(app.address + "/app/store.mjs", { headers })).status,
    404,
  );
  assert.equal(
    (await fetch(app.address + "/api/execute", { method: "POST", headers }))
      .status,
    404,
  );
});
test("connector identity is bound server-side and cannot mutate permission grants", async (t) => {
  const app = await setup(t);
  app.engine.grant("sample-codex-old", {
    enrolled: true,
    content: true,
    share: true,
  });
  app.engine.grant("sample-claude-new", { enrolled: true, retrieve: true });
  const c = app.engine.issueConnector("sample-claude-new");
  const headers = {
    Authorization: `Bearer ${c.token}`,
    "Content-Type": "application/json",
  };
  const r = await fetch(app.address + "/api/retrieve", {
    method: "POST",
    headers,
    body: JSON.stringify({
      sourceId: "sample-codex-old",
      requesterId: "sample-denied",
    }),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).handoff.requesterId, "sample-claude-new");
  assert.equal(
    (
      await fetch(app.address + "/api/grant", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
    400,
  );
  app.engine.grant("sample-claude-new", { enrolled: false });
  assert.equal(
    (
      await fetch(app.address + "/api/discover", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
    401,
  );
});
test("real MCP SDK transport retrieves a fixture finding without invoking a model", async (t) => {
  const app = await setup(t);
  app.engine.grant("sample-codex-old", {
    enrolled: true,
    content: true,
    share: true,
  });
  app.engine.grant("sample-codex-new", { enrolled: true, retrieve: true });
  const c = app.engine.issueConnector("sample-codex-new");
  const client = new Client({ name: "desktop-fixture-test", version: "1" });
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve("app/mcp.mjs")],
      env: {
        ...process.env,
        AGENTSPACES_URL: app.address,
        AGENTSPACES_CONNECTOR_TOKEN: c.token,
      },
    }),
  );
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 16);
  const discovered = await client.callTool({
    name: "discover_permitted_work",
    arguments: { query: "retry", provider: "codex", status: "archived" },
  });
  assert.equal(
    JSON.parse(discovered.content[0].text)[0].id,
    "sample-codex-old",
  );
  const retrieved = await client.callTool({
    name: "retrieve_permitted_finding",
    arguments: { sourceId: "sample-codex-old" },
  });
  assert.equal(JSON.parse(retrieved.content[0].text).handoff.modelCalls, 0);
  assert.equal(app.engine.modelCalls, 0);
  app.engine.grant("sample-codex-new", { content: true, share: true });
  const group = app.engine.discussions.create({
    title: "MCP discussion",
    sessionIds: ["sample-codex-old", "sample-codex-new"],
  });
  const groupList = await client.callTool({
    name: "discover_group_discussions",
    arguments: { query: "MCP" },
  });
  assert.equal(JSON.parse(groupList.content[0].text)[0].id, group.id);
  const context = await client.callTool({
    name: "read_group_discussion",
    arguments: { id: group.id },
  });
  assert.equal(JSON.parse(context.content[0].text).id, group.id);
  const contribution = await client.callTool({
    name: "contribute_to_discussion",
    arguments: {
      id: group.id,
      text: "Fixture MCP contribution",
      nativeTurnId: "reported-turn",
      deliveryId: "mcp-delivery-0001",
    },
  });
  assert.equal(
    JSON.parse(contribution.content[0].text).messages[0].source.sessionId,
    "sample-codex-new",
  );
  app.engine.grant("sample-codex-old", { share: false });
  assert.deepEqual(
    JSON.parse(
      (
        await client.callTool({
          name: "discover_group_discussions",
          arguments: {},
        })
      ).content[0].text,
    ),
    [],
  );
  assert.equal(
    (
      await client.callTool({
        name: "read_group_discussion",
        arguments: { id: group.id },
      })
    ).isError,
    true,
  );
});
test("workspace MCP lookup and artifact read enforce the bound broad scope", async (t) => {
  const app = await setup(t);
  await loadWorkspaceFixture(app.engine);
  const connector = app.engine.issueConnector("sample-codex-new");
  const client = new Client({ name: "workspace-fixture-test", version: "1" });
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve("app/mcp.mjs")],
      env: {
        ...process.env,
        AGENTSPACES_URL: app.address,
        AGENTSPACES_CONNECTOR_TOKEN: connector.token,
      },
    }),
  );
  const search = await client.callTool({
    name: "search_workspace_context",
    arguments: { query: "Architecture", kind: "document", limit: 5 },
  });
  const result = JSON.parse(search.content[0].text);
  assert.equal(result.total, 2);
  const read = await client.callTool({
    name: "read_workspace_artifact",
    arguments: { nodeId: result.items[0].id },
  });
  assert.match(
    JSON.parse(read.content[0].text).text,
    /Synthetic shared foundation/,
  );
  app.engine.workspace.revoke();
  const denied = await client.callTool({
    name: "search_workspace_context",
    arguments: { query: "Architecture" },
  });
  assert.equal(denied.isError, true);
});
