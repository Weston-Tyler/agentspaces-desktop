import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../app/store.mjs';
import { Engine } from '../app/engine.mjs';
import { FabricAdapter } from '../app/fabric.mjs';
import { startServer } from '../app/server.mjs';
import {messageReference} from '../app/agent-message.mjs';

function fixture(t, count = 310) {
  const root = mkdtempSync(join(tmpdir(), 'as-history-'));
  t.after(() => rmSync(root, {recursive:true,force:true}));
  const engine = new Engine(new Store(root),new FabricAdapter({stateRoot:root}));
  engine.loadSample();
  const ids = ['sample-codex-old','sample-claude-new'];
  for(const id of ids) engine.grant(id,{enrolled:true,content:true,retrieve:true,share:true});
  const id = engine.discussions.create({title:'Large fixture room',sessionIds:ids}).id;
  const g = engine.discussions.group(id);
  // Model the durable wire records without hundreds of fixture disk writes.
  const m = engine.discussions.append(g,{text:'雪🦉'.repeat(900),deliveryId:'fixture-message-0000'});
  g.messages = Array.from({length:count},(_,i)=>({...structuredClone(m),id:`fixture-${i}`,deliveryId:`fixture-message-${i}`}));
  g.version=count;
  return {root,engine,g,id,binding:{sessionId:ids[0]},ids};
}
test('an exact source reference reads only its message beyond the latest page, with current grants and hash',async t=>{
 const {root,engine,g,id,binding,ids}=fixture(t),message=g.messages[0],ref=messageReference(g,message);
 const exact=engine.discussions.readPage(ref,binding);assert.equal(exact.messages.length,1);assert.equal(exact.messages[0].id,message.id);assert.deepEqual(exact.reference,ref);assert.equal(exact.members,undefined);assert.equal(exact.messages[0].wire,undefined);assert.equal(exact.messages[0].text,message.text);
 assert.throws(()=>engine.discussions.readPage({...ref,sha256:'0'.repeat(64)},binding),/hash differs/);
 for(const extra of [{limit:1},{cursor:'cursor'}])assert.throws(()=>engine.discussions.readPage({...ref,...extra},binding),/discussion_page_invalid/);
 const app=await startServer({root,port:0,engine});t.after(()=>app.close());const token=engine.issueConnector(ids[0]).token;
 const read=await fetch(app.address+'/api/discussions/context',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(ref)});assert.equal(read.status,200);assert.equal((await read.json()).messages[0].id,message.id);
 message.text+=' changed';assert.throws(()=>engine.discussions.readPage(ref,binding),/hash differs/);
 engine.grant(ids[0],{retrieve:false});assert.throws(()=>engine.discussions.readPage(ref,binding),/retrieval/);assert.equal(engine.modelCalls,0);
});
test('large-room HTTP reads fit the connector budget and retain the full stored history', async t => {
  const {root,engine,g,id,ids}=fixture(t);
  assert(Buffer.byteLength(JSON.stringify(g))>1048576);
  const before=JSON.stringify(g);
  const app=await startServer({root,port:0,engine});
  t.after(()=>app.close());
  const connector=engine.issueConnector(ids[0]);
  const response=await fetch(app.address+'/api/discussions/context',{method:'POST',headers:{Authorization:'Bearer '+connector.token,'Content-Type':'application/json'},body:JSON.stringify({id})});
  assert.equal(response.status,200);
  const raw=await response.text();
  assert(Buffer.byteLength(raw)<=512*1024);
  const page=JSON.parse(raw);
  assert.equal(page.messages.at(-1).id,g.messages.at(-1).id);
  assert.equal(page.page.hasMore,true);
  assert.equal(page.page.totalMessages,g.messages.length);
  assert.equal(JSON.stringify(g),before);
  assert.equal(engine.modelCalls,0);
});
test('older pages reconstruct a frozen snapshot exactly once despite new appends',t=>{
  const {engine,g,id,binding}=fixture(t);
  let page=engine.discussions.readPage({id,limit:23},binding), rows=[...page.messages];
  const original=structuredClone(g.messages);
  engine.discussions.append(g,{text:'new message',deliveryId:'new-message-0001'});
  while(page.page.nextCursor){
    page=engine.discussions.readPage({id,limit:23,cursor:page.page.nextCursor},binding);
    assert(Buffer.byteLength(JSON.stringify(page))<=512*1024);
    assert.equal(page.page.snapshotMessageCount,original.length);
    rows=[...page.messages,...rows];
  }
  assert.deepEqual(rows,original);
  assert.equal(new Set(rows.map(m=>m.id)).size,original.length);
  assert.equal(engine.discussions.readPage({id},binding).messages.at(-1).text,'new message');
});
test('pagination rechecks source grants, membership and message revocation',t=>{
  const {engine,g,id,binding,ids}=fixture(t,3);
  const cursor=engine.discussions.readPage({id,limit:1},binding).page.nextCursor;
  engine.grant(ids[1],{enrolled:false});
  assert.throws(()=>engine.discussions.readPage({id,cursor},binding),/sharing/);
  engine.grant(ids[1],{enrolled:true,content:true,share:true,retrieve:true});
  assert.throws(()=>engine.discussions.readPage({id,cursor},{sessionId:'sample-denied'}),/participant/);
  g.messages[0].source={sessionId:'sample-denied'};
  g.messages[0].synthetic=false;
  assert.equal(engine.discussions.readPage({id,cursor},binding).messages.length,0);
});
test('invalid, foreign and stale cursors fail explicitly, and empty rooms terminate',t=>{
  const {engine,g,id,binding,ids}=fixture(t,4);
  for(const args of [{limit:0},{limit:101},{limit:1.5},{cursor:''},{extra:true}])
    assert.throws(()=>engine.discussions.readPage({id,...args},binding),/discussion_page_invalid/);
  assert.throws(()=>engine.discussions.readPage({id,cursor:'private invalid cursor'},binding),/discussion_cursor_invalid/);
  const cursor=engine.discussions.readPage({id,limit:1},binding).page.nextCursor;
  const other=engine.discussions.create({title:'Other room',sessionIds:ids}).id;
  assert.throws(()=>engine.discussions.readPage({id:other,cursor},binding),/discussion_cursor_invalid/);
  g.messages.pop();
  assert.throws(()=>engine.discussions.readPage({id,cursor},binding),/discussion_cursor_stale/);
  g.messages=[];
  const empty=engine.discussions.readPage({id},binding);
  assert.deepEqual(empty.messages,[]);assert.equal(empty.page.nextCursor,null);assert.equal(empty.page.hasMore,false);
});
test('oversized individual records fail visibly instead of silently dropping evidence',t=>{
  const {engine,g,id,binding}=fixture(t,1);
  g.messages[0].text='x'.repeat(600000);
  assert.throws(()=>engine.discussions.readPage({id},binding),/discussion_page_record_too_large/);
});

test('default and maximum message limits are exact when byte budget permits',t=>{
  const {engine,g,id,binding}=fixture(t,120);
  for (const message of g.messages) {message.text='small';message.wire.text='small';}
  const latest=engine.discussions.readPage({id},binding);
  assert.equal(latest.messages.length,50);assert.equal(latest.page.startIndex,70);
  const maximum=engine.discussions.readPage({id,limit:100},binding);
  assert.equal(maximum.messages.length,100);assert.equal(maximum.page.startIndex,20);
  assert.deepEqual(latest.messages,g.messages.slice(-50));
});
