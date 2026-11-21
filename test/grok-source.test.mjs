import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authorizeGrokRecovery, observeGrokSource } from '../app/grok-source.mjs';

test('managed Grok recovery is restricted to the observed child and session', { skip:process.platform !== 'linux' }, async t => {
  const home = await mkdtemp(join(await realpath(tmpdir()),'grok-managed-recovery-'));
  t.after(() => rm(home,{recursive:true,force:true}));
  const base = join(home,'.agentspaces-desktop-native','automatic');
  const managed = join(base,'managed');
  await mkdir(managed,{recursive:true,mode:0o700});
  const entry = join(managed,'native-bootstrap-mcp.mjs');
  const contents = "console.log('ready'); setInterval(() => {}, 1000);";
  await writeFile(entry,contents,{mode:0o600});
  const manifest = join(managed,'current.json');
  await writeFile(manifest,JSON.stringify({schema:1,protocol:1,entryHash:createHash('sha256').update(contents).digest('hex')}),{mode:0o600});
  const legacyConfig = join(base,'claude','device.json'); // No Claude device needs to exist.
  const nativeThreadId = randomUUID();
  const exe = await realpath(process.execPath);
  const child = spawn(exe,[entry,'--config',legacyConfig],{
    cwd:home,env:{...process.env,GROK_SESSION_ID:nativeThreadId},stdio:['ignore','pipe','ignore'],
  });
  const closed = once(child,'exit');
  try {
    await once(child.stdout,'data');
    const device = { nodeExecutable:exe,nativeExecutable:exe,host:'local',entry:'/fixture/other.mjs',configPath:join(base,'grok','device.json') };
    assert.equal(await observeGrokSource({pid:child.pid,nativeThreadId,device}),null);
    const upgraded = {...device,nativeExecutable:'/fixture/new-grok',nativeVersion:'1.0.92',nativeRuntimes:[{executable:exe,version:'1.0.88'}]};
    const approvedEntry = {...upgraded,entries:[entry],configPath:legacyConfig};
    assert.equal((await observeGrokSource({pid:child.pid,nativeThreadId,device:approvedEntry}))?.sourceVersion,'1.0.88');
    assert.equal(await observeGrokSource({pid:child.pid,nativeThreadId,device:{...approvedEntry,nativeRuntimes:[]}}),null);
    assert.equal(await observeGrokSource({pid:child.pid,nativeThreadId,device:{...approvedEntry,entries:[]}}),null);
    assert.equal((await authorizeGrokRecovery(child.pid,upgraded,home))?.nativeThreadId,nativeThreadId);
    const recovery = await authorizeGrokRecovery(child.pid,device,home);
    assert.equal(recovery?.nativeThreadId,nativeThreadId);
    const armed = {...device,recovery};
    assert.equal((await observeGrokSource({pid:child.pid,nativeThreadId,device:armed}))?.provider,'grok');
    assert.equal(await observeGrokSource({pid:child.pid,nativeThreadId:randomUUID(),device:armed}),null);
    assert.equal(await observeGrokSource({pid:child.pid,nativeThreadId,device:{...device,recovery:{...recovery,startedAt:'0'}}}),null);
    await writeFile(manifest,JSON.stringify({schema:1,protocol:1,entryHash:'0'.repeat(64)}));
    assert.equal(await authorizeGrokRecovery(child.pid,device,home),null);
  } finally {
    child.kill();
    await closed;
  }
});
