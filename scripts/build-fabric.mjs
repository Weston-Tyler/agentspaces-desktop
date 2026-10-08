import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
const config = "node_modules/@agentspaces/client/tsconfig.json";
if (!existsSync(config))
  throw new Error("Pinned AgentSpaces source dependency is missing.");
execFileSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", config],
  { stdio: "inherit" },
);
