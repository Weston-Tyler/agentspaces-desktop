import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadMonitorCursor,saveMonitorCursor,renewalNotice,MONITOR_RENEW_AFTER_MS} from '../app/grok-inbox-monitor.mjs';

test('monitor renewal is bounded local maintenance, never peer work or an interrupt',()=>{
  assert.equal(MONITOR_RENEW_AFTER_MS,8*60*60*1000);
  const text=renewalNotice('scheduled');
  assert.match(text,/ensure_native_connection/);
  assert.match(text,/inboxMonitor.arguments/);
  assert.match(text,/safe boundary/);
  assert.match(text,/Do not cancel/);
  assert(!text.includes('BUILDER-INBOX'));
});
test('monitor cursor survives renewal without replay or cross-session reuse',async t=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'monitor-renewal-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const file=join(root,'cursor.json'),identity='a'.repeat(64),now=Date.now();
  const cursor=await loadMonitorCursor(file,identity,now);
  assert.equal(cursor.armedAt,now);
  cursor.seen.add('00000000-0000-4000-8000-000000000001');
  await saveMonitorCursor(file,identity,cursor);
  const renewed=await loadMonitorCursor(file,identity,now+1000);
  assert.equal(renewed.armedAt,now);
  assert.deepEqual([...renewed.seen],[...cursor.seen]);
  assert.equal((await loadMonitorCursor(file,'b'.repeat(64),now+1000)).armedAt,now+1000);
  assert(!String(await readFile(file)).includes('token'));
});
test('linked or corrupt checkpoint fails closed instead of replaying messages',async t=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'monitor-renewal-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const file=join(root,'cursor.json');
  await writeFile(file,'corrupt',{mode:0o600});
  await assert.rejects(loadMonitorCursor(file,'a'.repeat(64),Date.now()));
  if(process.platform!=='win32'){
    const link=join(root,'link.json');await symlink(file,link);
    await assert.rejects(loadMonitorCursor(link,'a'.repeat(64),Date.now()));
  }
});
