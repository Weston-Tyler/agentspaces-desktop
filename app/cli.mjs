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
  } else if (["status", "stop", "owner-password"].includes(command)) {
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
    if(command==='owner-password') {
      const {hiddenPassword}=await import('./owner-password-prompt.mjs');
      const post=async(path,data)=>{const response=await fetch(r.address+path,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(10000)});const value=await response.json();if(!response.ok)throw Error(value.error??'Owner setup failed');return value;};
      const status=await post('/api/approvals/status',{});
      const currentPassword=status.configured?await hiddenPassword('Current owner password: '):undefined;
      const password=await hiddenPassword('New owner password (16+ characters): ');
      if(password!==await hiddenPassword('Confirm new owner password: '))throw Error('Passwords do not match');
      await post('/api/approvals/configure',{password,currentPassword});
      console.log('Owner approval password configured. Use it only in the Decisions page; never send it to agents.');
    } else console.log(
      command === "status"
        ? JSON.stringify(health)
        : await fetch(r.address + "/api/stop", {
            method: "POST",
            headers,
            signal: AbortSignal.timeout(2000),
          }).then((v) => v.text()),
    );
  } else throw new Error("Commands: serve, status, stop, diagnostics, owner-password");
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
