import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, chmodSync } from "node:fs";
import { resolve, parse } from "node:path";
const protectedRoots = new Set();
export function protectStateDirectory(directory, extraNames = []) {
  const root = resolve(directory);
  if (protectedRoots.has(root)) return;
  if (root === parse(root).root)
    throw new Error("Refusing a filesystem root as application state");
  mkdirSync(root, { recursive: true });
  const allowed =
    /^(settings\.json|runtime\.json|workspace-index\.json(?:\.tmp)?|founding\.cbor(?:\.tmp)?|fabric-keys|agent-keys|effect-receipts|native-connections|work-board|stdout\.log|stderr\.log|settings\.json\.\d+\.tmp)$/;
  if (readdirSync(root).some((name) => !allowed.test(name) && !extraNames.includes(name)))
    throw new Error(
      "State directory contains unrelated files; choose an application-owned directory",
    );
  if (process.platform === "win32") {
    // Replace the DACL atomically: removing inheritance alone retains explicit
    // grants to unrelated accounts. Canonical privileged OS identities remain;
    // localized group names never determine who may read application state.
    const script = [
      "$ErrorActionPreference='Stop'",
      "$root='" + root.replaceAll("'", "''") + "'",
      "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      "if($sid -notmatch '^S-\\d+(?:-\\d+)+$'){throw 'Cannot resolve state owner'}",
      "$acl=New-Object System.Security.AccessControl.DirectorySecurity",
      "$acl.SetAccessRuleProtection($true,$false)",
      "$acl.SetOwner([System.Security.Principal.SecurityIdentifier]::new($sid))",
      "foreach($value in @($sid,'S-1-5-18','S-1-5-32-544')){$principal=[System.Security.Principal.SecurityIdentifier]::new($value);$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule)}",
      "[System.IO.Directory]::SetAccessControl($root,$acl)",
    ].join(";");
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, stdio: "pipe", timeout: 15000 },
    );
  } else chmodSync(root, 0o700);
  protectedRoots.add(root);
}
