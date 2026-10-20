import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readCarrierConfig,connectCarrier,watchCarrierParent} from '../scripts/native-ssh-carrier.mjs';
test('carrier validates private config without accepting command injection fields',()=>{
 const root=mkdtempSync(join(tmpdir(),'carrier-'));const path=join(root,'config.json');
 try{
  writeFileSync(path,JSON.stringify({relayPort:40000,fallbackHost:'127.0.0.1',fallbackPort:22}),{mode:0o600});assert.equal(readCarrierConfig(path).relayPort,40000);
  writeFileSync(path,JSON.stringify({relayPort:40000,fallbackHost:'127.0.0.1',fallbackPort:22,command:'echo nope'}));assert.throws(()=>readCarrierConfig(path));
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('carrier selects relay then uses fallback only when the relay TCP connection was never accepted',async()=>{
 let calls=0;const server=net.createServer(s=>{calls++;s.on('error',()=>{});s.end('test');});server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=server.address().port;
 try{
  const relay=await connectCarrier({relayPort:port,fallbackHost:'127.0.0.1',fallbackPort:1});relay.destroy();
  const saved=await connectCarrier({relayPort:1,fallbackHost:'127.0.0.1',fallbackPort:port});saved.destroy();
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(calls,2);
 }finally{server.close();}
});

test('an exited SSH owner closes only its own carrier socket',async()=>{
 const server=net.createServer(s=>{s.on('error',()=>{});s.resume();});server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const socket=await connectCarrier({relayPort:server.address().port,fallbackHost:'127.0.0.1',fallbackPort:1});
  let checked;watchCarrierParent(socket,{parentPid:123,probe:pid=>{checked=pid;throw Object.assign(Error(),{code:'ESRCH'});},intervalMs:10});
  await once(socket,'close');assert.equal(checked,123);assert.equal(socket.destroyed,true);
 }finally{server.close();}
});
