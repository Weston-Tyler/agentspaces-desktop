import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBridgeHealth, probeRemoteBridge } from '../app/bridge-health.mjs';

test('bridge health authenticates a fresh challenge to this companion without disclosing owner data',()=>{
 const a=createBridgeHealth(),b=createBridgeHealth(),nonce='a'.repeat(64),reply=a.respond(nonce);
 assert.deepEqual(Object.keys(reply).sort(),['nonce','proof','state']);assert(a.verify(reply,nonce));
 assert.equal(b.verify(reply,nonce),false);assert.equal(a.verify(reply,'b'.repeat(64)),false);
 assert.equal(a.verify({...reply,state:'stopping'},nonce),false);assert.equal(a.verify(a.respond(nonce,'stopping'),nonce),false);
 assert.equal(a.verify({...reply,proof:'bad'},nonce),false);assert.equal(a.respond('bad'),null);
});
test('remote health probe uses bounded read-only stdin and no source capability or native controller',async()=>{
 let script,closes=0;const nonce='b'.repeat(64),reply=createBridgeHealth().respond(nonce);
 const result=await probeRemoteBridge({remotePort:45678,authority:'127.0.0.1:43127',nonce},{spawnProcess:(name,args,options)=>{
  assert.equal(name,'ssh');assert(args.includes('BatchMode=yes'));assert(!args.some(a=>/resume|cancel|token/i.test(a)));
  assert.equal(options.shell,false);const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.kill=()=>closes++;
  child.stdin.end=value=>{script=value;queueMicrotask(()=>{child.stdout.emit('data',JSON.stringify(reply));child.emit('close',0);});};return child;
 }});
 assert.deepEqual(result,reply);assert(script.includes('/api/native/bridge-probe?nonce='));assert(!/Authorization|Bearer|thread\//.test(script));assert.equal(closes,0);
});
test('authentication failures are bounded and never expose the SSH diagnostic or login URL',async()=>{
 await assert.rejects(probeRemoteBridge({remotePort:45678,authority:'127.0.0.1:43127',nonce:'c'.repeat(64)},{spawnProcess:()=>{
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.kill=()=>{};
  child.stdin.end=()=>queueMicrotask(()=>{child.stderr.emit('data','Tailscale SSH requires an additional check; https://private.example/login');child.emit('close',1);});return child;
 }}),e=>e.code==='bridge_authentication_required'&&!e.message.includes('https:'));
});
