import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,statSync,rmSync,utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {resolveSavedCompanion,processStartedAt} from '../app/companion-runtime.mjs';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'as-runtime-recovery-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const path=join(root,'runtime.json'),record={address:'http://127.0.0.1:43127',admin:'a'.repeat(64),instance:'fictional-instance',pid:12345};
 writeFileSync(path,JSON.stringify(record));const written=statSync(path).mtimeMs;
 const options={fetchImpl:async()=>{throw Error('Connection unavailable');},portClosed:async()=>true,processAlive:()=>true,startedAt:async()=>written+10000};
 return {path,record,written,options};
}
test('a stale runtime with a reused PID recovers without touching the unrelated process or record',async t=>{
 const f=fixture(t);assert.deepEqual(await resolveSavedCompanion(f.path,f.options),{status:'stale',reason:'pid-reused'});
 assert.equal(statSync(f.path).mtimeMs,f.written);
});
test('healthy authenticated identity attaches without process inspection or replacement',async t=>{
 const f=fixture(t);const result=await resolveSavedCompanion(f.path,{...f.options,fetchImpl:async()=>({ok:true,json:async()=>({instance:f.record.instance,pid:f.record.pid})}),processAlive:()=>{throw Error('No inspection needed');}});
 assert.deepEqual(result,{status:'attached',address:f.record.address});
});
test('a hung or unknown living owner is preserved; newer birth must be proven',async t=>{
 const f=fixture(t);
 for(const born of [null,NaN,f.written-10000,f.written+500])await assert.rejects(resolveSavedCompanion(f.path,{...f.options,startedAt:async()=>born}),/process may still be running/);
});
test('an explicitly selected unavailable runtime never falls back even when its process is gone',async t=>{
 const f=fixture(t);await assert.rejects(resolveSavedCompanion(f.path,{...f.options,explicit:true,processAlive:()=>false}),/Explicit companion runtime/);
});
test('an occupied or unobservable port prevents replacement, including with a dead recorded process',async t=>{
 const f=fixture(t);await assert.rejects(resolveSavedCompanion(f.path,{...f.options,processAlive:()=>false,portClosed:async()=>false}),/port is occupied or unavailable/);
});
test('a dead recorded owner with a closed port retains normal stale-runtime recovery',async t=>{
 const f=fixture(t);assert.deepEqual(await resolveSavedCompanion(f.path,{...f.options,processAlive:()=>false,startedAt:async()=>{throw Error('No birth lookup needed');}}),{status:'stale',reason:'process-absent'});
});
test('malformed or nonloopback runtime records never send credentials or start recovery',async t=>{
 const f=fixture(t);for(const change of [{address:'https://example.invalid'},{pid:-1},{admin:''}]){writeFileSync(f.path,JSON.stringify({...f.record,...change}));await assert.rejects(resolveSavedCompanion(f.path,{...f.options,fetchImpl:()=>{throw Error('Must not send credentials');}}),/Invalid saved companion runtime/);}
});
test('process birth observation is bounded and reads only the requested process start time',async()=>{
 const observed=await processStartedAt(process.pid),expected=Date.now()-process.uptime()*1000;
 assert.equal(typeof observed,'number');assert(Math.abs(observed-expected)<3000);
});

test('real closed-port recovery proves PID reuse using the native process birth observation',async t=>{
 const f=fixture(t),server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 writeFileSync(f.path,JSON.stringify({...f.record,address:'http://127.0.0.1:'+port,pid:process.pid}));
 const past=new Date(Date.now()-process.uptime()*1000-10000);utimesSync(f.path,past,past);
 assert.deepEqual(await resolveSavedCompanion(f.path),{status:'stale',reason:'pid-reused'});
});
test('a real listener with a different identity is preserved despite a provably stale PID record',async t=>{
 const f=fixture(t),server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({instance:'another-owner',pid:process.pid}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 writeFileSync(f.path,JSON.stringify({...f.record,address:'http://127.0.0.1:'+server.address().port,pid:process.pid}));
 const past=new Date(Date.now()-process.uptime()*1000-10000);utimesSync(f.path,past,past);
 await assert.rejects(resolveSavedCompanion(f.path),/port is occupied or unavailable/);
});
