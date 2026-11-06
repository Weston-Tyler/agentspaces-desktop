import { REMOTE_HOST, SSH_ALIAS } from "./remote-host.mjs";
import { spawn } from "node:child_process";
import { resolve, posix } from "node:path";
import { hostOS } from "./platform.mjs";
import { NATIVE_VERSION_PINS, nativeCompatibility } from './native-versions.mjs';
export const compatibility = NATIVE_VERSION_PINS.local;
export function openNativeSignIn(provider, host = "local") {
  if (process.platform !== "win32")
    throw new Error(
      "This companion sign-in launcher is qualified only for Windows",
    );
  if (
    !["local", REMOTE_HOST].includes(host) ||
    !["codex", "claude"].includes(provider)
  )
    throw new Error("Unsupported native provider or host");
  const native =
    provider === "codex"
      ? host === REMOTE_HOST
        ? "codex login --device-auth"
        : "codex login"
      : "claude auth login";
  const authCommand = (host === REMOTE_HOST ? "ssh " + SSH_ALIAS + " " : "") + native;
  const command =
    "Start-Process -FilePath 'cmd.exe' -ArgumentList '/k','" +
    authCommand +
    "' -WindowStyle Normal";
  const child = spawn("powershell.exe", ["-NoProfile", "-Command", command], {
    windowsHide: true,
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
  return {
    status: "Native sign-in terminal requested",
    provider,
    host,
    authentication:
      "Provider-owned flow; no authentication result or credentials collected",
  };
}
// Read-only discovery must not inherit an interactive SSH terminal or wait for stdin.
export function readNativeVersion(host, provider, { spawnProcess = spawn, platform = process.platform, timeoutMs = 5000 } = {}) {
  if (!["local", REMOTE_HOST].includes(host) || !["codex", "claude"].includes(provider)) throw new Error("Unsupported native provider or host");
  return new Promise((resolveVersion, reject) => {
    let child, output = "", size = 0, settled = false;
    const finish = (code, value) => { if (settled) return; settled = true; clearTimeout(timer); code ? reject(Object.assign(new Error(code), { code })) : resolveVersion(value); };
    const timer = setTimeout(() => { finish("native_version_probe_timeout"); child?.kill(); }, timeoutMs);
    const remoteCommand = provider === "claude" ? 'if [ -x "$HOME/.local/bin/claude" ]; then exec "$HOME/.local/bin/claude" --version; else exec claude --version; fi' : "codex --version";
    try {
      child = spawnProcess(host === "local" ? provider : "ssh", host === "local" ? ["--version"] : ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", SSH_ALIAS, remoteCommand], {
        windowsHide: true, shell: false, stdio: ["ignore", platform === "win32" ? "overlapped" : "pipe", platform === "win32" ? "overlapped" : "pipe"],
      });
      child.stdout.on("data", chunk => { size += Buffer.byteLength(chunk); if (size > 16384) { finish("native_version_probe_oversized"); child.kill(); } else output += chunk.toString(); });
      child.stderr.on("data", () => {}); // Native/SSH diagnostics may contain private login URLs.
      child.on("error", error => finish(host === "local" && error.code === "ENOENT" ? "native_executable_missing" : "native_version_probe_unavailable"));
      child.on("close", code => finish(code === 0 && output.trim() ? null : host !== "local" && code === 127 ? "native_executable_missing" : "native_version_probe_unavailable", output.trim()));
    } catch { finish("native_version_probe_unavailable"); }
  });
}
export async function detectTools(host = "local", { readVersion = readNativeVersion, qualify = nativeCompatibility } = {}) {
  if (!["local", REMOTE_HOST].includes(host)) throw new Error("Unsupported host");
  return Promise.all(
    ["codex", "claude"].map(async (provider) => {
      try {
        const version = await readVersion(host, provider);
        const pin = NATIVE_VERSION_PINS[host][provider];
        const compatible = await qualify(host, provider, version);
        return {
          provider,
          host,
          os: hostOS(host),
          installed: true,
          version,
          qualifiedVersion: pin,
          ...compatible,
          authentication: "Not inspected",
          capabilities: {
            mcp: true,
            metadata:
              provider === "codex"
                ? "Explicit project grant; experimental app-server over native transport"
                : "Pinned SDK read-only metadata; native state may be unknown",
            content: "Separate content grant; bounded native read",
            execution: "Not qualified",
          },
          nativeSignInCommand:
            (host === REMOTE_HOST ? "ssh " + SSH_ALIAS + " " : "") +
            (provider === "codex" ? "codex login" : "claude auth login"),
        };
      } catch (error) {
        return {
          provider,
          host,
          installed: false,
          installationObserved: error.code === "native_executable_missing",
          discoveryError: ["native_executable_missing", "native_version_probe_timeout", "native_version_probe_oversized"].includes(error.code) ? error.code : "native_version_probe_unavailable",
          authentication: "Not inspected",
          capabilities: { execution: "Unavailable" },
        };
      }
    }),
  );
}
export class CodexReadAdapter {
  #threadCreationEnabled;
  constructor({
    spawnProcess = spawn,
    host = "local",
    onDiagnostic = () => {},
    enableThreadCreation = false,
  } = {}) {
    if (!["local", REMOTE_HOST].includes(host))
      throw new Error("Unsupported host");
    this.host = host;
    this.onDiagnostic = onDiagnostic;
    this.#threadCreationEnabled = enableThreadCreation === true;
    this.normalize =
      host === REMOTE_HOST
        ? (value) => posix.normalize(value).replace(/\/$/, "")
        : resolve;
    this.spawnProcess = spawnProcess;
    this.requests = new Map();
    this.id = 0;
    this.buffer = "";
  }
  async open() {
    this.child = this.spawnProcess(
      this.host === "local" ? "codex" : "ssh",
      this.host === "local"
        ? ["app-server", "--stdio"]
        : [SSH_ALIAS, "codex", "app-server", "--stdio"],
      { stdio: process.platform === "win32" ? ["overlapped", "overlapped", "overlapped"] : ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    this.child.stderr.on("data", () => {}); // Provider logs can contain private material. Never persist them.
    this.child.stdout.on("data", (d) => {
      this.buffer += d.toString();
      if (this.buffer.length > 16 * 1024 * 1024) {
        this.close();
        return;
      }
      let i;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        let v;
        try {
          v = JSON.parse(line);
        } catch {
          continue;
        }
        const p = this.requests.get(v.id);
        if (p) {
          clearTimeout(p.timer);
          this.requests.delete(v.id);
          v.error
            ? p.reject(new Error("Native read request rejected"))
            : p.resolve(v.result);
        }
      }
    });
    this.child.on("error", () => {
      this.onDiagnostic({ event: "processError" });
      this.fail();
    });
    this.child.on("exit", (code) => {
      this.onDiagnostic({ event: "processExit", code });
      this.fail();
    });
    await this.rpc("initialize", {
      clientInfo: { name: "agentspaces_desktop", version: "0.1.0-alpha.1" },
      capabilities: { experimentalApi: false },
    });
    this.child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  }
  rpc(method, params) {
    if (!["initialize", "thread/list", "thread/read"].includes(method))
      throw new Error("Read-only adapter refuses this method");
    return this.#request(method, params);
  }
  createEmptyThread(cwd) {
    if (!this.#threadCreationEnabled)
      throw new Error("Thread creation is not enabled on this adapter");
    return this.#request("thread/start", { cwd, ephemeral: false });
  }
  setThreadName(threadId, name) {
    if (!this.#threadCreationEnabled)
      throw new Error("Thread creation is not enabled on this adapter");
    return this.#request("thread/name/set", { threadId, name });
  }
  #request(method, params) {
    return new Promise((res, rej) => {
      this.onDiagnostic({ event: "request", method });
      const id = ++this.id;
      const timer = setTimeout(
        () => {
          this.requests.delete(id);
          this.onDiagnostic({ event: "timeout", method });
          rej(new Error("Native read timed out; no automatic retry"));
        },
        method === "thread/list" ? 30000 : 8000,
      );
      this.requests.set(id, {
        resolve: (value) => {
          this.onDiagnostic({ event: "response", method });
          res(value);
        },
        reject: (error) => {
          this.onDiagnostic({ event: "rejected", method });
          rej(error);
        },
        timer,
      });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  async discover(project, archived = false, cursor = null) {
    if (!project.metadataGrant)
      throw new Error("Project metadata grant required");
    const result = await this.rpc("thread/list", {
      ...(project.allMetadataGrant ? {} : { cwd: project.path }),
      ...(project.allMetadataGrant
        ? {
            sourceKinds: [
              "cli",
              "vscode",
              "exec",
              "appServer",
              "subAgent",
              "subAgentReview",
              "subAgentCompact",
              "subAgentThreadSpawn",
              "subAgentOther",
              "unknown",
            ],
          }
        : {}),
      archived,
      limit: 50,
      cursor,
      sortKey: "updated_at",
      sortDirection: "desc",
    });
    return {
      sessions: (result.data ?? [])
        .filter(
          (t) =>
            project.allMetadataGrant ||
            (t.cwd && this.normalize(t.cwd) === this.normalize(project.path)),
        )
        .map((t) => ({
          id: t.id,
          nativeThreadId: t.id,
          provider: "codex",
          host: this.host,
          cwd: t.cwd,
          account: project.account,
          project: project.id,
          title: t.name || "Untitled native session",
          surface: "native session (surface not inferred)",
          status: archived
            ? "archived"
            : t.status?.type === "active"
              ? "current"
              : t.status?.type === "idle"
                ? "dormant"
                : "unknown",
          executionObservation: { state: t.status?.type ?? 'unknown', observedAt: new Date().toISOString(), source: 'native-thread-list' },
          updatedAt: new Date((t.updatedAt ?? 0) * 1000).toISOString(),
          sourceVersion: String(t.updatedAt ?? ""),
          topics: [],
          fixture: false,
        })),
      nextCursor: result.nextCursor ?? null,
    };
  }
  async read(session, project) {
    if (!project.metadataGrant || session.project !== project.id)
      throw new Error("Project denied");
    const { thread } = await this.rpc("thread/read", {
      threadId: session.nativeThreadId ?? session.id,
      includeTurns: true,
    });
    if (
      !thread.cwd ||
      this.normalize(thread.cwd) !== this.normalize(project.path)
    )
      throw new Error("Native project mismatch");
    const chunks = [];
    for (const turn of thread.turns ?? [])
      for (const item of turn.items ?? [])
        if (item.type === "agentMessage" && typeof item.text === "string")
          chunks.push(item.text);
    const text = chunks.join("\n\n").slice(-16000);
    return {
      title: session.title,
      summary: text.slice(0, 2000),
      artifact: { name: "approved-excerpt.txt", text },
      capturedAt: new Date().toISOString(),
      sourceVersion: String(thread.updatedAt),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      bounded: true,
      originalTurns: thread.turns?.length ?? 0,
    };
  }
  fail() {
    for (const p of this.requests.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Native connection closed"));
    }
    this.requests.clear();
  }
  close() {
    this.child?.kill();
    this.fail();
  }
}
