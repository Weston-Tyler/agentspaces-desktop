import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, chmodSync } from "node:fs";
import { resolve, parse } from "node:path";
const protectedRoots = new Set();
export function protectStateDirectory(directory) {
  const root = resolve(directory);
  if (protectedRoots.has(root)) return;
  if (root === parse(root).root)
    throw new Error("Refusing a filesystem root as application state");
  mkdirSync(root, { recursive: true });
  const allowed =
    /^(settings\.json|runtime\.json|workspace-index\.json(?:\.tmp)?|founding\.cbor(?:\.tmp)?|fabric-keys|agent-keys|effect-receipts|native-connections|stdout\.log|stderr\.log|settings\.json\.\d+\.tmp)$/;
  if (readdirSync(root).some((name) => !allowed.test(name)))
    throw new Error(
      "State directory contains unrelated files; choose an application-owned directory",
    );
  if (process.platform === "win32") {
    const sid = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    if (!/^S-\d+(?:-\d+)+$/.test(sid))
      throw new Error("Cannot resolve state owner");
    execFileSync(
      "icacls.exe",
      [root, "/inheritance:r", "/grant:r", "*" + sid + ":(OI)(CI)F"],
      { windowsHide: true, stdio: "pipe" },
    );
  } else chmodSync(root, 0o700);
  protectedRoots.add(root);
}
