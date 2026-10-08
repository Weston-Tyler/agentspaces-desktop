import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, posix } from "node:path";
const exec = promisify(execFile);
export const compatibility = { codex: "0.162.0-alpha.2", claude: "2.1.113" };
export function openNativeSignIn(provider, host = "local") {
  if (process.platform !== "win32")
    throw new Error(
      "This companion sign-in launcher is qualified only for Windows",
    );
  if (
    !["local", "remote"].includes(host) ||
    !["codex", "claude"].includes(provider)
  )
    throw new Error("Unsupported native provider or host");
  const native =
    provider === "codex"
      ? host === "remote"
        ? "codex login --device-auth"
        : "codex login"
      : "claude auth login";
  const authCommand = (host === "remote" ? "ssh remote " : "") + native;
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
export async function detectTools(host = "local") {
  if (!["local", "remote"].includes(host)) throw new Error("Unsupported host");
  return Promise.all(
    ["codex", "claude"].map(async (provider) => {
      try {
        const { stdout } = await exec(
          host === "local" ? provider : "ssh",
          host === "local" ? ["--version"] : ["remote", provider, "--version"],
          { timeout: 5000, windowsHide: true },
        );
        const version = stdout.trim();
        const pin =
          host === "remote"
            ? provider === "codex"
              ? "0.161.0"
              : "2.1.283"
            : compatibility[provider];
        return {
          provider,
          host,
          os: host === "remote" ? "Linux" : "Windows",
          installed: true,
          version,
          qualifiedVersion: pin,
          versionMatches: version.includes(pin),
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
            (host === "remote" ? "ssh remote " : "") +
            (provider === "codex" ? "codex login" : "claude auth login"),
        };
      } catch {
        return {
          provider,
          host,
          installed: false,
          authentication: "Not inspected",
          capabilities: { execution: "Unavailable" },
        };
      }
    }),
  );
}
export class CodexReadAdapter {
  constructor({ spawnProcess = spawn, host = "local" } = {}) {
    if (!["local", "remote"].includes(host))
      throw new Error("Unsupported host");
    this.host = host;
    this.normalize =
      host === "remote"
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
        : ["remote", "codex", "app-server", "--stdio"],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
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
    this.child.on("error", () => this.fail());
    this.child.on("exit", () => this.fail());
    await this.rpc("initialize", {
      clientInfo: { name: "agentspaces_desktop", version: "0.1.0-alpha.1" },
      capabilities: { experimentalApi: false },
    });
    this.child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  }
  rpc(method, params) {
    if (!["initialize", "thread/list", "thread/read"].includes(method))
      throw new Error("Read-only adapter refuses this method");
    return new Promise((res, rej) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.requests.delete(id);
        rej(new Error("Native read timed out; no automatic retry"));
      }, 8000);
      this.requests.set(id, { resolve: res, reject: rej, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  async discover(project, archived = false, cursor = null) {
    if (!project.metadataGrant)
      throw new Error("Project metadata grant required");
    const result = await this.rpc("thread/list", {
      cwd: project.path,
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
            t.cwd && this.normalize(t.cwd) === this.normalize(project.path),
        )
        .map((t) => ({
          id: t.id,
          nativeThreadId: t.id,
          provider: "codex",
          host: this.host,
          account: project.account,
          project: project.id,
          title: t.name || "Untitled native session",
          surface: "native session (surface not inferred)",
          status: archived
            ? "archived"
            : t.status?.type === "active"
              ? "current"
              : "dormant",
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
