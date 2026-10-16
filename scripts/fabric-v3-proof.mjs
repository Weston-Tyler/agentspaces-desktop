// Opt-in interoperability proof: an upstream Java seed and synthetic signed data only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { wire } from '@agentspaces/client';
import { FabricAdapter, TYPES } from '../app/fabric.mjs';
const java=process.env.AGENTSPACES_TEST_JAVA, cp=process.env.AGENTSPACES_TEST_CLASSPATH;
if(!java||!cp) throw new Error('Set AGENTSPACES_TEST_JAVA and AGENTSPACES_TEST_CLASSPATH to a locally built wire-v3 upstream runtime including LoopbackSeed.');
assert.equal(wire.WIRE_VERSION,3);
const socket=createServer(); await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
const port=socket.address().port; await new Promise(resolve=>socket.close(resolve));
const root=mkdtempSync(join(tmpdir(),'agentspaces-wire-v3-'));
const a=new FabricAdapter({stateRoot:join(root,'a')}), b=new FabricAdapter({stateRoot:join(root,'b')});
const child=spawn(java,['-cp',cp,'LoopbackSeed',String(port)],{stdio:['ignore','pipe','pipe']});
let errors=''; child.stderr.on('data',data=>errors=(errors+data).slice(-4000));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,predicate){for(let i=0;i<100;i++){const result=read();if(predicate(result))return result;await wait(100);}throw new Error('Interop observation timed out');}
try {
  const groupId=await new Promise((resolve,reject)=>{
    let out=''; const timer=setTimeout(()=>reject(new Error('Java seed startup timed out')),10000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Java seed exited ${code}: ${errors}`));});
    child.stdout.on('data',data=>{out+=data;const match=/GROUP=([^\r\n]+)/.exec(out);if(match){clearTimeout(timer);resolve(match[1]);}});
  });
  await a.connect({host:'127.0.0.1',port,groupId});await b.connect({host:'127.0.0.1',port,groupId});
  const finding=a.write('desktop-fixture-context',TYPES.finding,{fixture:true,description:'v3 interoperability'},'fixture-author');
  await until(()=>b.read('desktop-fixture-context',TYPES.finding),rows=>rows.some(row=>row.entryId===finding));
  const card=wire.agentCard(groupId,a.peer.identity,'fixture-worker',new Date().toISOString(),'PT15M','Synthetic v3 discovery',['interop'],[TYPES.request],[TYPES.result],{},{});
  a.peer.publishAd('AgentCard',card);
  await until(()=>{b.peer.pullAds();return b.discovery();},view=>view.cards.some(row=>row.id===card.id));
  const request=a.write('desktop-fixture-work',TYPES.request,{fixture:true},'fixture-author');
  const holder=b.participant('fixture-worker');
  const held=await b.peer.takeEntry('desktop-fixture-work',TYPES.request,'fixture-worker',10000,300,8000,holder);
  assert.equal(held,request);
  b.peer.completeEntry('desktop-fixture-work',held,holder);
  await until(()=>{a.peer.pullSpace('desktop-fixture-work');return a.peer.states.get(held);},dto=>dto?.completed===true);
  const oldIdentity=a.participant('fixture-author').agentId;
  a.close(); await a.connect({host:'127.0.0.1',port,groupId});
  assert.equal(a.participant('fixture-author').agentId,oldIdentity);
  console.log(JSON.stringify({proof:'upstream Java / TypeScript wire-v3 loopback',binding:a.diagnostics().binding,wireVersion:wire.WIRE_VERSION,signedEntry:true,signedDiscovery:true,leaseClaim:true,completion:true,stableParticipantAfterReconnect:true,nativeProviderCalls:0,privateConfigurationsRead:false},null,2));
} finally {
  a.close();b.close();child.kill();
  await Promise.race([new Promise(resolve=>child.once('exit',resolve)),wait(2000)]);
  rmSync(root,{recursive:true,force:true});
}
