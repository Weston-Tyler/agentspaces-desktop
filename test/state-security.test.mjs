import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { protectStateDirectory } from "../app/state-security.mjs";
test("owned state restricts inherited read access using the platform security mechanism", () => {
  const root = mkdtempSync(join(tmpdir(), "as-secure-"));
  protectStateDirectory(root);
  const file = join(root, "runtime.json");
  writeFileSync(file, "{}");
  if (process.platform === "win32") {
    const script =
      "$ErrorActionPreference='Stop';$acl=[System.IO.File]::GetAccessControl('" +
      file.replace(/'/g, "''") +
      "');$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]);if($rules.Count -eq 0){throw 'Missing ACL rules'};if($rules | Where-Object {$_.IdentityReference.Value -ne $sid -and $_.AccessControlType -eq 'Allow'}) {'unexpected'} else {'owner-only'}";
    const result = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.trim(), "owner-only");
  } else assert.equal(statSync(root).mode & 0o777, 0o700);
});
test("state protection refuses unrelated directories", () => {
  const root = mkdtempSync(join(tmpdir(), "as-other-"));
  writeFileSync(join(root, "unrelated.txt"), "keep");
  assert.throws(() => protectStateDirectory(root), /unrelated/);
});
