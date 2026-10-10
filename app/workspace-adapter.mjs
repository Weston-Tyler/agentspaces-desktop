import { REMOTE_HOST, SSH_ALIAS } from "./remote-host.mjs";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  scanWorkspace,
  compareWorktrees,
  inspectWorkspaceFile,
} from "./workspace-reader.mjs";
export class WorkspaceAdapter {
  constructor(host = "local") {
    if (!["local", REMOTE_HOST].includes(host))
      throw new Error("Unsupported workspace host");
    this.host = host;
    this.abort = new AbortController();
  }
  async call(request) {
    if (this.host === "local")
      return request.action === "compare"
        ? compareWorktrees(request)
        : request.action === "inspect"
          ? inspectWorkspaceFile(request)
          : scanWorkspace({ ...request, signal: this.abort.signal });
    const source = readFileSync(
      new URL("./workspace-reader.mjs", import.meta.url),
      "utf8",
    ).replace(/^export /gm, "");
    const script =
      source +
      "\nconst request=" +
      JSON.stringify(request) +
      ';\ntry{console.log(JSON.stringify(await (request.action==="compare"?compareWorktrees(request):request.action==="inspect"?inspectWorkspaceFile(request):scanWorkspace(request))));}catch(e){console.log(JSON.stringify({error:e.message}));process.exitCode=1;}';
    return new Promise((yes, no) => {
      const child = spawn(
        "ssh",
        [SSH_ALIAS, "node", "--input-type=module", "-"],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      this.child = child;
      let output = "";
      const timeout = setTimeout(() => {
        child.kill();
        no(new Error("Workspace read timed out; prior index preserved"));
      }, 65000);
      child.stdout.on("data", (data) => {
        output += data;
        if (output.length > 24 * 1024 * 1024) {
          child.kill();
          clearTimeout(timeout);
          no(new Error("Workspace response exceeds budget"));
        }
      });
      child.stderr.on("data", () => {});
      child.on("error", () => {
        clearTimeout(timeout);
        no(new Error("SSH workspace reader unavailable"));
      });
      child.on("close", () => {
        clearTimeout(timeout);
        try {
          const result = JSON.parse(output);
          if (result.error) throw new Error(result.error);
          yes(result);
        } catch (e) {
          no(new Error(e.message || "Remote workspace read failed"));
        }
      });
      child.stdin.end(script);
    });
  }
  scan(scope, cwdHints = [], continuation = {}) {
    return this.call({
      action: "scan",
      scope: { ...scope, host: this.host },
      cwdHints,
      ...continuation,
    });
  }
  compare(left, right) {
    if (left.host !== this.host || right.host !== this.host)
      throw new Error(
        "Cross-host ancestry is not qualified; compare observed hashes instead",
      );
    return this.call({ action: "compare", left, right });
  }
  inspect(node) {
    if (node.host !== this.host) throw new Error("Host mismatch");
    return this.call({ action: "inspect", node });
  }
  close() {
    this.abort.abort();
    this.child?.kill();
  }
}
