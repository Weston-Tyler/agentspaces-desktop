const { existsSync, readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
module.exports = async context => {
  const resources = join(context.appOutDir, "resources"), app = join(resources, "app");
  const runtime = join(resources, "runtime"), binary = join(runtime, process.platform === "win32" ? "node.exe" : "node");
  const manifest = JSON.parse(readFileSync(join(runtime, "build-manifest.json"), "utf8"));
  if (manifest.platform !== context.electronPlatformName || manifest.architecture !== process.arch)
    throw new Error("Bundled worker runtime does not match the package target");
  if (!manifest.sourceFiles?.["app/desktop.mjs"] || createHash("sha256").update(JSON.stringify(manifest.sourceFiles)).digest("hex") !== manifest.sourceSHA256) throw new Error("Application source manifest is absent or inconsistent");
  if (createHash("sha256").update(readFileSync(binary)).digest("hex") !== manifest.nodeSHA256) throw new Error("Bundled Node runtime hash differs from the preparation manifest");
  for (const [relative, expected] of Object.entries(manifest.sourceFiles ?? {})) {
    // electron-builder deliberately rewrites package metadata and does not
    // ship the lockfile; application code/assets must match the observed bytes.
    if (["package.json", "package-lock.json"].includes(relative)) continue;
    if (createHash("sha256").update(readFileSync(join(app, relative))).digest("hex") !== expected) throw new Error("Packaged source changed after the build manifest was prepared: " + relative);
  }
  for (const path of [join(app, "app", "desktop.mjs"), join(app, "ui", "index.html"), join(app, "assets", "agentspaces.png"), join(app, "LICENSE"), join(app, "NOTICE"), join(runtime, "NODE-LICENSE.txt")])
    if (!existsSync(path)) throw new Error("Required packaged application file is absent");
  for (const path of [".local", ".state", "sessions", "transcripts", "exports", "logs", ".env", "auth.json", "credentials.json"])
    if (existsSync(join(app, path))) throw new Error("Private state is present in packaged app contents");
  execFileSync(binary, ["--input-type=module", "-e", "await import('@agentspaces/client'); await import('node-pty'); await import('@modelcontextprotocol/sdk/server/mcp.js'); await import('@anthropic-ai/claude-agent-sdk');"], { cwd: app, stdio: "inherit", timeout: 20000 });
  const terminalProof = [
    "import pty from 'node-pty';",
    "import {join} from 'node:path';",
    "const marker='AGENTSPACES_PACKAGED_PTY_OK';",
    "const shell=process.platform==='win32'?join(process.env.SystemRoot||process.env.WINDIR,'System32','cmd.exe'):'/bin/sh';",
    "const child=pty.spawn(shell,process.platform==='win32'?['/d','/c','echo '+marker]:['-c','printf '+marker],{name:'xterm-256color',cols:80,rows:24,cwd:process.cwd(),env:process.env,...(process.platform==='win32'?{useConpty:true}:{})});",
    "await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>{child.kill();reject(Error('Packaged PTY proof timed out'));},8000);child.onData(data=>{output=(output+data).slice(-8192);});child.onExit(event=>{clearTimeout(timer);event.exitCode===0&&output.includes(marker)?resolve():reject(Error('Packaged PTY proof failed'));});});",
    "console.log('Packaged native PTY synthetic echo verified; no provider/model invoked.');",
    "process.exit(0);",
  ].join("\n");
  execFileSync(binary, ["--input-type=module", "-e", terminalProof], { cwd: app, stdio: "inherit", timeout: 12000 });
  const client = join(app, "node_modules", "@agentspaces", "client");
  for (const name of ["LICENSE", "NOTICE"]) if (!existsSync(join(client, name))) throw new Error("Upstream AgentSpaces " + name + " notice missing");
  if (!existsSync(join(resources, "notices", "CLAUDE-AGENT-SDK-README.md"))) throw new Error("Claude SDK redistribution terms missing");
  if (!existsSync(join(resources, "notices", "CLAUDE-AGENT-SDK-LICENSE.md"))) throw new Error("Claude SDK license notice missing");
  if (readdirSync(join(app, "node_modules", "@anthropic-ai")).some(name => name.startsWith("claude-agent-sdk-"))) throw new Error("Optional Claude native provider executables must not be bundled");
  console.log("Packaged Node runtime, addon ABI, dependencies, required notices and private-state exclusion verified.");
};
