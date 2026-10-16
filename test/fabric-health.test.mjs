import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FabricAdapter } from '../app/fabric.mjs';
import { Identity, Peer, wire } from '@agentspaces/client';

test('fabric diagnostics identify the declared pin and actual runtime protocol', () => {
  const fabric = new FabricAdapter();
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(fabric.diagnostics().binding, manifest.dependencies['@agentspaces/client'].split('#')[1]);
  assert.equal(fabric.diagnostics().wireVersion, wire.WIRE_VERSION);
});

test('fabric socket loss cannot keep reads or writes reporting connected', () => {
  const fabric = new FabricAdapter();
  let connected = true;
  fabric.peer = { connected: () => connected, close() {}, frames: {stale:2,ahead:1,replayed:3}, reconnects:4, malformedFrames:5, ignoredKinds:new Map([['FUTURE',2]]) };
  fabric.status = 'connected';
  assert.equal(fabric.diagnostics().status, 'connected');
  connected = false;
  assert.equal(fabric.status, 'disconnected');
  assert.throws(() => fabric.read('work','type'), /disconnected/i);
  assert.throws(() => fabric.write('work','type',{},'session'), /disconnected/i);
  assert.equal(fabric.diagnostics().recovery.inProgress, null);
  assert.equal(fabric.diagnostics().counters.reconnects,4);
  fabric.close();
  assert.equal(fabric.diagnostics().status,'closed');
});

const now = Date.parse('2026-10-16T12:00:00Z');
function fixture() {
  const id = Identity.generate();
  const peer = new Peer(Identity.generate(),'fixture-group',() => now);
  const fabric = new FabricAdapter({clock:() => now});
  fabric.peer = peer;
  const card = wire.agentCard(peer.group,id,'worker',new Date(now-1000).toISOString(),'PT15M','Research',['research'],['Work#v1'],['Result#v1'],{},{});
  const publish = (value = card) => peer.acceptAd(wire.storedAd('AgentCard',value,id));
  return {fabric,peer,id,card,publish};
}

test('signed discovery preserves fabric identity without inventing native recipients', () => {
  const {fabric,peer,id,publish} = fixture(); publish(); peer.reachable.add(id.peerId);
  const view = fabric.discovery();
  assert.equal(view.cards.length,1);
  assert.equal(view.cards[0].peerId,id.peerId);
  assert.equal(view.cards[0].nativeIdentity,null);
  assert.equal(view.cards[0].wakeAvailable,false);
  assert.equal(view.cards[0].reachable,false); // cached reachability is not a current socket
  assert.equal(view.coverage.complete,false);
});

test('discovery excludes wrong-group, expired, future, revoked and tampered cards', () => {
  for (const kind of ['group','expired','future','revoked','tampered','identity']) {
    const {fabric,peer,id,card,publish} = fixture();
    if (kind==='group') card.group='other-group';
    if (kind==='expired') card.issued=new Date(now-3600000).toISOString();
    if (kind==='future') card.issued=new Date(now+60001).toISOString();
    if (kind==='identity') card.agent='someone-else/worker';
    const cached=publish();
    if(kind==='revoked') peer.revocations.peers.set(id.peerId,{});
    if(kind==='tampered') cached.stored.signature=new Uint8Array(64);
    assert.equal(fabric.discovery().cards.length,0,kind);
  }
});

test('discovery returns bounded, filtered, non-exporting projections', () => {
  const {fabric,peer,id,card,publish}=fixture(); publish();
  publish({...card,id:`aspace://${peer.group}/agent/${id.peerId}/second`,agent:`${id.peerId}/second`,description:'Other'});
  assert.equal(fabric.discovery({limit:1}).cards.length,1);
  assert.equal(fabric.discovery({limit:1}).truncated,true);
  assert.equal(fabric.discovery({query:'not-present'}).cards.length,0);
  assert.throws(()=>fabric.discovery({limit:201}),/limit/);
  assert.equal(fabric.discovery().publishesLocalMetadata,false);
});

test('cache projection edits cannot alter a signed discovery card', () => {
  const {fabric,peer,publish}=fixture(); const cached=publish();
  cached.ad.description='forged display';
  assert.equal(fabric.discovery().cards[0].description,'Research');
  peer.ads.clear();
  assert.deepEqual(fabric.discovery().cards,[]);
});

