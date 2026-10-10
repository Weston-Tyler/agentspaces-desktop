import pty from "node-pty";
import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";

let terminal, started = false, ending = false, pendingBytes = 0;
const send = message => {
  if (!process.connected) return;
  const bytes = typeof message.data === "string" ? Buffer.byteLength(message.data) : 0;
  if (pendingBytes + bytes > 256 * 1024) return; // Drop display output, never native work.
  pendingBytes += bytes;
  try { process.send(message, () => { pendingBytes -= bytes; }); }
  catch { pendingBytes -= bytes; }
};
const stop = (exitCode = 0, code) => {
  if (ending) return; ending = true;
  const message = code ? { type: "error", code } : { type: "exit", exitCode };
  if (process.connected) process.send(message, () => process.exit(exitCode));
  setTimeout(() => process.exit(exitCode), 100).unref();
};
// A disconnected companion is not a native stop command. Keep the PTY alive
// and draining until its own exit; reattachment across service restarts is not supported.
process.on("disconnect", () => { if (!terminal) stop(); });
process.on("SIGTERM", () => { if (!terminal) stop(); });
process.on("message", message => {
  try {
    if (message.type === "close") { if (!terminal) stop(); return; }
    if (message.type === "start" || message.type === "smoke") {
      if (started) throw new Error("Already started"); started = true;
      const launch = message.type === "smoke" ? message.remote
        ? { file: process.platform === "win32" ? "ssh.exe" : "ssh", args: ["-tt", "remote", "sh -c 'test -t 0 && test -t 1 && echo AGENTSPACES_REMOTE_PTY_OK'"], cwd: process.cwd() }
        : process.platform === "win32"
          ? { file: "cmd.exe", args: ["/d", "/c", "echo AGENTSPACES_LOCAL_PTY_OK"], cwd: process.cwd() }
          : { file: "/bin/sh", args: ["-c", "test -t 0 && test -t 1 && echo AGENTSPACES_LOCAL_PTY_OK"], cwd: process.cwd() }
        : message.launch;
      if (!launch || typeof launch.file !== "string" || !Array.isArray(launch.args)) throw new Error("Invalid launch");
      // ConPTY requires an executable path for native tools outside System32.
      const file = process.platform === "win32" && !isAbsolute(launch.file)
        ? execFileSync("where.exe", [launch.file], { encoding: "utf8", windowsHide: true, timeout: 5000 }).trim().split(/\r?\n/)[0]
        : launch.file;
      if (process.platform === "win32" && !isAbsolute(file)) throw new Error("Native executable is unavailable");
      terminal = pty.spawn(file, launch.args, { name: "xterm-256color", cols: 100, rows: 30,
        cwd: launch.cwd, env: process.env, ...(process.platform === "win32" ? { useConpty: true } : {}) });
      terminal.onData(data => {
        // Split by characters to keep each UTF-8 IPC message within 8192 bytes.
        for (let i = 0; i < data.length;) {
          let end = Math.min(i + 2048, data.length);
          const last = data.charCodeAt(end - 1);
          if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
          send({ type: "data", data: data.slice(i, end) }); i = end;
        }
      });
      terminal.onExit(event => stop(event.exitCode ?? 0));
      send({ type: "ready" });
    } else if (message.type === "input") {
      if (typeof message.data !== "string" || Buffer.byteLength(message.data) > 8192) throw new Error("Input too large");
      terminal?.write(message.data);
    } else if (message.type === "resize") {
      if (!Number.isInteger(message.cols) || message.cols < 20 || message.cols > 300 || !Number.isInteger(message.rows) || message.rows < 5 || message.rows > 150) throw new Error("Invalid dimensions");
      terminal?.resize(message.cols, message.rows);
    }
  } catch { if (terminal) send({ type: "error", code: "native_terminal_input_failed" }); else stop(1, "native_terminal_start_failed"); }
});
