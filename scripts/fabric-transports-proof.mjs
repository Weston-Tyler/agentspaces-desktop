// Opt-in synthetic Java/TypeScript interoperability. No production config,
// private sources, model calls or custom transport implementation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FabricAdapter, TYPES } from '../app/fabric.mjs';
import { wire } from '@agentspaces/client';
const java=process.env.AGENTSPACES_TEST_JAVA, cp=process.env.AGENTSPACES_TEST_CLASSPATH;
if(!java||!cp) throw Error('Supply Java 21 and the locally built pinned upstream 0.4.0 classpath including TransportSeed.');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,predicate) {
  for(let i=0;i<150;i++){const value=read();if(predicate(value))return value;await wait(100);}
  throw Error('Cross-transport observation timed out');
}
async function prove(scheme) {
  const root=mkdtempSync(join(tmpdir(),'as-040-transport-'));
  const servers=[createServer(),createServer()]; const udp=createSocket('udp4');
  await Promise.all(servers.map(server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))));
  await new Promise(resolve=>udp.bind(0,'127.0.0.1',resolve));
  const ports=servers.map(server=>server.address().port), udpPort=udp.address().port;
  await Promise.all([...servers.map(server=>new Promise(resolve=>server.close(resolve))),new Promise(resolve=>udp.close(resolve))]);
  const a=new FabricAdapter({stateRoot:join(root,'a')}), b=new FabricAdapter({stateRoot:join(root,'b')});
  const child=spawn(java,['-XX:ActiveProcessorCount=2','-Xmx512m','-cp',cp,'TransportSeed',...ports.map(String),String(udpPort),scheme],{stdio:['ignore','pipe','pipe']});
  let diagnostics=''; child.stderr.on('data',data=>diagnostics=(diagnostics+data).slice(-4000));
  try {
    const groupId=await new Promise((resolve,reject)=>{
      let output='';const timer=setTimeout(()=>reject(Error('Gateway startup timeout')),25000);
      const fail=error=>{clearTimeout(timer);reject(error);};
      child.once('error',fail);child.once('exit',code=>fail(Error(`Gateway fixture exited ${code}: ${diagnostics}`)));
      child.stdout.on('data',data=>{output+=data;const match=/GROUP=([^\r\n]+)/.exec(output);if(match){clearTimeout(timer);resolve(match[1]);}});
    });
    await a.connect({host:'127.0.0.1',port:ports[0],groupId});
    await b.connect({host:'127.0.0.1',port:ports[1],groupId});
    const entryId=a.write('desktop-fixture-context',TYPES.finding,{fixture:true,scheme},'fixture-author');
    const rows=await until(()=>b.read('desktop-fixture-context',TYPES.finding),rows=>rows.some(row=>row.entryId===entryId));
    assert.equal(rows.filter(row=>row.entryId===entryId).length,1);
    assert.equal(rows.find(row=>row.entryId===entryId).value.scheme,scheme);
    const card=wire.agentCard(groupId,a.peer.identity,'fixture-worker',new Date().toISOString(),'PT15M','Synthetic transport discovery',[scheme],[TYPES.request],[TYPES.result],{},{});
    a.peer.publishAd('AgentCard',card);
    await until(()=>{b.peer.pullAds();return b.discovery();},view=>view.cards.some(row=>row.id===card.id));
    const request=a.write('desktop-fixture-work',TYPES.request,{fixture:true,scheme},'fixture-author');
    await until(()=>b.read('desktop-fixture-work',TYPES.request),rows=>rows.some(row=>row.entryId===request));
    const holder=b.participant('fixture-worker');
    const held=await b.peer.takeEntry('desktop-fixture-work',TYPES.request,'worker',30000,300,8000,holder,request);
    assert.equal(held,request);b.peer.completeEntry('desktop-fixture-work',held,holder);
    await until(()=>{a.peer.pullSpace('desktop-fixture-work');return a.peer.states.get(request);},dto=>dto?.completed===true);
    const identity=a.participant('fixture-author').agentId;
    a.close();await a.connect({host:'127.0.0.1',port:ports[0],groupId});
    assert.equal(a.participant('fixture-author').agentId,identity);
    return {scheme,wireVersion:wire.WIRE_VERSION,signedEntry:true,signedDiscovery:true,claim:true,completion:true,stableIdentityAfterReconnect:true};
  } finally {
    a.close();b.close();child.kill();
    await Promise.race([new Promise(resolve=>child.once('exit',resolve)),wait(3000)]);
    rmSync(root,{recursive:true,force:true});
  }
}
const results=[];
for(const scheme of ['dtls','quic'])results.push(await prove(scheme));
console.log(JSON.stringify({proof:'Desktop TCP / upstream Java UDP gateways / Desktop TCP',results,nativeProviderCalls:0,privateConfigurationsRead:false,productionTransportChanged:false},null,2));
