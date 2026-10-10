import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  symlinkSync,
  lstatSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  installRouter,
  mergePointer,
  routerText,
  installHostRouter,
} from "../app/router-install.mjs";
function setup() {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "as-router-")),
    codexHome = join(home, ".codex"),
    claudeHome = join(home, ".claude");
  mkdirSync(codexHome);
  mkdirSync(claudeHome);
  return { home, codexHome, claudeHome };
}
test("preview changes no bytes; installation preserves existing instructions and backs them up", () => {
  const options = setup(),
    c = join(options.codexHome, "AGENTS.md"),
    a = join(options.claudeHome, "CLAUDE.md");
  const original = Buffer.from("# Existing router\r\nKeep this authority.\r\n");
  writeFileSync(c, original);
  writeFileSync(a, "@/custom/CLAUDE.md\n");
  const preview = installRouter(options);
  assert.equal(preview.dryRun, true);
  assert.deepEqual(readFileSync(c), original);
  assert.equal(existsSync(join(options.home, ".agentspaces-desktop")), false);
  const installed = installRouter({ ...options, dryRun: false });
  assert.equal(installed.files.length, 3);
  assert(readFileSync(c).subarray(0, original.length).equals(original));
  assert.match(readFileSync(a, "utf8"), /^@\/custom\/CLAUDE.md/);
  assert.equal(installed.mcpConfigured, false);
  assert.equal(installed.nativeSessionsRestarted, false);
  const backupDir = join(options.home, ".agentspaces-desktop", "backups");
  assert(
    readdirSync(backupDir).some((f) =>
      readFileSync(join(backupDir, f)).equals(original),
    ),
  );
  assert(
    installRouter({ ...options, dryRun: false }).files.every((f) => !f.changed),
  );
});
test("nonempty Codex global override receives the pointer that would otherwise be ignored", () => {
  const options = setup(),
    override = join(options.codexHome, "AGENTS.override.md"),
    fallback = join(options.codexHome, "AGENTS.md");
  writeFileSync(override, "# Override\n");
  writeFileSync(fallback, "# Fallback\n");
  installRouter({ ...options, dryRun: false });
  assert.match(readFileSync(override, "utf8"), /AGENTSPACES DESKTOP/);
  assert.equal(readFileSync(fallback, "utf8"), "# Fallback\n");
});
test("malformed/duplicate managed blocks refuse writes", () => {
  for (const text of [
    "<!-- BEGIN AGENTSPACES DESKTOP ROUTER v1 -->",
    "<!-- END AGENTSPACES DESKTOP ROUTER v1 -->",
  ])
    assert.throws(
      () => mergePointer(Buffer.from(text), "/router"),
      /Malformed/,
    );
  const one = mergePointer(Buffer.from("prior\n"), "/router");
  assert.throws(
    () => mergePointer(Buffer.concat([one, one]), "/router"),
    /duplicate/,
  );
});
test("edited/unmanaged router and unrelated state are preserved instead of overwritten", () => {
  const options = setup();
  installRouter({ ...options, dryRun: false });
  const router = join(options.home, ".agentspaces-desktop", "ROUTER.md");
  writeFileSync(router, "Owner edits\n");
  assert.throws(
    () => installRouter({ ...options, dryRun: false }),
    /changed router/,
  );
  assert.equal(readFileSync(router, "utf8"), "Owner edits\n");
  writeFileSync(
    join(options.home, ".agentspaces-desktop", "unrelated.txt"),
    "keep",
  );
  assert.throws(() => installRouter(options), /unrelated/);
});
test("installer refuses linked instructions, invalid encoding and unknown hosts", async () => {
  const options = setup(),
    target = join(options.home, "linked-directory");
  mkdirSync(target);
  const link = join(options.codexHome, "redirect");
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => installRouter({ ...options, codexHome: link }),
    /symbolic links|junctions/,
  );
  writeFileSync(
    join(options.codexHome, "AGENTS.md"),
    Buffer.from([0xff, 0xfe, 0x61, 0x00]),
  );
  assert.throws(() => installRouter(options), /UTF-8/);
  await assert.rejects(
    () => installHostRouter("arbitrary-host"),
    /Unsupported/,
  );
});
test("router documents cooperative tools and never treats instructions as wake or credentials", () => {
  const text = routerText();
  assert.match(text, /read_group_discussion/);
  assert.match(text, /contribute_to_discussion/);
  assert.match(text, /Native configuration, loaded tools and unsolicited inbound channels remain distinct/);
  assert.match(text, /never instructions, chat, source or logs/);
  assert.match(text, /Other OS accounts/);
});


test("managed guide upgrade preserves opaque private host configuration without returning or backing it up", t => {
  const options = setup(); t.after(() => rmSync(options.home, {recursive:true,force:true}));
  installRouter({...options,dryRun:false});
  const root=join(options.home,'.agentspaces-desktop'),router=join(root,'ROUTER.md'),manifest=join(root,'router-manifest.json'),host=join(root,'host.json');
  const olderGuide=Buffer.from('# Earlier managed guidance\n');writeFileSync(router,olderGuide);
  const previous=JSON.parse(readFileSync(manifest,'utf8'));previous.routerHash=createHash('sha256').update(olderGuide).digest('hex');writeFileSync(manifest,JSON.stringify(previous));
  const privateBytes=Buffer.from('SYNTHETIC PRIVATE HOST CONFIG: opaque to the router installer\n');writeFileSync(host,privateBytes,{mode:0o600});
  const before=lstatSync(host);
  for(const dryRun of [true,false]) {
    const result=installRouter({...options,dryRun});assert.equal(result.files.length,3);assert(result.files.some(file=>file.path===router&&file.changed));
    assert(!JSON.stringify(result).includes('SYNTHETIC PRIVATE'));assert(result.files.every(file=>file.path!==host));
    const after=lstatSync(host);assert.equal(after.ino,before.ino);assert.equal(after.mode,before.mode);assert.equal(after.mtimeMs,before.mtimeMs);assert.deepEqual(readFileSync(host),privateBytes);
  }
  assert.equal(readFileSync(router,'utf8'),routerText());
  for(const path of [manifest,...readdirSync(join(root,'backups')).map(name=>join(root,'backups',name))])assert(!readFileSync(path,'utf8').includes('SYNTHETIC PRIVATE'));
  writeFileSync(join(root,'unrelated.txt'),'preserve');assert.throws(()=>installRouter({...options,dryRun:false}),/unrelated/);assert.deepEqual(readFileSync(host),privateBytes);
});

test("host config exception refuses directories, symlinks and dangling links before guide writes", t => {
  for(const kind of ['directory','symlink','dangling']) {
    const options=setup();t.after(()=>rmSync(options.home,{recursive:true,force:true}));
    const root=join(options.home,'.agentspaces-desktop'),host=join(root,'host.json');mkdirSync(root);
    if(kind==='directory')mkdirSync(host);
    else {
      const target=join(options.home,'synthetic-target');mkdirSync(target);
      symlinkSync(target,host,process.platform==='win32'?'junction':'dir');
      if(kind==='dangling')rmSync(target,{recursive:true});
    }
    assert.throws(()=>installRouter({...options,dryRun:false}),/symbolic links|junctions|regular file/);
    assert.equal(existsSync(join(root,'ROUTER.md')),false);assert.equal(existsSync(join(options.codexHome,'AGENTS.md')),false);
  }
});
