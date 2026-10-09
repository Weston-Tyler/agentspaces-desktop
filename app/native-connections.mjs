import { randomUUID, randomInt, createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, lstatSync, existsSync, renameSync } from "node:fs";
import { join, isAbsolute, posix, resolve, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function assertUnlinkedParents(path) {
  let current = resolve(path);
  while (true) {
    let stat;
    try { stat = lstatSync(current); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Native connection parent must be an unlinked directory");
    }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
export function installChannelAssets({ base, payload, installDependencies, verifyDependencies }) {
  if (!/^[a-f0-9-]{36}$/i.test(payload?.id ?? "") || typeof payload.source !== "string" || !payload.source || typeof payload.token !== "string" || !payload.token || !/^http:\/\/127\.0\.0\.1:\d+$/.test(payload.address ?? "")) throw new Error("Invalid native channel installation payload");
  assertUnlinkedParents(base);
  const marker = join(base, "OWNER");
  if (existsSync(base)) {
    if (!existsSync(marker) || lstatSync(marker).isSymbolicLink() || !lstatSync(marker).isFile() || readFileSync(marker, "utf8") !== "agentspaces-native-channel-v1") throw new Error("Unmanaged native bridge directory");
  } else { mkdirSync(base, { mode: 0o700 }); writeFileSync(marker, "agentspaces-native-channel-v1", { mode: 0o600, flag: "wx" }); }
  const runtime = join(base, "runtime-mcp-1.32.1-ws-8.22.0-zod-4.6.5");
  assertUnlinkedParents(runtime); mkdirSync(runtime, { mode: 0o700, recursive: true });
  const ready = join(runtime, "READY"), packageFile = join(runtime, "package.json");
  if (existsSync(ready) && (lstatSync(ready).isSymbolicLink() || !lstatSync(ready).isFile())) throw new Error("Linked native runtime readiness marker");
  const readyValid = existsSync(ready) && readFileSync(ready, "utf8") === "agentspaces-channel-dependencies-v1" && verifyDependencies(runtime);
  if (!readyValid) {
    if (existsSync(packageFile) && (lstatSync(packageFile).isSymbolicLink() || !lstatSync(packageFile).isFile())) throw new Error("Linked native dependency manifest");
    writeFileSync(packageFile, JSON.stringify({ private: true, type: "module", dependencies: { "@modelcontextprotocol/sdk": "1.32.1", ws: "8.22.0", zod: "4.6.5" } }), { mode: 0o600 });
    if (!installDependencies(runtime) || !verifyDependencies(runtime)) throw new Error("Native bridge dependency preparation failed; runtime is not ready");
    const readyTemp = join(runtime, "READY-" + randomUUID()); writeFileSync(readyTemp, "agentspaces-channel-dependencies-v1", { flag: "wx", mode: 0o600 }); renameSync(readyTemp, ready);
  }
  const hash = createHash("sha256").update(payload.source).digest("hex");
  const entry = join(runtime, "claude-channel-" + hash + ".mjs");
  if (existsSync(entry)) {
    if (lstatSync(entry).isSymbolicLink() || !lstatSync(entry).isFile() || readFileSync(entry, "utf8") !== payload.source) throw new Error("Native channel module bytes changed");
  } else { const temp = join(runtime, "module-" + randomUUID() + ".tmp"); writeFileSync(temp, payload.source, { flag: "wx", mode: 0o600 }); renameSync(temp, entry); }
  const dir = join(base, payload.id); assertUnlinkedParents(dir); mkdirSync(dir, { mode: 0o700 });
  const file = join(dir, "mcp.json");
  if (payload.authority && !/^127\.0\.0\.1:\d+$/.test(payload.authority)) throw new Error("Literal-loopback bridge authority required");
  writeFileSync(file, JSON.stringify({ mcpServers: { agentspaces: { command: "node", args: [entry], env: { AGENTSPACES_URL: payload.address, AGENTSPACES_CONNECTOR_TOKEN: payload.token, ...(payload.authority ? { AGENTSPACES_COMPANION_AUTHORITY: payload.authority } : {}) } } } }), { flag: "wx", mode: 0o600 });
  return file;
}
export class NativeConnections {
  constructor(engine, { root, address, remoteInstall = installRemoteChannel } = {}) {
    if (typeof root !== "string" || !isAbsolute(root) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(address ?? "") || !new URL(address).port) throw new Error("Absolute owned state root and literal-loopback companion address required");
    this.engine = engine; this.root = root; this.address = address; this.remoteInstall = remoteInstall; this.items = new Map();
  }
  source(id) {
    const source = this.engine.session(id), grant = this.engine.permissions(source);
    if (!["local", "remote"].includes(source.host ?? "local")) throw new Error("Native source host is unsupported");
    if (source.fixture || source.provider !== "claude") throw new Error("Choose a discovered native Claude Code thread");
    if (!grant.enrolled || !grant.content || !grant.share || !grant.retrieve) throw new Error("Enroll the native source and grant content, sharing and retrieval before connecting");
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(source.nativeThreadId ?? "")) throw new Error("Native source UUID is unavailable");
    if (source.status === "current") throw new Error("This source is marked active; use its native owner rather than open another controller");
    const cwd = source.cwd ?? this.engine.target(source).path;
    if (typeof cwd !== "string" || !(source.host === "remote" ? posix.isAbsolute(cwd) : isAbsolute(cwd))) throw new Error("Native source working directory is unavailable");
    return { source, cwd };
  }
  async prepare({ sessionId }) {
    const { source, cwd } = this.source(sessionId), host = source.host ?? "local", id = randomUUID();
    if (host === "local") assertUnlinkedParents(join(this.root, "native-connections", id));
    const connector = this.engine.issueConnector(sessionId);
    const remotePort = host === "remote" ? randomInt(40000, 60000) : null;
    const bridgeAddress = host === "remote" ? "http://127.0.0.1:" + remotePort : this.address;
    const entry = new URL("./claude-channel.mjs", import.meta.url);
    let configPath;
    try {
    if (host === "remote") configPath = await this.remoteInstall({ id, token: connector.token, address: bridgeAddress, authority: new URL(this.address).host, source: readFileSync(entry, "utf8") });
    else {
      const folder = join(this.root, "native-connections", id); mkdirSync(folder, { recursive: true, mode: 0o700 });
      assertUnlinkedParents(folder);
      if (lstatSync(folder).isSymbolicLink()) throw new Error("Native connection folder must not be linked");
      configPath = join(folder, "mcp.json");
      writeFileSync(configPath, JSON.stringify({ mcpServers: { agentspaces: { command: "node", args: [fileURLToPath(entry)], env: { AGENTSPACES_URL: bridgeAddress, AGENTSPACES_CONNECTOR_TOKEN: connector.token } } } }, null, 2), { flag: "wx", mode: 0o600 });
    }
    } catch (error) {
      delete this.engine.store.data.connectors[createHash("sha256").update(connector.token).digest("hex")]; this.engine.store.save(); throw error;
    }
    this.items.set(id, { id, sessionId, nativeThreadId: source.nativeThreadId, provider: "claude", host, cwd, configPath, remotePort, project: source.project, account: source.account, scopeId: source.scopeId ?? null, connectorKey: createHash("sha256").update(connector.token).digest("hex") });
    return { connectionId: id, sessionId, provider: "claude", host, cwd, configPath, channelName: "agentspaces", nativeIdentityVerified: false,
      publicInstructions: "Opening this prepared connection visibly resumes the selected native thread. Close any other controller first. Claude owns login and permissions, and asks you to confirm the preview development channel. The connector binds a source reference; native caller identity is not independently verified. No API key or provider token is stored by this bridge." };
  }
  resolveLaunch({ connectionId, provider, host, cwd, intent }) {
    if (!connectionId) return undefined;
    const item = this.items.get(connectionId);
    if (!item || provider !== item.provider || host !== item.host || cwd !== item.cwd || intent !== "chat") throw new Error("Prepared native connection does not match this launch");
    if (this.engine.store.data.connectors[item.connectorKey]?.sessionId !== item.sessionId) throw new Error("Prepared native connector was revoked");
    const { source, cwd: currentCwd } = this.source(item.sessionId);
    if (source.nativeThreadId !== item.nativeThreadId || (source.host ?? "local") !== item.host || currentCwd !== item.cwd || source.project !== item.project || source.account !== item.account || (source.scopeId ?? null) !== item.scopeId) throw new Error("Prepared native source changed");
    return { args: ["--resume", item.nativeThreadId, "--mcp-config", item.configPath, "--dangerously-load-development-channels", "server:agentspaces"],
      sshOptions: item.host === "remote" ? ["-o", "ExitOnForwardFailure=yes", "-R", "127.0.0.1:" + item.remotePort + ":127.0.0.1:" + new URL(this.address).port] : [] };
  }
}
async function installRemoteChannel({ id, token, address, authority, source }) {
  const payload = { id, token, address, authority, source };
  const script = "import {mkdirSync,writeFileSync,existsSync,readFileSync,lstatSync,renameSync} from 'node:fs'; import {homedir} from 'node:os'; import {join,resolve,dirname} from 'node:path'; import {spawnSync} from 'node:child_process'; import {createHash,randomUUID} from 'node:crypto';\n" +
    assertUnlinkedParents.toString() + "\n" + installChannelAssets.toString() + "\n" +
    "const payload=" + JSON.stringify(payload) + "; const base=join(homedir(),'.agentspaces-desktop-native');\n" +
    "const installDependencies=runtime=>spawnSync('npm',['install','--ignore-scripts','--no-audit','--no-fund'],{cwd:runtime,stdio:'ignore',timeout:90000}).status===0;\n" +
    "const verifyDependencies=runtime=>spawnSync(process.execPath,['--input-type=module','-e',\"import{readFileSync}from'node:fs';for(const[name,version]of[['@modelcontextprotocol/sdk','1.32.1'],['ws','8.22.0'],['zod','4.6.5']]){if(JSON.parse(readFileSync('node_modules/'+name+'/package.json','utf8')).version!==version)throw Error('Dependency version mismatch');}await import('@modelcontextprotocol/sdk/server/mcp.js');await import('ws');await import('zod');\"],{cwd:runtime,stdio:'ignore',timeout:10000}).status===0;\n" +
    "const configPath=installChannelAssets({base,payload,installDependencies,verifyDependencies});console.log(JSON.stringify({configPath}));";
  return new Promise((yes, no) => {
    const child = spawn("ssh", ["remote", "node --input-type=module -"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; const timeout = setTimeout(() => { child.kill(); no(new Error("Native bridge preparation timed out")); }, 100000);
    child.stdout.on("data", bytes => { output += bytes; if (output.length > 65536) child.kill(); }); child.stderr.on("data", () => {});
    child.on("error", () => { clearTimeout(timeout); no(new Error("Native bridge preparation unavailable")); });
    child.on("close", code => { clearTimeout(timeout); try { const result = JSON.parse(output); if (code || typeof result.configPath !== "string" || !result.configPath.endsWith("/" + id + "/mcp.json")) throw new Error(); yes(result.configPath); } catch { no(new Error("Native bridge preparation failed; existing native configuration was preserved")); } });
    child.stdin.end(script);
  });
}
