import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { dependencyVersions, exactDependencyVersion } from "../app/dependency-versions.mjs";
import { ClaudeReadAdapter, CLAUDE_SDK_PIN } from "../app/claude-adapter.mjs";
import { NativeAutoInstaller, remoteInstallScript } from "../app/native-auto-install.mjs";

test("Managed SDK versions derive directly from the root package manifest", () => {
  const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")), actual = dependencyVersions();
  assert.deepEqual(actual, { mcp: root.dependencies["@modelcontextprotocol/sdk"], zod: root.dependencies.zod, claude: root.dependencies["@anthropic-ai/claude-agent-sdk"] });
  assert.equal(CLAUDE_SDK_PIN, actual.claude);
});
test("Exact semantic versions accept prereleases and refuse ranges, URLs and malformed numeric identifiers", () => {
  for (const version of ["1.2.3", "0.4.0-beta.1", "0.0.0-0", "1.2.3-alpha-beta"]) assert.equal(exactDependencyVersion(version), true);
  for (const version of ["^1.2.3", "~1.2.3", "latest", "git+https://example.invalid", "1.2", "01.2.3", "1.2.3-beta.01", "1.2.3-", "1.2.3+build", null]) assert.equal(exactDependencyVersion(version), false);
  assert.throws(() => dependencyVersions({ manifest: { dependencies: { "@modelcontextprotocol/sdk": "^1.2.3", zod: "4.6.5", "@anthropic-ai/claude-agent-sdk": "0.3.293" } } }), /exact semantic/);
});
test("Fixture manifest SDK updates change the serialized remote reader pin without inference or source edits", async () => {
  const manifest = { dependencies: { "@modelcontextprotocol/sdk": "1.33.0", zod: "4.6.6", "@anthropic-ai/claude-agent-sdk": "0.4.0-beta.1" } }, versions = dependencyVersions({ manifest });
  let source = "";
  const adapter = new ClaudeReadAdapter({ host: "remote", sdkPin: versions.claude, spawnProcess: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
    child.stdin.on("data", chunk => { source += chunk.toString(); });
    child.stdin.on("finish", () => setImmediate(() => { child.stdout.end(JSON.stringify({ sessions: [], nextCursor: null })); child.emit("close", 0); }));
    return child;
  } });
  await adapter.discover({ id: "fixture", host: "remote", path: "/fixture", account: "fixture", metadataGrant: true }); adapter.close();
  assert.ok(source.includes(".version!==" + JSON.stringify(versions.claude))); assert.ok(!source.includes("sdk.query("));
  assert.throws(() => new ClaudeReadAdapter({ sdkPin: "bad'pin" }), /Exact read SDK/);
});
test("Remote installer source retains only builtin static imports and carries injected versions", () => {
  const source = remoteInstallScript({ config: { host: "remote" }, versions: dependencyVersions() });
  const staticImports = [...source.matchAll(/^import\s.*?from\s+['"]([^'"]+)['"]/gm)].map(match => match[1]);
  assert.ok(staticImports.every(name => name.startsWith("node:")));
  assert.ok(source.includes("({ config: device, sources, versions })"));
  assert.ok(!source.includes("'@anthropic-ai/claude-agent-sdk': '0.3.293'"));
});
test("Production installer run supplies root versions to both local and remote payloads", async () => {
  const payloads = [], retained = [], tunnel = { remotePort: 45678 }, engine = { store: { data: { nativeRegistrationDevices: {} }, save() {} } };
  const options = { address: "http://127.0.0.1:43127", sourceBindings: { issueDevice: ({ host, provider }) => ({ host, provider, token: "a".repeat(64) }), device: () => ({}) }, participantConnections: { tunnel: async () => tunnel, retain: value => retained.push(value) },
    installLocal: async payload => { payloads.push({ kind: "local", payload }); return { status: "fixture-installed" }; },
    installRemote: async payload => { payloads.push({ kind: "remote", payload }); return { status: "fixture-installed" }; } };
  const installer = new NativeAutoInstaller(engine, options);
  await installer.run({ host: "local", provider: "claude" }); await installer.run({ host: "remote", provider: "claude" });
  assert.deepEqual(payloads.map(item => item.kind), ["local", "remote"]); assert.equal(retained[0], tunnel); assert.equal(retained.length, 1);
  for (const item of payloads) assert.deepEqual(item.payload.versions, dependencyVersions());
  assert.equal(payloads[1].payload.config.address, "http://127.0.0.1:45678"); assert.equal(payloads[1].payload.config.authority, "127.0.0.1:43127");
});
