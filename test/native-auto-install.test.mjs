import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installOnCurrentHost } from "../app/native-auto-install.mjs";
import { dependencyVersions } from "../app/dependency-versions.mjs";
const TOKEN = "a".repeat(64);
function fixture(provider = "claude") {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "as-auto-install-")), nativePath = join(home, provider === "claude" ? ".claude.json" : ".codex/config.toml"), calls = [];
  const binary = join(home, "native", provider === "claude" ? "versions/2.1.283" : "codex.exe");
  mkdirSync(join(home, ".claude"), { recursive: true }); mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(nativePath, provider === "claude" ? JSON.stringify({ theme: "dark", mcpServers: { another: { command: "other-native-tool" } } }) : "model = \"fixture-model\"\n");
  const settings = { env: { EXAMPLE_ONLY: "fictional" }, hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "existing-hook", timeout: 3 }] }], Stop: [{ hooks: [{ type: "command", command: "preserve-stop" }] }] } };
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify(settings));
  let codexRegistration = null;
  const runCLI = (path, args) => {
    calls.push({ path, args });
    if (args[0] === "mcp" && args[1] === "get") return codexRegistration ? JSON.stringify(codexRegistration) : null;
    if (args[0] === "mcp" && args[1] === "add") {
      const split = args.indexOf("--"), registration = { command: args[split + 1], args: args.slice(split + 2) };
      if (provider === "claude") { const content = JSON.parse(readFileSync(nativePath, "utf8")); content.mcpServers["agentspaces-desktop"] = registration; writeFileSync(nativePath, JSON.stringify(content)); }
      else codexRegistration = registration;
    }
    return "";
  };
  return { home, nativePath, calls, settings, options: { home, versions: dependencyVersions(), config: { schemaVersion: 1, provider, host: "local", token: TOKEN, address: "http://127.0.0.1:43127", authority: "127.0.0.1:43127" }, sources: { bootstrap: "// Synthetic bootstrap source", hook: "// Synthetic lifecycle source", channel: "// Synthetic channel source" }, resolveExecutable: () => binary, runCLI, installDependencies: false }, binary };
}
test("Automatic Claude setup preserves settings and other MCP names, backs up privately and is idempotent", async () => {
  const f = fixture(), first = await installOnCurrentHost(f.options), second = await installOnCurrentHost(f.options);
  assert.equal(first.status, "native-config-installed"); assert.equal(second.activeSessionReloaded, false);
  const settings = JSON.parse(readFileSync(join(f.home, ".claude/settings.json"), "utf8"));
  assert.deepEqual(settings.env, f.settings.env); assert.deepEqual(settings.hooks.Stop, f.settings.hooks.Stop);
  assert.deepEqual(settings.hooks.SessionStart[0], f.settings.hooks.SessionStart[0]);
  for (const event of ["SessionStart", "UserPromptSubmit", "SessionEnd"]) assert.equal(settings.hooks[event].filter(group => group.hooks.some(h => h.command.includes("native-session-hook.mjs"))).length, 1);
  const global = JSON.parse(readFileSync(f.nativePath, "utf8")); assert.equal(global.theme, "dark"); assert.equal(global.mcpServers.another.command, "other-native-tool");
  assert.equal(f.calls.filter(c => c.args[1] === "add").length, 1);
  assert(!JSON.stringify(f.calls).includes(TOKEN)); assert(!JSON.stringify(first).includes(TOKEN));
  const config = JSON.parse(readFileSync(first.configPath, "utf8")); assert.equal(config.nativeExecutable, f.binary);
  const backups = [...readdirSync(f.home).filter(n => n.endsWith(".backup")).map(n => join(f.home, n)), ...readdirSync(join(f.home, ".claude")).filter(n => n.endsWith(".backup")).map(n => join(f.home, ".claude", n))];
  assert.equal(backups.length, 2);
  if (process.platform !== "win32") for (const path of [first.configPath, ...backups]) assert.equal(statSync(path).mode & 0o777, 0o600);
});
test("Unowned global MCP name is refused without overwriting global settings", async () => {
  const f = fixture();
  const original = JSON.stringify({ mcpServers: { "agentspaces-desktop": { command: "unrelated-command", args: ["unrelated"] } }, preserve: "fictional" });
  writeFileSync(f.nativePath, original);
  await assert.rejects(installOnCurrentHost(f.options), /Existing MCP name/);
  assert.equal(readFileSync(f.nativePath, "utf8"), original);
  assert.equal(f.calls.filter(c => c.args[1] === "add").length, 0);
});
test("Automatic Codex setup uses private path arguments and preserves source config backup", async () => {
  const f = fixture("codex"), result = await installOnCurrentHost(f.options);
  await installOnCurrentHost(f.options);
  assert.equal(f.calls.filter(c => c.args[1] === "add").length, 1);
  assert(!JSON.stringify(f.calls).includes(TOKEN));
  assert.equal(f.calls.find(c => c.args[1] === "add").args.at(-1), result.configPath);
  assert(readdirSync(join(f.home, ".codex")).some(n => n.endsWith(".backup")));
});
test("Managed runtime can update its hashed bootstrap while preserving other native MCP names", async () => {
  const f = fixture(); await installOnCurrentHost(f.options);
  const upgraded = await installOnCurrentHost({ ...f.options, sources: { ...f.options.sources, bootstrap: "// Synthetic updated bootstrap source" } });
  assert.equal(upgraded.status, "native-config-installed");
  assert.equal(JSON.parse(readFileSync(f.nativePath, "utf8")).mcpServers.another.command, "other-native-tool");
  const settings = JSON.parse(readFileSync(join(f.home, ".claude/settings.json"), "utf8"));
  for (const event of ["SessionStart", "UserPromptSubmit", "SessionEnd"]) assert.equal(settings.hooks[event].filter(group => group.hooks.some(h => h.command.includes("native-session-hook.mjs"))).length, 1);
  assert.deepEqual(settings.hooks.SessionStart[0], f.settings.hooks.SessionStart[0]);
});
test("Malformed Claude hook settings refuse before native global registration changes", async () => {
  const f = fixture(); writeFileSync(join(f.home, ".claude/settings.json"), "{invalid-json");
  const original = readFileSync(f.nativePath, "utf8");
  await assert.rejects(installOnCurrentHost(f.options), /Existing native settings/);
  assert.equal(f.calls.filter(c => c.args[1] === "add").length, 0);
  assert.equal(readFileSync(f.nativePath, "utf8"), original);
});
test("Failed managed native registration update restores existing global configuration bytes", async () => {
  const f = fixture(); await installOnCurrentHost(f.options);
  const original = readFileSync(f.nativePath, "utf8"), settingsBefore = readFileSync(join(f.home, ".claude/settings.json"), "utf8");
  const failingCLI = (binary, args, options) => {
    if (args[0] === "mcp" && args[1] === "remove") {
      const value = JSON.parse(readFileSync(f.nativePath, "utf8")); delete value.mcpServers["agentspaces-desktop"]; writeFileSync(f.nativePath, JSON.stringify(value)); return "";
    }
    if (args[0] === "mcp" && args[1] === "add") {
      writeFileSync(f.nativePath, JSON.stringify({ interruptedSyntheticMutation: true }));
      throw new Error("Synthetic native add failure");
    }
    return f.options.runCLI(binary, args, options);
  };
  await assert.rejects(installOnCurrentHost({ ...f.options, runCLI: failingCLI, sources: { ...f.options.sources, bootstrap: "// Synthetic upgrade refused after native removal" } }), /Synthetic native add failure/);
  assert.equal(readFileSync(f.nativePath, "utf8"), original);
  assert.equal(readFileSync(join(f.home, ".claude/settings.json"), "utf8"), settingsBefore);
});
test("Root dependency payload determines all managed runtime versions and rejects ranges before native changes", async () => {
  const f = fixture(), versions = { mcp: "1.33.0", zod: "4.6.6", claude: "0.4.0-beta.1", ws: "8.22.1" };
  await installOnCurrentHost({ ...f.options, versions });
  const manifest = JSON.parse(readFileSync(join(f.home, ".agentspaces-desktop-native/automatic/package.json"), "utf8"));
  assert.deepEqual(manifest.dependencies, { "@modelcontextprotocol/sdk": versions.mcp, zod: versions.zod, "@anthropic-ai/claude-agent-sdk": versions.claude, ws: versions.ws });
  const original = readFileSync(f.nativePath, "utf8"), count = f.calls.length;
  await assert.rejects(installOnCurrentHost({ ...f.options, versions: { ...versions, claude: "^0.4.0" } }), /Exact managed/);
  await assert.rejects(installOnCurrentHost({ ...f.options, versions: undefined }), /Exact managed/);
  assert.equal(f.calls.length, count); assert.equal(readFileSync(f.nativePath, "utf8"), original);
});
test('an existing two-module managed runtime upgrades to the channel runtime without replacing unrelated configuration',async()=>{
 const {createHash}=await import('node:crypto'),{dirname}=await import('node:path'),{renameSync,unlinkSync}=await import('node:fs');
 const f=fixture();await installOnCurrentHost(f.options);
 const config=JSON.parse(readFileSync(f.nativePath,'utf8')),registration=config.mcpServers['agentspaces-desktop'],oldBootstrap=registration.args.find(arg=>arg.endsWith('native-bootstrap-mcp.mjs')),current=dirname(oldBootstrap);
 const digest=createHash('sha256').update(f.options.sources.bootstrap+f.options.sources.hook).digest('hex'),legacy=join(dirname(current),'runtime-'+digest);
 unlinkSync(join(current,'native-bootstrap-channel.mjs'));renameSync(current,legacy);
 registration.args=registration.args.map(arg=>arg.startsWith(current)?legacy+arg.slice(current.length):arg);writeFileSync(f.nativePath,JSON.stringify(config));
 const result=await installOnCurrentHost(f.options);assert.ok(result);
 const updated=JSON.parse(readFileSync(f.nativePath,'utf8'));assert.deepEqual(updated.mcpServers.another,config.mcpServers.another);
 const installed=updated.mcpServers['agentspaces-desktop'].args.find(arg=>arg.endsWith('native-bootstrap-mcp.mjs'));assert.notEqual(installed,registration.args.find(arg=>arg.endsWith('native-bootstrap-mcp.mjs')));assert.equal(readFileSync(join(dirname(installed),'native-bootstrap-channel.mjs'),'utf8'),f.options.sources.channel);
});
