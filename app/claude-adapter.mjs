import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readSdk } from "./claude-reader.mjs";
export const CLAUDE_SDK_PIN = "0.3.293";
export class ClaudeReadAdapter {
  constructor({
    host = "local",
    sdkLoader = () => import("@anthropic-ai/claude-agent-sdk"),
    spawnProcess = spawn,
  } = {}) {
    if (!["local", "remote"].includes(host))
      throw new Error("Unsupported host");
    this.host = host;
    this.sdkLoader = sdkLoader;
    this.spawnProcess = spawn;
  }
  async open() {}
  async call(request) {
    if (this.host === "local") return readSdk(request, await this.sdkLoader());
    // Product-owned, pinned read-only SDK. SSH remains the transport/authentication owner.
    const module =
      "/tmp/agentspaces-desktop-sdk-read/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
    const helper = readFileSync(
      new URL("./claude-reader.mjs", import.meta.url),
      "utf8",
    ).replace("export async function readSdk", "async function readSdk");
    const script =
      helper +
      "\nconst sdk=await import(" +
      JSON.stringify(module) +
      ");\nconst request=" +
      JSON.stringify(request) +
      ";\ntry{console.log(JSON.stringify(await readSdk(request,sdk)));}catch(e){console.log(JSON.stringify({error:e.message}));process.exitCode=1;}";
    return new Promise((yes, no) => {
      const child = this.spawnProcess(
        "ssh",
        ["remote", "node", "--input-type=module", "-"],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      this.child = child;
      let output = "";
      const timer = setTimeout(() => {
        child.kill();
        no(new Error("Remote SDK read timed out; no automatic retry"));
      }, 12000);
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.length > 1000000) {
          child.kill();
          clearTimeout(timer);
          no(new Error("Remote response exceeds bound"));
        }
      });
      child.stderr.on("data", () => {});
      child.on("error", () => {
        clearTimeout(timer);
        no(new Error("SSH read helper unavailable"));
      });
      child.on("close", () => {
        clearTimeout(timer);
        try {
          const result = JSON.parse(output);
          if (result.error) throw new Error(result.error);
          yes(result);
        } catch (e) {
          no(new Error(e.message || "Remote read failed"));
        }
      });
      child.stdin.end(script);
    });
  }
  async discover(project, archived = false, cursor = null) {
    return this.call({ action: "list", project, archived, cursor });
  }
  async read(session, project) {
    return this.call({ action: "read", session, project });
  }
  close() {
    this.child?.kill();
  }
}
