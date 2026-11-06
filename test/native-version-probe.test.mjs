import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readNativeVersion, detectTools } from '../app/native.mjs';
import { REMOTE_HOST } from '../app/remote-host.mjs';
function fake(run) { return (command,args,options) => { const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.kill=()=>{};queueMicrotask(()=>run(c,command,args,options));return c; }; }
test('Windows SSH discovery uses noninteractive overlapped handles and the user launcher, without a model command',async()=>{
 const version=await readNativeVersion(REMOTE_HOST,'claude',{platform:'win32',spawnProcess:fake((c,command,args,options)=>{
  assert.equal(command,'ssh');assert(args.includes('BatchMode=yes'));assert(args.includes('-T'));assert.match(args.at(-1),/HOME.*--version/);assert(!args.some(a=>/resume|prompt|app-server/.test(a)));assert.deepEqual(options.stdio,['ignore','overlapped','overlapped']);assert.equal(options.shell,false);c.stdout.emit('data','2.1.999 (Claude Code)\n');c.emit('close',0);
 })});assert.equal(version,'2.1.999 (Claude Code)');
});
test('failed remote discovery reports unavailable rather than claiming the software is absent',async()=>{
 const tools=await detectTools(REMOTE_HOST,{readVersion:async()=>{throw Object.assign(new Error('private login URL'),{code:'native_version_probe_timeout'});}});
 for(const tool of tools){assert.equal(tool.installed,false);assert.equal(tool.installationObserved,false);assert.equal(tool.discoveryError,'native_version_probe_timeout');assert(!JSON.stringify(tool).includes('private'));}
});
test('bounded probes discard private stderr and reject oversized output or a hung child',async()=>{
 await assert.rejects(readNativeVersion(REMOTE_HOST,'codex',{spawnProcess:fake(c=>{c.stderr.emit('data','private URL');c.stdout.emit('data','x'.repeat(16385));})}),e=>e.code==='native_version_probe_oversized'&&!e.message.includes('private'));
 await assert.rejects(readNativeVersion('local','claude',{timeoutMs:5,spawnProcess:fake(()=>{})}),e=>e.code==='native_version_probe_timeout');
});
test('version detection keeps protocol/release qualification separate from transport success',async()=>{
 const tools=await detectTools('local',{readVersion:async()=> 'future-version',qualify:async()=>({adapterCompatible:false,readAdapterCompatible:true})});
 for(const tool of tools){assert.equal(tool.installed,true);assert.equal(tool.adapterCompatible,false);assert.equal(tool.readAdapterCompatible,true);}
});
