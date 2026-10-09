import { randomUUID, randomInt, createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, lstatSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertUnlinkedParents } from "./native-connections.mjs";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const hash = token => createHash("sha256").update(token).digest("hex");
const error = message => new Error(message);
function runPrivateProcess(command, args, { input = "", timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let output = "", settled = false;
    const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const finish = (failure, value) => { if (settled) return; settled = true; clearTimeout(timer); if (failure) { child.kill(); reject(failure); } else resolve(value); };
    const timer = setTimeout(() => finish(error("Participant connection verification timed out")), timeoutMs);
    child.stdout.on("data", chunk => { output += chunk.toString(); if (output.length > 65536) finish(error("Participant verification response exceeded its bound")); });
    child.stderr.on("data", () => {}); // No provider, token, source content or diagnostics logging.
    child.on("error", () => finish(error("Participant connection verification unavailable")));
    child.on("close", code => { try { const result = JSON.parse(output); if (code !== 0 || result.isError === true || result.ok === false) throw error("Invalid result"); finish(null, result); } catch { finish(error("Participant discovery refused or unavailable")); } });
    child.stdin.on("error", () => finish(error("Participant connection transfer unavailable"))); child.stdin.end(input);
  });
}
function createTunnel({ remotePort, localPort, host }) {
  const child = spawn("ssh", ["-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-R", "127.0.0.1:" + remotePort + ":127.0.0.1:" + localPort, host], { windowsHide: true, shell: false, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", () => {});
  let exited = false; child.on("error", () => { exited = true; }); child.on("close", () => { exited = true; });
  return { child, get exited() { return exited; }, close: () => child.kill("SIGTERM") };
}
async function verifyLocalDiscovery({ cliPath, configPath, nativeThreadId }) {
  const nodeBinary = process.env.AGENTSPACES_NODE_BINARY ?? (process.versions.electron ? "node" : process.execPath);
  const result = await runPrivateProcess(nodeBinary, [cliPath, "--config", configPath, "--source", nativeThreadId, "discover"]);
  if (result.nativeThreadId !== nativeThreadId || !Array.isArray(result.result)) throw error("Participant scoped discovery response identity mismatch");
  return "verified-http-200";
}
export async function installRemoteParticipant({ connectionId, config, source }) {
  if (!UUID.test(connectionId ?? "") || config?.schema !== 1 || !UUID.test(config.nativeThreadId ?? "") || !/^[a-f0-9]{64}$/.test(config.token ?? "") || !/^http:\/\/127\.0\.0\.1:\d+$/.test(config.address ?? "") || !/^127\.0\.0\.1:\d+$/.test(config.authority ?? "") || config.host !== "remote" || !["codex", "claude"].includes(config.provider) || typeof source !== "string" || !source || source.length > 131072) throw error("Invalid managed participant installation payload");
  const payload = JSON.stringify({ connectionId, config, source });
  const script = `import{mkdirSync,writeFileSync,readFileSync,lstatSync,existsSync,renameSync}from'node:fs';import{homedir}from'node:os';import{join,resolve,dirname}from'node:path';import{createHash,randomUUID}from'node:crypto';import{spawnSync}from'node:child_process';
${assertUnlinkedParents.toString()}
const p=${payload};const base=join(homedir(),'.agentspaces-desktop-native');assertUnlinkedParents(base);
const owner=join(base,'OWNER');if(existsSync(base)){if(!existsSync(owner)||lstatSync(owner).isSymbolicLink()||readFileSync(owner,'utf8')!=='agentspaces-native-channel-v1')throw Error('Unmanaged participant base');}else{mkdirSync(base,{mode:0o700});writeFileSync(owner,'agentspaces-native-channel-v1',{mode:0o600,flag:'wx'});}
const runtime=join(base,'participant-runtime');assertUnlinkedParents(runtime);mkdirSync(runtime,{recursive:true,mode:0o700});const marker=join(runtime,'OWNER');if(existsSync(marker)){if(lstatSync(marker).isSymbolicLink()||readFileSync(marker,'utf8')!=='agentspaces-participant-runtime-v1')throw Error('Unmanaged participant runtime');}else{if((await import('node:fs')).readdirSync(runtime).length)throw Error('Unmanaged participant runtime');writeFileSync(marker,'agentspaces-participant-runtime-v1',{flag:'wx',mode:0o600});}
const digest=createHash('sha256').update(p.source).digest('hex');const cliPath=join(runtime,'participant-cli-'+digest+'.mjs');if(existsSync(cliPath)){if(lstatSync(cliPath).isSymbolicLink()||readFileSync(cliPath,'utf8')!==p.source)throw Error('Participant module changed');}else{const temp=join(runtime,'module-'+randomUUID()+'.tmp');writeFileSync(temp,p.source,{flag:'wx',mode:0o600});renameSync(temp,cliPath);}
const dir=join(base,'connections',p.connectionId);assertUnlinkedParents(dir);mkdirSync(dir,{recursive:true,mode:0o700});assertUnlinkedParents(dir);const configPath=join(dir,'participant.json');writeFileSync(configPath,JSON.stringify(p.config),{flag:'wx',mode:0o600});
let verified=false;const deadline=Date.now()+12000;while(Date.now()<deadline){const check=spawnSync(process.execPath,[cliPath,'--config',configPath,'--source',p.config.nativeThreadId,'discover'],{encoding:'utf8',timeout:2000,maxBuffer:65536});if(check.status===0){try{const result=JSON.parse(check.stdout);if(result.nativeThreadId===p.config.nativeThreadId&&Array.isArray(result.result)){verified=true;break;}}catch{}}await new Promise(resolve=>setTimeout(resolve,250));}
if(!verified)throw Error('Participant discovery unavailable');console.log(JSON.stringify({configPath,cliPath,transportStatus:'verified-http-200'}));`;
  const result = await runPrivateProcess("ssh", ["remote", "node --input-type=module -"], { input: script, timeoutMs: 30000 });
  if (typeof result.configPath !== "string" || !result.configPath.endsWith("/connections/" + connectionId + "/participant.json") || typeof result.cliPath !== "string" || !/\/participant-runtime\/participant-cli-[a-f0-9]{64}\.mjs$/.test(result.cliPath) || result.transportStatus !== "verified-http-200") throw error("Participant installation result was not verified");
  return result;
}

export class ParticipantConnections {
  constructor(engine, { root, address, installRemote = installRemoteParticipant, tunnelFactory = createTunnel, verifyLocal = verifyLocalDiscovery } = {}) {
    if (typeof root !== "string" || !isAbsolute(root) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(address ?? "") || !new URL(address).port) throw error("Owned absolute root and literal-loopback companion address required");
    Object.assign(this, { engine, root, address, installRemote, tunnelFactory, verifyLocal });
    this.tunnels = new Map(); this.tunnelPending = new Map(); this.closed = false;
    const saved = engine.store.data.participantBridge;
    const valid = saved && typeof saved === "object" && !Array.isArray(saved) && Object.keys(saved).length === 3 && saved.host === "remote" && Number.isInteger(saved.remotePort) && saved.remotePort > 1023 && saved.remotePort <= 65535 && saved.authority === new URL(address).host;
    this.savedBridge = valid ? { ...saved } : null;
    this.bridgeRestore = { status: valid ? "restoring" : saved ? "ignored-invalid-record" : "not-configured" };
    // Restore only the app-owned transport. This never creates a connector,
    // changes source grants, reads conversations or resumes a native session.
    this.restorePromise = valid ? Promise.resolve().then(() => this.tunnel()).then(() => { this.bridgeRestore.status = "owned-tunnel-started"; return { status: this.bridgeRestore.status }; }).catch(() => { this.bridgeRestore.status = "unavailable"; return { status: "unavailable" }; }) : Promise.resolve({ status: this.bridgeRestore.status });
  }
  source(sessionId) {
    if (this.closed) throw error("Participant connection service closed");
    const source = this.engine.session(sessionId), grant = this.engine.permissions(source);
    if (source.fixture || !["codex", "claude"].includes(source.provider) || !["local", "remote"].includes(source.host ?? "local") || !UUID.test(source.nativeThreadId ?? "")) throw error("Supported discovered native source required");
    if (!grant.enrolled || !grant.retrieve || !grant.share) throw error("Participant enrollment, retrieval and sharing grants required");
    return source;
  }
  async tunnel() {
    if (this.closed) throw error("Participant connection service closed");
    const key = "remote:" + new URL(this.address).port;
    const existing = this.tunnels.get(key); if (existing && !existing.exited) return existing;
    if (this.tunnelPending.has(key)) return this.tunnelPending.get(key);
    if (this.tunnels.size + this.tunnelPending.size >= 4) throw error("Owned participant tunnel limit reached");
    const pending = (async () => {
      let remotePort = this.savedBridge?.remotePort ?? randomInt(40000, 60000); const localPort = Number(new URL(this.address).port);
      if (!this.savedBridge && remotePort === localPort) remotePort = remotePort < 59999 ? remotePort + 1 : remotePort - 1;
      const handle = await this.tunnelFactory({ remotePort, localPort, host: "remote" });
      if (this.closed || handle.exited || handle.child?.exitCode != null) { handle.close(); throw error("Owned participant tunnel unavailable"); }
      const tunnel = { key, remotePort, handle, exited: false, uses: this.savedBridge ? 1 : 0 };
      const exited = () => { tunnel.exited = true; this.bridgeRestore.status = "unavailable"; if (this.tunnels.get(key) === tunnel) this.tunnels.delete(key); };
      handle.child?.on("error", exited); handle.child?.on("close", exited);
      this.tunnels.set(key, tunnel); return tunnel;
    })();
    this.tunnelPending.set(key, pending);
    try { return await pending; } finally { this.tunnelPending.delete(key); }
  }
  async prepare({ sessionId }) {
    const current = this.source(sessionId), snapshot = { nativeThreadId: current.nativeThreadId, provider: current.provider, host: current.host ?? "local", account: current.account, project: current.project, scopeId: current.scopeId ?? null };
    const connectionId = randomUUID();
    if (snapshot.host === "local") assertUnlinkedParents(join(this.root, "native-connections", connectionId));
    const connector = this.engine.issueConnector(sessionId); let tunnel;
    try {
      if (snapshot.host === "remote") tunnel = await this.tunnel();
      if (tunnel?.exited) throw error("Participant tunnel exited before verification");
      const address = tunnel ? "http://127.0.0.1:" + tunnel.remotePort : this.address;
      const config = { schema: 1, address, authority: new URL(this.address).host, token: connector.token, sessionId, nativeThreadId: snapshot.nativeThreadId, host: snapshot.host, provider: snapshot.provider };
      const localCLI = fileURLToPath(new URL("./participant-cli.mjs", import.meta.url));
      let installed;
      if (tunnel) installed = await this.installRemote({ connectionId, config, source: readFileSync(localCLI, "utf8") });
      else {
        const folder = join(this.root, "native-connections", connectionId); mkdirSync(folder, { recursive: true, mode: 0o700 }); assertUnlinkedParents(folder);
        const configPath = join(folder, "participant.json"); writeFileSync(configPath, JSON.stringify(config), { flag: "wx", mode: 0o600 });
        installed = { configPath, cliPath: localCLI, transportStatus: await this.verifyLocal({ cliPath: localCLI, configPath, nativeThreadId: snapshot.nativeThreadId }) };
      }
      const latest = this.source(sessionId);
      if (this.closed || tunnel?.exited || latest.nativeThreadId !== snapshot.nativeThreadId || latest.provider !== snapshot.provider || (latest.host ?? "local") !== snapshot.host || latest.account !== snapshot.account || latest.project !== snapshot.project || (latest.scopeId ?? null) !== snapshot.scopeId) throw error("Participant source or transport changed during preparation");
      this.engine.connector(connector.token);
      if (installed.transportStatus !== "verified-http-200") throw error("Participant scoped discovery was not verified");
      if (tunnel) {
        const record = { host: "remote", remotePort: tunnel.remotePort, authority: new URL(this.address).host };
        if (JSON.stringify(this.engine.store.data.participantBridge) !== JSON.stringify(record)) { this.engine.store.data.participantBridge = record; this.engine.store.save(); }
        this.savedBridge = record; tunnel.uses++; this.bridgeRestore.status = "verified-http-200";
      }
      return { connectionId, configPath: installed.configPath, cliPath: installed.cliPath, nativeThreadId: snapshot.nativeThreadId, host: snapshot.host, transportStatus: installed.transportStatus,
        usageCommand: ["node", installed.cliPath, "--config", installed.configPath, "--source", snapshot.nativeThreadId, "discover"] };
    } catch {
      delete this.engine.store.data.connectors[hash(connector.token)]; this.engine.store.save();
      if (tunnel && tunnel.uses === 0) { tunnel.handle.close(); this.tunnels.delete(tunnel.key); }
      throw error("Participant connection preparation failed; new capability revoked");
    }
  }
  close() { this.closed = true; for (const tunnel of this.tunnels.values()) tunnel.handle.close(); this.tunnels.clear(); }
}
