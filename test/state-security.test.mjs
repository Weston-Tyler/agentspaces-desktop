import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, statSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { protectStateDirectory } from "../app/state-security.mjs";
const windows = script => execFileSync("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from("$ErrorActionPreference='Stop';" + script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 15000 });
const quote = value => "'" + value.replaceAll("'", "''") + "'";
function access(path, directory = false) {
  return JSON.parse(windows("$acl=[System.IO." + (directory ? "Directory" : "File") + "]::GetAccessControl(" + quote(path) + ");$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]);[pscustomobject]@{callerSid=$sid;ownerSid=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;protected=$acl.AreAccessRulesProtected;allows=@($rules|Where-Object {$_.AccessControlType -eq 'Allow'}|ForEach-Object {[pscustomobject]@{sid=$_.IdentityReference.Value;rights=[long]$_.FileSystemRights}})}|ConvertTo-Json -Depth 4 -Compress"));
}
function assertPrivate(acl) {
  const allowed = new Set([acl.callerSid, "S-1-5-18", "S-1-5-32-544"]);
  assert.ok(acl.allows.length > 0, "state must retain an explicit owner grant");
  assert.ok(acl.allows.every(rule => allowed.has(rule.sid)), "ordinary or unrelated principals must have no access grant");
  assert.ok(acl.allows.some(rule => rule.sid === acl.callerSid && (rule.rights & 2032127) === 2032127), "current owner must retain FullControl");
}
function temporary(t, prefix) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test("owned state restricts inherited read access using the platform security mechanism", t => {
  const root = temporary(t, "as-secure-");
  protectStateDirectory(root);
  const file = join(root, "runtime.json");
  writeFileSync(file, "{}");
  if (process.platform === "win32") {
    const directory = access(root, true);
    assert.equal(directory.protected, true);
    assert.equal(directory.ownerSid, directory.callerSid);
    assertPrivate(directory);
    assertPrivate(access(file));
  } else assert.equal(statSync(root).mode & 0o777, 0o700);
});
test("Windows protection removes explicit ordinary-account grants before new state inherits them", { skip: process.platform !== "win32" }, t => {
  const root = temporary(t, "as-explicit-acl-");
  windows("$root=" + quote(root) + ";$acl=[System.IO.Directory]::GetAccessControl($root);$everyone=[System.Security.Principal.SecurityIdentifier]::new('S-1-1-0');$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($everyone,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule);[System.IO.Directory]::SetAccessControl($root,$acl)");
  assert.ok(access(root, true).allows.some(rule => rule.sid === "S-1-1-0"));
  protectStateDirectory(root);
  assertPrivate(access(root, true));
  const file = join(root, "settings.json"); writeFileSync(file, "{}");
  assertPrivate(access(file));
});
test("state protection refuses unrelated directories", t => {
  const root = temporary(t, "as-other-");
  writeFileSync(join(root, "unrelated.txt"), "keep");
  assert.throws(() => protectStateDirectory(root), /unrelated/);
});
