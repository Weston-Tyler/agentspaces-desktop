import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isAbsolute, posix } from "node:path";

const worker = fileURLToPath(new URL("./native-terminal-worker.mjs", import.meta.url));
const MAX_BUFFER = 256 * 1024;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const argumentsValid = args => Array.isArray(args) && args.length <= 30 &&
  args.every(a => typeof a === "string" && a.length <= 4096 && !a.includes("\0"));

export function terminalLaunch({ provider, host = "local", cwd, intent = "chat" }, trustedArgs = [], sshOptions = []) {
  if (!["codex", "claude"].includes(provider) || !["local", "remote"].includes(host) || !["chat", "login"].includes(intent))
    throw new Error("Unsupported native terminal provider, host or intent");
  if (!argumentsValid(trustedArgs)) throw new Error("Invalid internal native launch arguments");
  if (!Array.isArray(sshOptions)) throw new Error("Invalid internal SSH forwarding options");
  if (sshOptions.length) {
    const route = /^127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)$/.exec(sshOptions[3] ?? "");
    if (host !== "remote" || sshOptions.length !== 4 || sshOptions[0] !== "-o" ||
        sshOptions[1] !== "ExitOnForwardFailure=yes" || sshOptions[2] !== "-R" || !route ||
        route.slice(1).some(port => Number(port) < 1 || Number(port) > 65535))
      throw new Error("Only trusted loopback reverse forwarding is supported");
  }
  if (trustedArgs.some(a => ["-p", "--print", "--bare", "--dangerously-skip-permissions", "--dangerously-bypass-approvals-and-sandbox"].includes(a)))
    throw new Error("Native terminal requires interactive native approvals");
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.includes("\0") || cwd.length > 4096 || !(host === "remote" ? posix.isAbsolute(cwd) : isAbsolute(cwd))))
    throw new Error("Native working directory must be absolute for its host");
  const nativeArgs = intent === "login"
    ? provider === "codex" ? ["login", ...(host === "remote" ? ["--device-auth"] : [])] : ["auth", "login"]
    : trustedArgs;
  if (host === "local") return { file: provider + (process.platform === "win32" ? ".exe" : ""), args: nativeArgs, cwd: cwd ?? process.cwd() };
  const command = (cwd ? "cd -- " + quote(cwd) + " && " : "") + "exec " + provider +
    (nativeArgs.length ? " " + nativeArgs.map(quote).join(" ") : "");
  return { file: process.platform === "win32" ? "ssh.exe" : "ssh", args: ["-tt", ...sshOptions, "remote", command], cwd: process.cwd() };
}

