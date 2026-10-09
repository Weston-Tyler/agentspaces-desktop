import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const target = process.argv[2];
if (process.argv.length !== 3 || !["dir", "win", "linux"].includes(target) || target === "win" && process.platform !== "win32" || target === "linux" && process.platform !== "linux")
  throw new Error("Use dir, win or linux on the matching Windows/Linux build host.");
const root = fileURLToPath(new URL("../", import.meta.url));
const cli = process.env.AGENTSPACES_PACKAGER_CLI ?? createRequire(import.meta.url).resolve("electron-builder/cli.js");
if (!isAbsolute(cli)) throw new Error("The isolated packager CLI override must be an absolute path.");
const builder = JSON.parse(readFileSync(join(dirname(cli), "package.json"), "utf8"));
const pin = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies["electron-builder"];
if (builder.name !== "electron-builder" || builder.version !== pin) throw new Error("Packager CLI differs from the repository's exact electron-builder pin.");
execFileSync(process.execPath, [fileURLToPath(new URL("./prepare-package.mjs", import.meta.url))], { cwd: root, stdio: "inherit" });
const args = target === "dir" ? ["--dir"] : target === "win" ? ["--win", "nsis", "--x64"] : ["--linux", "tar.gz", "--x64"];
execFileSync(process.execPath, [cli, ...args, "--publish", "never"], { cwd: root, stdio: "inherit",
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false", ELECTRON_BUILDER_COMPRESSION_LEVEL: process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL ?? "3" } });
