import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const worker = fileURLToPath(new URL("../app/native-terminal-worker.mjs", import.meta.url));
async function smoke(remote) {
  const child = spawn(process.env.AGENTSPACES_NODE_BINARY || "node", [worker], { windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const marker = remote ? "AGENTSPACES_REMOTE_PTY_OK" : "AGENTSPACES_LOCAL_PTY_OK";
  let observed = false, exitCode, combined = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Synthetic PTY smoke timeout")); }, 10000);
    child.on("error", reject);
    child.on("message", message => {
      if (message.type === "data") { combined = (combined + message.data).slice(-4096); observed ||= combined.includes(marker); }
      if (message.type === "exit") exitCode = message.exitCode;
      if (message.type === "error") { clearTimeout(timer); child.kill(); reject(new Error("Synthetic PTY startup failed")); }
    });
    child.on("exit", code => { clearTimeout(timer); assert.equal(code, 0); assert.equal(exitCode, 0); assert(observed); resolve(); });
    child.send({ type: "smoke", remote });
  });
  return { host: remote ? "remote" : "local", markerObserved: true, workerExited: true };
}
const proofs = [await smoke(false)];
if (process.argv.includes("--ssh")) proofs.push(await smoke(true));
console.log(JSON.stringify({ proof: "product-owned node-pty synthetic local/SSH terminal smoke", proofs,
  nativeCliLaunches: 0, nativeModelCalls: 0 }, null, 2));
