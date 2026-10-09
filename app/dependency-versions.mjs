import { readFileSync } from "node:fs";

export function exactDependencyVersion(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)) return false;
  const prerelease = value.slice(value.indexOf("-") + 1);
  return !value.includes("-") || prerelease.split(".").every(part => !/^\d+$/.test(part) || part === "0" || !part.startsWith("0"));
}
export function dependencyVersions({ manifest, manifestPath = new URL("../package.json", import.meta.url) } = {}) {
  const packageData = manifest ?? JSON.parse(readFileSync(manifestPath, "utf8"));
  const names = { mcp: "@modelcontextprotocol/sdk", zod: "zod", claude: "@anthropic-ai/claude-agent-sdk" };
  const versions = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, packageData.dependencies?.[name]]));
  if (Object.values(versions).some(value => !exactDependencyVersion(value))) throw new Error("Managed runtime dependencies require exact semantic versions in the root manifest");
  return versions;
}
