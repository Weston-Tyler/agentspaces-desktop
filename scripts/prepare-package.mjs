import { copyFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
if (!["win32", "linux"].includes(process.platform) || process.arch !== "x64" || process.versions.node.split(".")[0] !== "24" || process.versions.electron)
  throw new Error("Build on the target Windows/Linux x64 host using Node.js 24. Cross-platform native addon packaging is not supported.");
execFileSync(process.execPath, ["--input-type=module", "-e", "await import('@agentspaces/client'); await import('node-pty'); await import('@modelcontextprotocol/sdk/server/mcp.js');"], { cwd: root, stdio: "inherit", timeout: 15000 });
const destination = join(root, "build", "runtime");
mkdirSync(destination, { recursive: true });
const binaryName = process.platform === "win32" ? "node.exe" : "node";
copyFileSync(process.execPath, join(destination, binaryName));
if (process.platform !== "win32") chmodSync(join(destination, binaryName), 0o755);
const licenseURL = "https://raw.githubusercontent.com/nodejs/node/v" + process.versions.node + "/LICENSE";
let license, licenseSource = licenseURL;
try {
  const response = await fetch(licenseURL, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error("Node.js license unavailable");
  license = await response.text();
} catch {
  const candidates = [join(dirname(process.execPath), "LICENSE"), join(dirname(process.execPath), "LICENSE.txt"), "/usr/share/doc/nodejs/LICENSE"];
  const local = candidates.find(path => existsSync(path));
  if (!local) throw new Error("Cannot bundle the Node.js runtime without its license. Provide the official Node.js 24 distribution with LICENSE or retry the official license download.");
  license = readFileSync(local, "utf8");
  licenseSource = "build-host Node.js distribution license";
}
if (!license.includes("Node.js") || license.length < 1000 || license.length > 1024 * 1024) throw new Error("Node.js license content could not be verified");
writeFileSync(join(destination, "NODE-LICENSE.txt"), license);
let gitHead = "unavailable", gitDirty = true;
try {
  gitHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  gitDirty = !!execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {}
const sourceFiles = {};
function observe(relative) {
  const absolute = join(root, relative), stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error("Packaged application source must not contain symbolic links");
  if (stat.isDirectory()) for (const name of readdirSync(absolute).sort()) observe(relative + "/" + name);
  else if (stat.isFile()) sourceFiles[relative] = createHash("sha256").update(readFileSync(absolute)).digest("hex");
}
for (const relative of ["app", "ui", "assets", "package.json", "package-lock.json", "README.md", "LICENSE", "NOTICE", "docs/installer.md", "scripts/install-linux.mjs"]) observe(relative);
const manifest = { schema: 1, version: JSON.parse(readFileSync(join(root, "package.json"))).version,
  platform: process.platform, architecture: process.arch, nodeVersion: process.versions.node, nodeModuleABI: process.versions.modules,
  nodeSHA256: createHash("sha256").update(readFileSync(process.execPath)).digest("hex"), nodeLicenseSource: licenseSource,
  gitHead, gitDirty, sourceSHA256: createHash("sha256").update(JSON.stringify(sourceFiles)).digest("hex"), sourceFiles,
  providerBinariesIncluded: false, credentialsIncluded: false };
writeFileSync(join(destination, "build-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log("Prepared owned runtime: Node " + manifest.nodeVersion + ", " + manifest.platform + "/" + manifest.architecture + "; native worker addon imports verified.");
