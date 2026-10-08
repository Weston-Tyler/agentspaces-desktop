import http from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { Store } from "./store.mjs";
import { Engine } from "./engine.mjs";
import { FabricAdapter } from "./fabric.mjs";
import { openNativeSignIn } from "./native.mjs";
import { protectStateDirectory } from "./state-security.mjs";
import { loadWorkspaceFixture } from "./workspace-fixture.mjs";
const ui = fileURLToPath(new URL("../ui/", import.meta.url));
const staticFiles = {
  "/": "index.html",
  "/style.css": "style.css",
  "/app.js": "app.js",
  "/native-controls.js": "native-controls.js",
  "/workspace.js": "workspace.js",
};
export async function startServer({
  root = resolve(".local"),
  port = 43127,
  engine: provided,
} = {}) {
  const store = provided?.store ?? new Store(root),
    fabric = provided?.fabric ?? new FabricAdapter({ stateRoot: root }),
    engine = provided ?? new Engine(store, fabric);
  protectStateDirectory(root);
  if (!provided) await engine.initialize();
  const session = randomBytes(32).toString("hex"),
    admin = randomBytes(32).toString("hex"),
    instance = randomBytes(16).toString("hex");
  const cookies = new Set([session]);
  let closing = false;
  const json = (res, status, value) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  const server = http.createServer(async (req, res) => {
    const expected = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== expected) {
      json(res, 403, { error: "Host denied" });
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
    );
    if (
      (req.headers.origin && req.headers.origin !== `http://${expected}`) ||
      req.headers["sec-fetch-site"] === "cross-site"
    ) {
      json(res, 403, { error: "Origin denied" });
      return;
    }
    const url = new URL(req.url, `http://${expected}`);
    const isAdmin = req.headers.authorization === `Bearer ${admin}`;
    if (url.pathname === "/favicon.ico" && req.method === "GET") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (staticFiles[url.pathname] && req.method === "GET") {
      if (url.pathname === "/")
        res.setHeader(
          "Set-Cookie",
          `as_session=${session}; HttpOnly; SameSite=Strict; Path=/`,
        );
      const file = staticFiles[url.pathname];
      res.setHeader(
        "Content-Type",
        file.endsWith(".css")
          ? "text/css"
          : file.endsWith(".js")
            ? "text/javascript"
            : "text/html",
      );
      res.end(readFileSync(join(ui, file)));
      return;
    }
    const cookie = /\bas_session=([a-f0-9]+)/.exec(
      req.headers.cookie ?? "",
    )?.[1];
    let connector = null;
    if (!isAdmin && !cookies.has(cookie)) {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      try {
        if (token) connector = engine.connector(token);
      } catch {}
      if (!connector) {
        json(res, 401, { error: "Local access required" });
        return;
      }
    }
    try {
      if (req.method === "GET" && url.pathname === "/api/health") {
        json(res, 200, {
          status: closing ? "stopping" : "running",
          instance,
          pid: process.pid,
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/state" && !connector) {
        json(res, 200, engine.snapshot());
        return;
      }
      if (req.method !== "POST") {
        if (
          req.method === "GET" &&
          url.pathname === "/api/workspace" &&
          !connector
        ) {
          json(res, 200, engine.workspace.view());
          return;
        }
        json(res, 404, { error: "Not found" });
        return;
      }
      if (
        !isAdmin &&
        !connector &&
        req.headers["x-agentspaces"] !== "local-companion"
      ) {
        json(res, 403, { error: "CSRF check failed" });
        return;
      }
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 65536) {
          json(res, 413, { error: "Request too large" });
          return;
        }
      }
      const data = body ? JSON.parse(body) : {};
      if (
        connector &&
        ![
          "/api/discover",
          "/api/retrieve",
          "/api/workspace/search",
          "/api/workspace/inspect",
        ].includes(url.pathname)
      )
        throw new Error("Connector capability denied");
      if (
        connector &&
        url.pathname.startsWith("/api/workspace/") &&
        (!connector.scopeId ||
          connector.scopeId !== engine.workspace.index?.profile?.id ||
          !engine.workspace.index?.profile?.active)
      )
        throw new Error("Connector has no granted workspace scope");
      let result;
      switch (url.pathname) {
        case "/api/sample":
          result = engine.loadSample();
          break;
        case "/api/workspace/sample":
          result = await loadWorkspaceFixture(engine);
          break;
        case "/api/workspace/connect":
          result = await engine.workspace.scan(data);
          break;
        case "/api/workspace/continue":
          if (!engine.workspace.index?.profile?.active)
            throw new Error("No active workspace scope");
          result = await engine.workspace.scan(engine.workspace.index.profile, {
            continuePages: true,
          });
          break;
        case "/api/workspace/compare":
          result = await engine.workspace.compare(data);
          break;
        case "/api/workspace/search":
          result = engine.workspace.search(data);
          break;
        case "/api/workspace/inspect":
          result = await engine.workspace.inspect(data);
          break;
        case "/api/workspace/cancel":
          result = engine.workspace.cancel();
          break;
        case "/api/workspace/revoke":
          result = engine.workspace.revoke();
          break;
        case "/api/discover":
          result = engine.discover(
            connector
              ? {
                  ...data,
                  project: connector.scopeId ? "all" : connector.project,
                  scopeId: connector.scopeId ?? null,
                }
              : data,
          );
          break;
        case "/api/grant":
          result = engine.grant(data.id, data.changes ?? {});
          break;
        case "/api/finding":
          result = await engine.finding(data.id);
          break;
        case "/api/retrieve":
          result = await engine.retrieve(
            connector
              ? { sourceId: data.sourceId, requesterId: connector.sessionId }
              : data,
          );
          break;
        case "/api/native/discover":
          result = await engine.discoverNative(data);
          break;
        case "/api/native/probe":
          result = await engine.probe(data.host);
          break;
        case "/api/native/more":
          result = await engine.moreNative(data);
          break;
        case "/api/native/sign-in":
          result = openNativeSignIn(data.provider, data.host);
          store.audit("Native sign-in terminal requested", {
            provider: data.provider,
            host: data.host,
          });
          break;
        case "/api/fabric/connect":
          result = await engine.connectFabric(data);
          break;
        case "/api/fabric/disconnect":
          fabric.close();
          store.audit("Fabric disconnected");
          result = fabric.diagnostics();
          break;
        case "/api/connector":
          result = engine.issueConnector(data.id);
          break;
        case "/api/publish":
          result = await engine.publish(data.id);
          break;
        case "/api/stop":
          if (!isAdmin) throw new Error("Background stop capability required");
          closing = true;
          result = { status: "stopping" };
          setImmediate(() => close());
          break;
        default:
          json(res, 404, { error: "Not found" });
          return;
      }
      json(res, 200, result);
    } catch (e) {
      json(res, 400, {
        error: e instanceof SyntaxError ? "Invalid request JSON" : e.message,
      });
    }
  });
  await new Promise((yes, no) => {
    server.once("error", no);
    server.listen(port, "127.0.0.1", yes);
  });
  const address = `http://127.0.0.1:${server.address().port}`;
  const runtimePath = join(root, "runtime.json");
  writeFileSync(
    runtimePath,
    JSON.stringify({ address, admin, instance, pid: process.pid }),
    { mode: 0o600 },
  );
  async function close() {
    fabric.close();
    await new Promise((r) => server.close(r));
    if (existsSync(runtimePath)) {
      const current = JSON.parse(readFileSync(runtimePath, "utf8"));
      if (current.instance === instance) unlinkSync(runtimePath);
    }
  }
  return { server, engine, store, address, instance, admin, close };
}