test('real upstream socket recovery refreshes adapter health and owner close is final', async () => {
  const {createServer}=await import('node:net');
  const sockets=new Set();
  const server=createServer(socket=>{sockets.add(socket); socket.on('data',()=>{}); socket.on('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const peer=new Peer(Identity.generate(),'fixture-group');
  peer.reconnectIntervalMs=20;
  const fabric=new FabricAdapter(); fabric.peer=peer;
  const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('socket observation timed out');};
  try {
    await peer.connect('127.0.0.1',server.address().port); fabric.status='connected';
    assert.equal(fabric.diagnostics().status,'connected');
    for(const socket of sockets)socket.destroy();
    await until(()=>peer.reconnects>0);
    assert.equal(fabric.diagnostics().status,'connected');
    assert.ok(fabric.diagnostics().counters.reconnects>0);
    fabric.close();
    await until(()=>sockets.size===0);
    assert.equal(fabric.diagnostics().status,'closed');
    await new Promise(resolve=>setTimeout(resolve,60));
    assert.equal(sockets.size,0);
  } finally {fabric.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
});

test('diagnostics bound untrusted ignored-kind keys and expose omitted counter coverage', () => {
  const fabric=new FabricAdapter();
  const kinds=new Map([['x'.repeat(600000),3],...Array.from({length:150},(_,i)=>[`UNKNOWN_${i}`,i])]);
  fabric.peer={connected:()=>false,ignoredKinds:kinds,reconnects:4,frames:{stale:2,ahead:0,replayed:3},malformedFrames:1};
  const view=fabric.diagnostics();
  assert.ok(Buffer.byteLength(JSON.stringify(view))<30000);
  assert.ok(Object.keys(view.counters.ignoredKinds).length<=100);
  assert.ok(Object.keys(view.counters.ignoredKinds).every(key=>key.length<=128));
  assert.equal(view.counters.ignoredKindsTruncated,true);
  assert.equal(view.counters.ignoredKindsTotal,151);
  assert.equal(view.counters.ignoredKindsOmitted,151-Object.keys(view.counters.ignoredKinds).length);
  assert.equal(view.counters.reconnects,4);
});

test('diagnostic counters reject negative, nonfinite and nonnumeric values', () => {
  const fabric=new FabricAdapter();
  fabric.peer={connected:()=>false,ignoredKinds:new Map([['VALID',5],['BAD','x'.repeat(600000)]]),reconnects:Infinity,frames:{stale:-1,ahead:'4',replayed:NaN},malformedFrames:Number.MAX_SAFE_INTEGER+1,reconnectWindowMs:'x'.repeat(600000)};
  const view=fabric.diagnostics();
  for(const key of ['reconnects','staleFrames','futureFrames','replayedFrames','malformedFrames']) assert.equal(view.counters[key],null,key);
  assert.equal(view.counters.ignoredKinds.VALID,5);
  assert.equal(view.counters.ignoredKinds.BAD,null);
  assert.equal(view.recovery.reconnectWindowMillis,null);
  assert.ok(Buffer.byteLength(JSON.stringify(view))<30000);
});

test('discovery bounds examined cache records even for noncards and limit one', () => {
  const {fabric,peer,publish}=fixture(); const cached=publish(); peer.ads.clear();
  for(let i=0;i<400;i++)peer.ads.set(`other-${i}`,{type:'Other'});
  peer.ads.set(cached.ad.id,cached);
  let view=fabric.discovery({limit:1});
  assert.equal(view.coverage.scanned,256);
  assert.equal(view.coverage.verified,0);
  assert.equal(view.coverage.recordBudgetReached,true);
  assert.equal(view.coverage.truncated,true);
  assert.equal(view.truncated,true);
  peer.ads.clear();
  for(let i=0;i<400;i++)peer.ads.set(`card-${i}`,cached);
  view=fabric.discovery({limit:1});
  assert.equal(view.coverage.scanned,256);
  assert.equal(view.coverage.verified,256);
  assert.equal(view.cards.length,1);
  assert.equal(view.truncated,true);
});

test('discovery caps cumulative signed bytes before verification and decoding', () => {
  const {fabric,peer,card,publish}=fixture();
  const cached=publish({...card,description:'x'.repeat(240000)});peer.ads.clear();
  for(let i=0;i<20;i++)peer.ads.set(`large-${i}`,cached);
  const view=fabric.discovery({limit:1});
  assert.ok(view.coverage.signedBytes<=1048576);
  assert.equal(view.coverage.verified,4);
  assert.equal(view.coverage.scanned,5);
  assert.equal(view.coverage.byteBudgetReached,true);
  assert.equal(view.coverage.truncated,true);
  assert.equal(view.truncated,true);
  assert.equal(view.cards.length,1);
});
