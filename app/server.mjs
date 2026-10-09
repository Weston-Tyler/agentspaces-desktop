import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { Store } from "./store.mjs";
import { Engine } from "./engine.mjs";
import { FabricAdapter } from "./fabric.mjs";
import { openNativeSignIn } from "./native.mjs";
import { NativeThreadCreation } from './native-thread-creation.mjs';
import { scopePathExcluded } from './workspace-map.mjs';
import { nativeAdapterCompatible } from './native-versions.mjs';
import { hostPaths, normalizeHostPath } from './platform.mjs';
import { OwnerBrowserSession } from './owner-browser-session.mjs';
import { RecentHistory } from './recent-history.mjs';
import { addNativeToolPaths } from './native-tool-path.mjs';
import { PeerMessaging } from './peer-messaging.mjs';
import { AgentBroadcast } from './agent-broadcast.mjs';
import { parseAgentSelectors } from './agent-selection.mjs';
import { protectStateDirectory } from "./state-security.mjs";
import { loadWorkspaceFixture } from "./workspace-fixture.mjs";
import { installHostRouter } from "./router-install.mjs";
import { detectAnswerProviders } from "./answer-provider.mjs";
import { WebSocketServer } from "ws";
import { NativeTerminals } from "./native-terminal.mjs";
import { NativeConnections } from "./native-connections.mjs";
import { ChannelHub } from "./channel-hub.mjs";
import { ensureDesktopDiscovery } from "./desktop-discovery.mjs";
import { connectAllOwnedWork } from "./connect-all.mjs";
import { CodexDiscussionHub } from "./codex-discussions.mjs";
import { routeConversation } from "./conversation-routing.mjs";
import { ParticipantConnections } from "./participant-connection.mjs";
import { SourceBindings } from './source-bindings.mjs';
import { resolveNativeSourceMetadata } from './native-source-metadata.mjs';
import { NativeAutoInstaller } from './native-auto-install.mjs';
const ui = fileURLToPath(new URL("../ui/", import.meta.url));
const staticFiles = {
  "/": "index.html",
  "/style.css": "style.css",
  "/app.js": "app.js",
  "/native-controls.js": "native-controls.js",
  "/workspace.js": "workspace.js",
  "/discussions.js": "discussions.js",
  "/ask.js": "ask.js",
  "/native-chat.js": "native-chat.js",
  "/home-chat.js": "home-chat.js",
};
const vendorFiles = {
  "/vendor/xterm.js": fileURLToPath(new URL("../node_modules/@xterm/xterm/lib/xterm.js", import.meta.url)),
  "/vendor/fit.js": fileURLToPath(new URL("../node_modules/@xterm/addon-fit/lib/addon-fit.js", import.meta.url)),
  "/vendor/xterm.css": fileURLToPath(new URL("../node_modules/@xterm/xterm/css/xterm.css", import.meta.url)),
};
export async function startServer({
  root = resolve(".local"),
  port = 43127,
  engine: provided,
  terminals: providedTerminals,
  remoteInstall,
  desktopDiscovery = !provided,
  allowDemo = false,
  codexAdapterFactory,
  participantInstallRemote,
  participantTunnelFactory,
  sourceMetadataResolver = resolveNativeSourceMetadata,
  automaticInstallLocal,
  automaticInstallRemote,
  nativeThreadAdapterFactory,
} = {}) {
  const store = provided?.store ?? new Store(root),
    fabric = provided?.fabric ?? new FabricAdapter({ stateRoot: root }),
    engine = provided ?? new Engine(store, fabric);
  protectStateDirectory(root);
  if (!provided) addNativeToolPaths();
  if (!provided) await engine.initialize();
  const desktopStartup = desktopDiscovery ? ensureDesktopDiscovery(engine) : null;
  let connectedWork = null;
  if (desktopDiscovery && store.data.desktopPreferences?.connectAll) {
    if (engine.workspace.running) desktopStartup.promise.then(() => { connectedWork = connectAllOwnedWork(engine, { hosts: store.data.desktopPreferences.hosts }); });
    else connectedWork = connectAllOwnedWork(engine, { hosts: store.data.desktopPreferences.hosts });
  }
  const ownerBrowser = new OwnerBrowserSession(store), recentHistory = new RecentHistory(store);
  const admin = randomBytes(32).toString("hex"),
    instance = randomBytes(16).toString("hex");
  let closing = false;
  const activeAnswers = new Map();
  const channels = new ChannelHub(engine);
  const codexAgents = new CodexDiscussionHub(engine, { adapterFactory: codexAdapterFactory, onContribution: (group, message) => routeConversation(engine, { codexAgents, channels }, group, message) });
  const nativeThreads = new NativeThreadCreation(engine, { adapterFactory: nativeThreadAdapterFactory, registerSource: async input => {
    const saved = store.data.nativeAutomaticInstallations?.[input.host + ':codex']?.device;
    let device;
    if (saved) { sourceBindings.device(saved.token); device = saved; }
    else device = sourceBindings.issueDevice({ host: input.host, provider: 'codex' });
    const registered = await sourceBindings.register(device.token, { nativeThreadId: input.nativeThreadId, cwd: input.cwd });
    return { sessionId: registered.sessionId };
  } });
  const peerMessages = new PeerMessaging(engine, { resolveTarget: async input => {
    const saved = store.data.nativeAutomaticInstallations?.[input.host + ':' + input.provider]?.device;
    let device;
    if (saved) { sourceBindings.device(saved.token); device = saved; }
    else device = sourceBindings.issueDevice({ host: input.host, provider: input.provider });
    const registered = await sourceBindings.register(device.token, { nativeThreadId: input.nativeThreadId });
    return { sessionId: registered.sessionId };
  } });
  const broadcasts = new AgentBroadcast(engine);
  const routeBatches = async result => {
    for (const batch of result.batches) {
      const group = engine.discussions.group(batch.discussionId);
      await routeConversation(engine, { codexAgents, channels }, group, group.messages.find(m => m.id === batch.messageId));
    }
    return result;
  };
  let connections, participantConnections, sourceBindings, automaticConnections;
  const terminals = providedTerminals ?? new NativeTerminals({ resolveLaunch: options => connections.resolveLaunch(options) });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
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
    const styleNonce = randomBytes(24).toString("base64");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'nonce-" + styleNonce + "'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
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
    if ((staticFiles[url.pathname] || vendorFiles[url.pathname]) && req.method === "GET") {
      if (url.pathname === "/")
        res.setHeader(
          "Set-Cookie",
          ownerBrowser.cookie(),
        );
      const file = staticFiles[url.pathname] ?? vendorFiles[url.pathname];
      res.setHeader(
        "Content-Type",
        file.endsWith(".css")
          ? "text/css"
          : file.endsWith(".js")
            ? "text/javascript"
            : "text/html",
      );
      const bytes = readFileSync(vendorFiles[url.pathname] ?? join(ui, file));
      res.end(url.pathname === "/" ? bytes.toString("utf8").replace("<head>", '<head><meta name="terminal-style-nonce" content="' + styleNonce + '">') : bytes);
      return;
    }
    const cookie = /\bas_session=([a-f0-9]+)/.exec(
      req.headers.cookie ?? "",
    )?.[1];
    let connector = null, registrationDevice = null;
    if (!isAdmin && !ownerBrowser.valid(cookie)) {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      try {
        if (token) connector = engine.connector(token);
      } catch {}
      if (!connector && token) {
        try { registrationDevice = sourceBindings.device(token); } catch {}
      }
      if (!connector && !registrationDevice) {
        json(res, 401, { error: "Local access required" });
        return;
      }
    }
    try {
      if (registrationDevice && (req.method !== 'POST' || url.pathname !== '/api/native/register')) {
        json(res, 403, { error: 'Registration capability cannot access content or owner operations' }); return;
      }
      if (req.method === "GET" && url.pathname === "/api/health") {
        json(res, 200, {
          status: closing ? "stopping" : "running",
          instance,
          pid: process.pid,
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/state" && !connector) {
        json(res, 200, { ...engine.snapshot(), automaticNativeConnections: automaticConnections.summary(), demoAvailable: allowDemo, connectedWork: connectedWork ? { status: connectedWork.status, stage: connectedWork.stage, partial: connectedWork.partial } : null, desktopPreferences: { connectAll: !!store.data.desktopPreferences?.connectAll }, desktopStartup: desktopStartup ? { ready: desktopStartup.ready, status: desktopStartup.status, retryRequired: desktopStartup.retryRequired } : null });
        return;
      }
      if (req.method !== "POST") {
        if (
          req.method === "GET" &&
          url.pathname === "/api/discussions" &&
          !connector
        ) {
          json(res, 200, engine.discussions.list());
          return;
        }
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
        !registrationDevice &&
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
          "/api/discussions/context",
          "/api/discussions/discover",
          "/api/discussions/joinable",
          "/api/discussions/join",
          "/api/discussions/create",
          "/api/discussions/invite",
          "/api/native/thread/create",
          "/api/agent/capabilities",
          "/api/agent/message",
          "/api/agent/broadcast",
          "/api/workspace/compare",
          "/api/discussions/contribute",
          "/api/native/channel/reply",
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
        case '/api/native/registration/device':
          result = sourceBindings.issueDevice({ host: data.host, provider: data.provider });
          break;
        case '/api/native/automatic/install':
          result = await automaticConnections.install({ host: data.host, provider: data.provider });
          break;
        case '/api/native/automatic/setup':
          sourceBindings.profile();
          store.data.desktopPreferences ??= {}; store.data.desktopPreferences.nativeAutoSetup = true; store.save();
          result = await automaticConnections.setup();
          break;
        case '/api/native/register': {
          if (!registrationDevice) throw new Error('Registration capability required');
          const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
          const bound = await sourceBindings.register(token, data);
          result = bound?.config ? { participantConfig: bound.config } : bound;
          break;
        }
        case '/api/discussions/policy':
          result = engine.discussions.setPolicy(data, connector);
          break;
        case '/api/discussions/joinable':
          result = engine.discussions.discoverJoinable(data, connector);
          break;
        case '/api/discussions/join':
          result = engine.discussions.join(data, connector);
          break;
        case '/api/discussions/invite':
          result = engine.discussions.invite(data, connector);
          break;
        case '/api/native/thread/create': {
          const caller = engine.discussions.participant(connector), host = data.host ?? caller.host;
          if (!engine.workspace.index?.profile?.hosts.includes(host)) throw new Error('Native host outside connected scope');
          if (!nativeThreadAdapterFactory) await engine.probe(host);
          result = await nativeThreads.create(data, connector);
          break;
        }
        case '/api/agent/capabilities': {
          const caller = engine.discussions.participant(connector), profile = engine.workspace.index?.profile;
          const workspaceGranted = !!profile?.active && connector.scopeId === profile.id;
          const creationGranted = workspaceGranted && profile.policy === 'local-retrieval' && caller.account === profile.account && !!engine.permissions(caller).content && profile.providers.includes('codex');
          result = { sourceId: caller.id, host: caller.host, provider: caller.provider,
            groups: { discover: true, create: true, join: true, invite: true, read: true, contribute: true, firstAccessJoinsOpenRoom: true },
            nativeThreads: { provider: 'codex', creationStartsTurn: false, hosts: (profile?.hosts ?? []).map(host => ({ host, available: creationGranted && engine.tools.some(t => t.host === host && t.provider === 'codex' && t.installed && nativeAdapterCompatible(t)), policy: 'inherit-native-configuration' })) },
            workspace: { search: workspaceGranted, inspect: workspaceGranted && !!profile.indexFiles, compare: workspaceGranted && !!profile.indexFiles },
            findings: { discover: true, retrieveShared: true },
            ownerSurfaces: ['account connections', 'source permissions', 'room policy', 'native login/consent', 'service lifecycle', 'model budgets'],
            unsupportedSources: ['unconnected cloud sessions', 'consumer web history'],
            availableTools: ['register_native_source','discover_permitted_work','retrieve_permitted_finding','discover_group_discussions','discover_joinable_discussions','join_group_discussion','create_group_discussion','invite_group_participant','read_group_discussion','contribute_to_discussion','create_native_thread','search_workspace_context','read_workspace_artifact','compare_worktrees','describe_agent_capabilities','message_agent_thread','message_agents'],
            workAuthority: 'AgentSpaces work/claim/lease/result contracts', idleModelPolling: false };
          break;
        }
        case '/api/agent/message': {
          result = await peerMessages.send(data, connector);
          const group = engine.discussions.group(result.discussionId), message = group.messages.find(m => m.id === result.messageId);
          await routeConversation(engine, { codexAgents, channels }, group, message);
          break;
        }
        case '/api/agent/broadcast':
          result = await routeBatches(await broadcasts.send(data, connector));
          break;
        case '/api/native/discussions/recover':
          result = data.reconcileOnly === true ? await codexAgents.reconcileSubmitted() : await codexAgents.recoverUndispatched({ includeLegacy: data.includeLegacy === true });
          break;
        case "/api/native/terminal/open":
          if (data.connectionId && data.ownerConfirmedAvailable !== true) throw new Error("Confirm that other native controllers are closed before resuming the selected thread");
          result = await terminals.create(data);
          break;
        case "/api/native/terminal/close":
          terminals.close(data.id); result = { status: "closed" };
          break;
        case "/api/native/terminal/list":
          result = terminals.list();
          break;
        case "/api/native/channel/prepare":
          result = await connections.prepare(data);
          break;
        case "/api/native/participant/prepare":
          result = await participantConnections.prepare({ sessionId: data.sessionId });
          break;
        case "/api/native/channel/status":
          result = { connected: channels.isConnected(data.sessionId), nativeIdentityVerified: false, mode: "native-interactive-channel" };
          break;
        case "/api/native/channel/reply":
          if (!connector) throw new Error("Participant-bound native channel capability required");
          result = channels.reply(data, connector);
          { const group = engine.discussions.group(data.discussionId); await routeConversation(engine, { codexAgents, channels }, group, group.messages.find(message => message.deliveryId === data.deliveryId)); }
          break;
        case "/api/ask/providers":
          result = await detectAnswerProviders({ host: data.host ?? "local" });
          break;
        case "/api/ask/search":
          result = engine.ask.search(data);
          break;
        case '/api/ask/history':
          if (connector || registrationDevice) throw new Error('Owner-private recent history');
          if (data.clear === true) result = recentHistory.clear();
          else if (data.record) {
            if (Object.keys(data.record).some(k => !['deliveryId','question','status'].includes(k)) || data.record.status !== 'failed') throw new Error('Bounded pre-dispatch history record required');
            recentHistory.record(data.record); result = recentHistory.list();
          } else result = recentHistory.list();
          break;
        case "/api/ask/answer": {
          if (activeAnswers.size >= 2)
            throw new Error(
              "Two questions are already running; wait or cancel one",
            );
          if (activeAnswers.has(data.deliveryId))
            throw new Error("This question is already running");
          const abort = new AbortController();
          const timeout =
            Number.isInteger(data.budget?.timeoutMs) &&
            data.budget.timeoutMs > 0 &&
            data.budget.timeoutMs <= 120000
              ? setTimeout(() => abort.abort(), data.budget.timeoutMs)
              : null;
          activeAnswers.set(data.deliveryId, abort);
          const onClose = () => {
            if (!res.writableEnded) abort.abort();
          };
          res.once("close", onClose);
          try {
            result = await engine.ask.answer(data, { signal: abort.signal });
            try { recentHistory.record({ deliveryId: data.deliveryId, question: data.question, status: 'complete', result }); }
            catch { result.historyWarning = 'Recent history could not be saved; this answer completed.'; }
          } catch (error) {
            if (typeof data.deliveryId === 'string' && typeof data.question === 'string') {
              try { recentHistory.record({ deliveryId: data.deliveryId, question: data.question, status: error.uncertainOutcome ? 'uncertain' : 'failed' }); } catch {}
            }
            throw error;
          } finally {
            if (timeout) clearTimeout(timeout);
            activeAnswers.delete(data.deliveryId);
            res.removeListener("close", onClose);
          }
          break;
        }
        case "/api/ask/cancel":
          if (typeof data.deliveryId !== "string")
            throw new Error("Question delivery ID required");
          if (activeAnswers.has(data.deliveryId)) {
            activeAnswers.get(data.deliveryId).abort();
            result = {
              status: "cancellation requested",
              outcome:
                "Native completion must be reconciled; cancellation is not proof of no effect",
            };
          } else result = { status: "not running" };
          break;
        case "/api/router/install":
          if (typeof data.dryRun !== "boolean")
            throw new Error("Choose preview or installation explicitly");
          result = await installHostRouter(data.host, data.dryRun);
          if (!data.dryRun)
            store.audit("Agent router installed", {
              host: data.host,
              files: result.files.map((f) => ({
                path: f.path,
                afterHash: f.afterHash,
              })),
            });
          break;
        case "/api/discussions/create":
          result = connector ? engine.discussions.createFor(data, connector) : engine.discussions.create(data);
          break;
        case "/api/desktop/connect-all":
          if (data.nativePolicyGranted === true) { store.data.desktopPreferences ??= {}; store.data.desktopPreferences.allowNativeFullAccess = true; store.save(); }
          connectedWork = connectAllOwnedWork(engine, { hosts: data.hosts ?? ["local", "remote"] });
          result = { status: connectedWork.status, stage: connectedWork.stage, partial: connectedWork.partial };
          break;
        case "/api/discussions/post": {
          const posted = await engine.discussions.postAddressed(data);
          await routeBatches(posted);
          store.save(); result = engine.discussions.view(engine.discussions.group(data.id));
          if (posted.broadcast) result.addressing = posted.broadcast;
          break;
        }
        case "/api/discussions/context":
          result = engine.discussions.contextOrJoin(data.id, connector);
          break;
        case "/api/discussions/discover":
          result = engine.discussions.discover(data, connector);
          break;
        case "/api/discussions/contribute":
          engine.discussions.contextOrJoin(data.id, connector);
          if (parseAgentSelectors(data.text).directives.length) {
            if (data.replyTo) throw new Error('Recipient selectors and replyTo must be sent separately');
            result = await routeBatches(await broadcasts.send({ discussionId: data.id, text: data.text, nativeTurnId: data.nativeTurnId, deliveryId: data.deliveryId }, connector));
            break;
          }
          result = engine.discussions.contribute(data, connector);
          { const group = engine.discussions.group(data.id); await routeConversation(engine, { codexAgents, channels }, group, group.messages.find(message => message.deliveryId === data.deliveryId)); }
          break;
        case "/api/sample":
          if (!allowDemo) throw new Error("Sample data is available only in a separate demo runtime");
          result = engine.loadSample();
          break;
        case "/api/workspace/sample":
          if (!allowDemo) throw new Error("Sample data is available only in a separate demo runtime");
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
          if (connector) {
            engine.discussions.participant(connector);
            const p = engine.workspace.index?.profile;
            if (!p?.active || !p.indexFiles || connector.scopeId !== p.id) throw new Error('Granted workspace content scope required');
            for (const id of [data.leftId, data.rightId]) {
              const node = engine.workspace.index.nodes.find(n => n.id === id && n.kind === 'worktree');
              if (!node || !p.hosts.includes(node.host) || scopePathExcluded(node.path, node.host, p.exclusions[node.host] ?? [])) throw new Error('Worktree outside connected scope');
              const rootPath = normalizeHostPath(node.path, node.host), separator = hostPaths(node.host).sep;
              if ((p.exclusions[node.host] ?? []).some(exclusion => { const path = normalizeHostPath(exclusion, node.host); return path === rootPath || path.startsWith(rootPath + separator); })) throw new Error('Comparison cannot honor excluded descendants; inspect permitted indexed files instead');
            }
          }
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
        code: e.code ?? null,
        uncertainOutcome: e.uncertainOutcome ?? null,
      });
    }
  });
  server.on("upgrade", (req, socket, head) => {
    const expected = "127.0.0.1:" + server.address().port;
    const deny = () => { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); };
    if (closing || req.headers.host !== expected || (req.headers.origin && req.headers.origin !== "http://" + expected) || req.headers["sec-fetch-site"] === "cross-site") return deny();
    const path = new URL(req.url, "http://" + expected).pathname;
    if (path === "/api/native/channel") {
      try {
        const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
        const binding = engine.connector(token); channels.validate(binding);
        if (channels.isConnected(binding.sessionId)) return deny();
        sockets.handleUpgrade(req, socket, head, ws => {
          const connected = channels.connect(binding, params => new Promise((yes, no) => ws.send(JSON.stringify(params), error => error ? no(error) : yes())));
          ws.on("close", connected.close); ws.on("error", connected.close);
        });
      } catch { deny(); }
      return;
    }
    const match = /^\/api\/native\/terminal\/([a-f0-9-]+)$/.exec(path);
    const cookie = /\bas_session=([a-f0-9]+)/.exec(req.headers.cookie ?? "")?.[1];
    if (!match || req.headers.origin !== "http://" + expected || !ownerBrowser.valid(cookie)) return deny();
    try {
      terminals.get(match[1]);
      sockets.handleUpgrade(req, socket, head, ws => {
        const id = match[1]; let detach;
        try { detach = terminals.attach(id, { onData: data => { if (ws.bufferedAmount > 262144) return false; ws.send(JSON.stringify({ type: "output", data })); return true; }, onExit: event => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "exit", exitCode: event.exitCode ?? null })); ws.close(); } }); }
        catch { ws.close(1008, "Terminal already attached or closed"); return; }
        ws.on("message", bytes => { try { const value = JSON.parse(bytes); if (value.type === "input") terminals.write(id, value.data); else if (value.type === "resize") terminals.resize(id, value.cols, value.rows); else throw new Error(); } catch { ws.close(1008, "Invalid native terminal message"); } });
        ws.on("close", () => detach?.()); ws.on("error", () => detach?.());
      });
    } catch { deny(); }
  });
  await new Promise((yes, no) => {
    server.once("error", no);
    server.listen(port, "127.0.0.1", yes);
  });
  const address = `http://127.0.0.1:${server.address().port}`;
  connections = new NativeConnections(engine, { root, address, remoteInstall });
  participantConnections = new ParticipantConnections(engine, { root, address, installRemote: participantInstallRemote, tunnelFactory: participantTunnelFactory });
  sourceBindings = new SourceBindings(engine, { root, address, resolveMetadata: sourceMetadataResolver });
  automaticConnections = new NativeAutoInstaller(engine, { sourceBindings, participantConnections, address, installLocal: automaticInstallLocal, installRemote: automaticInstallRemote, refreshNative: host => codexAgents.refreshTools(host) });
  if (desktopDiscovery && store.data.desktopPreferences?.nativeAutoSetup) automaticConnections.setup().catch(() => {});
  const runtimePath = join(root, "runtime.json");
  writeFileSync(
    runtimePath,
    JSON.stringify({ address, admin, instance, pid: process.pid }),
    { mode: 0o600 },
  );
  async function close() {
    await participantConnections.close();
    await codexAgents.close();
    if (engine.workspace.running) engine.workspace.cancel();
    terminals.closeAll();
    for (const ws of sockets.clients) ws.terminate();
    sockets.close();
    for (const abort of activeAnswers.values()) abort.abort();
    fabric.close();
    await new Promise((r) => server.close(r));
    if (existsSync(runtimePath)) {
      const current = JSON.parse(readFileSync(runtimePath, "utf8"));
      if (current.instance === instance) unlinkSync(runtimePath);
    }
  }
  return { server, engine, store, address, instance, admin, close, terminals, channels, connections, participantConnections, sourceBindings, automaticConnections, codexAgents, desktopDiscovery: desktopStartup };
}