/** Ephemeral native terminal handles only; no transcript, credential or work persistence. */
export class NativeTerminals {
  constructor({ spawnProcess = spawn, launchArgs = {}, resolveLaunch } = {}) {
    if (!launchArgs || typeof launchArgs !== "object" || Array.isArray(launchArgs)) throw new Error("Internal launch argument map required");
    if (resolveLaunch !== undefined && typeof resolveLaunch !== "function") throw new Error("Internal launch resolver must be a function");
    this.spawnProcess = spawnProcess; this.launchArgs = launchArgs; this.resolveLaunch = resolveLaunch; this.items = new Map();
  }
  metadata(t) { return { id: t.id, provider: t.provider, host: t.host, status: t.status, intent: t.intent, connectionId: t.connectionId ?? null }; }
  list() { return [...this.items.values()].map(t => this.metadata(t)); }
  get(id) { const t = this.items.get(id); if (!t) throw new Error("Unknown native terminal"); return this.metadata(t); }
  active(id) { const t = this.items.get(id); if (!t || !["starting", "running"].includes(t.status)) throw new Error("Native terminal is closed"); return t; }
  async create(options = {}) {
    if (options.launchArgs !== undefined || options.args !== undefined || options.env !== undefined || options.sshOptions !== undefined)
      throw new Error("Launch arguments are internal configuration only");
    if ([...this.items.values()].filter(t => ["starting", "running"].includes(t.status)).length >= 3) throw new Error("Three native terminals already open");
    const { provider, host = "local", intent = "chat", cwd, connectionId } = options;
    if (connectionId !== undefined && (typeof connectionId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(connectionId)))
      throw new Error("Invalid prepared connection identifier");
    const validated = { provider, host, intent, cwd };
    terminalLaunch(validated);
    if (connectionId && !this.resolveLaunch) throw new Error("Prepared native connections are unavailable");
    const resolved = await this.resolveLaunch?.({ ...validated, connectionId });
    const launch = terminalLaunch(validated, resolved?.args ?? this.launchArgs[provider] ?? [], resolved?.sshOptions ?? []);
    if ([...this.items.values()].filter(t => ["starting", "running"].includes(t.status)).length >= 3) throw new Error("Three native terminals already open");
    const id = randomUUID(), t = { id, provider, host, intent, connectionId, status: "starting", pendingOutput: "", attachment: null };
    this.items.set(id, t);
    let resolveReady, rejectReady;
    const ready = new Promise((yes, no) => { resolveReady = yes; rejectReady = no; });
    t.finish = event => {
      if (["closed", "exited", "failed"].includes(t.status)) return;
      t.status = event.status ?? "exited"; t.pendingOutput = ""; clearTimeout(t.timer);
      if (!t.ready) rejectReady(new Error("Native terminal failed to start"));
      try { t.attachment?.onExit?.({ ...event, id }); } catch {}
      t.attachment = null;
    };
    try {
      t.child = this.spawnProcess(process.env.AGENTSPACES_NODE_BINARY || "node", [worker], {
        windowsHide: true, shell: false, stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      t.child.on("message", message => {
        if (!message || typeof message.type !== "string") return;
        if (message.type === "ready" && t.status === "starting") { t.ready = true; t.status = "running"; clearTimeout(t.timer); resolveReady(this.metadata(t)); }
        else if (message.type === "data" && typeof message.data === "string" && ["starting", "running"].includes(t.status)) {
          if (Buffer.byteLength(message.data) > 8192) { this.close(id); return; }
          if (t.attachment) { try { if (t.attachment.onData?.(message.data) === false) this.close(id); } catch { this.close(id); } }
          else {
            t.pendingOutput += message.data;
            if (Buffer.byteLength(t.pendingOutput) > MAX_BUFFER) {
              t.pendingOutput = Buffer.from(t.pendingOutput).subarray(-MAX_BUFFER).toString("utf8");
              while (Buffer.byteLength(t.pendingOutput) > MAX_BUFFER) t.pendingOutput = t.pendingOutput.slice(1);
            }
          }
        } else if (message.type === "exit") t.finish({ status: "exited", exitCode: message.exitCode, signal: message.signal });
        else if (message.type === "error") { t.finish({ status: "failed", code: "native_terminal_failed" }); t.child.kill(); }
      });
      t.child.on("error", () => t.finish({ status: "failed", code: "native_terminal_failed" }));
      t.child.on("exit", () => t.finish({ status: "exited" }));
      t.timer = setTimeout(() => { this.close(id); }, 12000); t.timer.unref?.();
      t.child.send({ type: "start", launch });
    } catch { t.finish({ status: "failed" }); }
    return ready;
  }
  attach(id, { onData, onExit } = {}) {
    const t = this.active(id);
    if (t.attachment) throw new Error("Native terminal already attached");
    if (typeof onData !== "function" || typeof onExit !== "function") throw new Error("Terminal callbacks required");
    const attachment = { onData, onExit }; t.attachment = attachment;
    if (t.pendingOutput) { const pending = t.pendingOutput; t.pendingOutput = ""; try { if (onData(pending) === false) this.close(id); } catch { this.close(id); } }
    return () => { if (t.attachment === attachment) { t.attachment = null; this.close(id); } };
  }
  write(id, data) {
    const t = this.active(id);
    if (typeof data !== "string" || Buffer.byteLength(data) > 8192) throw new Error("Native input must be bounded to 8192 bytes");
    t.child.send({ type: "input", data });
  }
  resize(id, cols, rows) {
    const t = this.active(id);
    if (!Number.isInteger(cols) || cols < 20 || cols > 300 || !Number.isInteger(rows) || rows < 5 || rows > 150)
      throw new Error("Invalid native terminal dimensions");
    t.child.send({ type: "resize", cols, rows });
  }
  close(id) {
    const t = this.items.get(id); if (!t || ["closed", "exited", "failed"].includes(t.status)) return;
    t.finish({ status: "closed" });
    try { t.child?.send({ type: "close" }); } catch {}
    const kill = setTimeout(() => t.child?.kill(), 1000); kill.unref?.();
    t.child?.once("exit", () => clearTimeout(kill));
    while (this.items.size > 40) {
      const old = [...this.items].find(([, item]) => ["closed", "exited", "failed"].includes(item.status));
      if (!old) break; this.items.delete(old[0]);
    }
  }
  closeAll() { for (const id of this.items.keys()) this.close(id); }
}
