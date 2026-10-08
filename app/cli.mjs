import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";
import { startServer } from "./server.mjs";
import { detectTools } from "./native.mjs";
import { fileURLToPath } from "node:url";
const command = process.argv[2] ?? "serve",
  root = resolve(
    process.env.AGENTSPACES_STATE ??
      fileURLToPath(new URL("../.local/", import.meta.url)),
  );
try {
  if (command === "serve") {
    const app = await startServer({
      root,
      port: Number(process.env.AGENTSPACES_PORT ?? 43127),
    });
    console.log(
      `AgentSpaces Desktop local alpha: ${app.address}\nNative thread discovery restores the saved connection or starts automatically. Provider sign-in and approvals stay with native tools.`,
    );
    for (const sig of ["SIGINT", "SIGTERM"])
      process.once(sig, () => app.close().then(() => process.exit(0)));
  } else if (command === "diagnostics") {
    console.log(
      JSON.stringify(
        {
          node: process.version,
          platform: process.platform,
          tools: await detectTools(),
          nativeExecution: "not qualified",
          accounts: "not inspected",
        },
        null,
        2,
      ),
    );
  } else if (["status", "stop"].includes(command)) {
    const r = JSON.parse(readFileSync(join(root, "runtime.json"), "utf8"));
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(r.address))
      throw new Error("Invalid local runtime address");
    const headers = { Authorization: `Bearer ${r.admin}` };
    const health = await fetch(r.address + "/api/health", {
      headers,
      signal: AbortSignal.timeout(2000),
    }).then((v) => v.json());
    if (health.instance !== r.instance || health.pid !== r.pid)
      throw new Error("Runtime identity mismatch");
    console.log(
      command === "status"
        ? JSON.stringify(health)
        : await fetch(r.address + "/api/stop", {
            method: "POST",
            headers,
            signal: AbortSignal.timeout(2000),
          }).then((v) => v.text()),
    );
  } else throw new Error("Commands: serve, status, stop, diagnostics");
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
