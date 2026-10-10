import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../app/engine.mjs';
import { Store } from '../app/store.mjs';
import { RoomSubscriptions } from '../app/room-subscriptions.mjs';
import { routeConversation } from '../app/conversation-routing.mjs';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'as-topics-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const engine=new Engine(new Store(root),{diagnostics:()=>({}),close(){}},{clock:()=>Date.parse('2026-10-10T12:00:00Z'),nativeFactory:()=>{throw Error('No native execution');}});
  const profile={id:'synthetic-scope',account:'synthetic-owner',active:true,policy:'local-retrieval',hosts:['local'],providers:['codex'],roots:{},exclusions:{},indexFiles:false};
  engine.workspace.index={schema:1,fixture:false,profile,nodes:[],edges:[],sessions:[],coverage:[],errors:[],observedAt:'2026-10-10T12:00:00Z'};
  const sources=Array.from({length:3},(_,i)=>{const nativeThreadId='00000000-0000-4000-8000-'+String(i+1).padStart(12,'0');return {id:'codex@local:'+nativeThreadId,nativeThreadId,provider:'codex',host:'local',cwd:join(root,'synthetic'),account:profile.account,scopeId:profile.id,title:'Synthetic agent '+i,fixture:false};});
  engine.workspace.restore(sources); engine.workspace.index.sessions=sources; engine.workspace.save(); engine.store.save();
  const bindings=sources.map(s=>engine.connector(engine.issueConnector(s.id).token));
  const group=engine.discussions.group(engine.discussions.create({title:'Synthetic room',sessionIds:sources.slice(0,2).map(s=>s.id),agentInitiation:true}).id);
  const service=new RoomSubscriptions(engine), delivered=[];
  const transports={codexAgents:{dispatch:input=>{delivered.push(input);return{status:'queued'};}},channels:{isConnected:()=>false}};
  t.after(()=>assert.equal(engine.modelCalls,0));
  return {engine,group,bindings,sources,service,transports,delivered};
}
const subscribe=(f,extra={})=>f.service.change({id:f.group.id,mode:'wake',topics:['recipe'],...extra},f.bindings[1]);
const contribution=(f,text,deliveryId,replyTo=null)=>{f.engine.discussions.contribute({id:f.group.id,text,nativeTurnId:'synthetic-turn',deliveryId,replyTo},f.bindings[0]);return f.group.messages.find(m=>m.deliveryId===deliveryId);};

test('subscriptions require current membership; source cannot edit a peer and invalid updates are atomic',t=>{
  const f=fixture(t); assert.throws(()=>f.service.change({id:f.group.id,mode:'wake',topics:['recipe']},f.bindings[2]),/participant/);
  assert.throws(()=>subscribe(f,{sessionId:f.sources[0].id}),/own/);
  assert.throws(()=>subscribe(f,{topics:[]}),/topic|brief/);
  assert.equal(f.group.subscriptions,undefined);
  const result=subscribe(f); assert.equal(result.items[0].sessionId,f.sources[1].id);
  assert.throws(()=>subscribe(f,{workEntryId:'missing'}),/work item/);
  assert.equal(f.service.list({id:f.group.id},f.bindings[1]).items[0].topics[0],'recipe');
});
test('matching opt-in opening wakes once; unmatched posts and all implicit replies stay quiet; explicit mentions prevail',async t=>{
  const f=fixture(t);subscribe(f);
  for(const [text,id] of [['unrelated result','unrelated-001'],['Recipe result','matching-001']])await routeConversation(f.engine,f.transports,f.group,contribution(f,text,id));
  assert.equal(f.delivered.length,1);
  const opening=f.group.messages.find(m=>m.deliveryId==='matching-001');
  await routeConversation(f.engine,f.transports,f.group,contribution(f,'recipe acknowledged','reply-0001',opening.id));
  assert.equal(f.delivered.length,1);
  subscribe(f,{mode:'digest'});
  await routeConversation(f.engine,f.transports,f.group,contribution(f,'@codex2 recipe update','explicit-001'));
  assert.equal(f.delivered.length,2);
  await routeConversation(f.engine,f.transports,f.group,opening); assert.equal(f.delivered.length,2);
});
test('owner implicit targeting honors filters and retry freezes recipients across preference edits',t=>{
  const f=fixture(t);subscribe(f);
  const args={id:f.group.id,text:'unrelated update',deliveryId:'owner-filter-001'};
  f.engine.discussions.post(args);assert.deepEqual(f.group.messages[0].targets.map(x=>x.sessionId),[f.sources[0].id]);
  subscribe(f,{topics:['unrelated']});
  f.engine.discussions.post(args);assert.equal(f.group.messages.length,1);
  assert.throws(()=>f.engine.discussions.post({...args,text:'changed'}),/reused/);
  f.engine.discussions.post({...args,deliveryId:'owner-filter-002'});assert.equal(f.group.messages[1].targets.length,2);
});
test('subscription edits are durable; subscription revocation prevents allocated implicit wake and access revocation hides digest',async t=>{
  const f=fixture(t);subscribe(f);
  f.engine.discussions.post({id:f.group.id,text:'recipe update',deliveryId:'owner-allocated-001'});
  subscribe(f,{mode:'off'});
  await routeConversation(f.engine,f.transports,f.group,f.group.messages[0]);
  assert(!f.delivered.some(x=>x.sessionId===f.sources[1].id));
  assert.equal(new Store(f.engine.store.root).data.discussions[0].subscriptions[0].mode,'off');
  f.engine.grant(f.sources[1].id,{enrolled:false,share:false,retrieve:false});
  assert.throws(()=>f.service.list({id:f.group.id},f.bindings[1]));
  assert.throws(()=>f.service.digest({},f.bindings[1]));
  assert.equal(f.service.digest({}).items.filter(x=>x.kind==='message').length,0);
});
test('brief subscriptions require exact existing work references; digest preserves message/work/result/decision/artifact provenance and bounds',async t=>{
  const f=fixture(t);
  const work=await f.engine.workBoard.mutate({action:'create',deliveryId:'work-create-001',title:'Recipe test',brief:'Execute fixture only',repository:'synthetic/repository',base:'a'.repeat(40),allowedFiles:'recipe.mjs'},f.bindings[0]);
  subscribe(f,{topics:[],workEntryId:work.entryId});
  await routeConversation(f.engine,f.transports,f.group,contribution(f,'Update '+work.entryId,'brief-update-001'));
  assert.equal(f.delivered.length,1);
  const decision=await f.engine.workBoard.mutate({action:'decision_create',deliveryId:'decision-create-001',title:'Choose recipe',question:'Which fixture?',options:[{id:'a',label:'A'},{id:'b',label:'B'}],recommendation:'a',blockedWork:[work.entryId]},f.bindings[0]);
  await f.engine.workBoard.mutate({action:'claim',entryId:work.entryId,deliveryId:'claim-work-001'},f.bindings[0]);
  await f.engine.workBoard.mutate({action:'update',entryId:work.entryId,deliveryId:'update-work-001',status:'in_progress',summary:'Recipe verified',branch:'fixture/topic',head:'a'.repeat(40),evidence:'Synthetic result'},f.bindings[0]);
  await f.engine.workBoard.mutate({action:'decision_answer',entryId:decision.entryId,deliveryId:'answer-decision-001',optionId:'a',rationale:'Fixture selection'},null);
  f.engine.workspace.index.nodes.push({id:'artifact:synthetic',kind:'artifact',title:'recipe evidence',path:'/synthetic/evidence.json',host:'local',hash:'b'.repeat(64),modifiedAt:'2026-10-10T11:00:00Z'});
  const result=f.service.digest({limit:200},f.bindings[0]);
  assert.deepEqual(new Set(result.items.map(x=>x.kind)),new Set(['message','work','work-result','decision','decision-answer','artifact']));
  for(const row of result.items){assert.match(row.provenance.hash,/^[a-f0-9]{64}$/);assert.equal(row.authority,'untrusted coordination evidence');}
  assert.equal(result.modelCalls,0);assert.equal(f.service.digest({limit:1}).items.length,1);assert.equal(f.service.digest({limit:1}).coverage.truncated,true);
  assert.throws(()=>f.service.digest({since:'invalid'}),/since/);
  assert.equal(f.service.digest({since:'2026-10-10T12:01:00Z'}).items.length,0);
  assert.equal(f.service.digest({query:'not-present'}).items.length,0);
});

test('subscribing never replays an earlier unallocated peer post',async t=>{
  const f=fixture(t), historical=contribution(f,'recipe old result','historical-001');
  subscribe(f);
  await routeConversation(f.engine,f.transports,f.group,historical);
  assert.equal(f.delivered.length,0);
});

test('HTTP exposes headless scoped preferences and digest, denying foreign member and revoked source',async t=>{
  const {startServer}=await import('../app/server.mjs');
  const f=fixture(t),app=await startServer({root:f.engine.store.root,engine:f.engine,port:0});
  t.after(()=>app.close());
  const connector=f.engine.issueConnector(f.sources[1].id),headers={Authorization:'Bearer '+connector.token,'Content-Type':'application/json'};
  const post=(path,data)=>fetch(app.address+path,{method:'POST',headers,body:JSON.stringify(data)});
  const body={id:f.group.id,mode:'digest',topics:['recipe']};
  assert.equal((await post('/api/discussions/subscription',body)).status,200);
  const listed=await post('/api/discussions/subscriptions',{id:f.group.id});assert.equal(listed.status,200);assert.equal((await listed.json()).items[0].mode,'digest');
  assert.equal((await post('/api/digest',{})).status,200);
  assert.notEqual((await post('/api/discussions/subscription',{...body,sessionId:f.sources[0].id})).status,200);
  f.engine.grant(f.sources[1].id,{enrolled:false,share:false,retrieve:false});
  assert.notEqual((await post('/api/digest',{})).status,200);
});

test('digest reuses the owning artifact projection with the exact caller and preserves content plus record hashes',t=>{
  const f=fixture(t);let observed;
  f.engine.workBoard.artifacts=(binding,options)=>{observed={binding,options};return {items:[{entryId:'artifact-record',hash:'c'.repeat(64),value:{createdAt:f.engine.clock(),name:'recipe-report',version:2,source:{participantId:f.sources[0].id},artifact:{mediaType:'text/plain',bytes:10,digest:'d'.repeat(64)},workEntryId:'work-reference',discussionId:f.group.id,messageId:'message-reference'}}],truncated:false};};
  const digest=f.service.digest({},f.bindings[0]);
  assert.equal(observed.binding,f.bindings[0]);assert.deepEqual(observed.options,{limit:200});
  assert.equal(digest.coverage.artifactDropAvailable,true);
  const item=digest.items.find(row=>row.kind==='artifact-drop');
  assert.equal(item.provenance.hash,'c'.repeat(64));assert.equal(item.provenance.artifactHash,'d'.repeat(64));assert.equal(item.provenance.messageId,'message-reference');
  f.engine.workBoard.artifacts=()=>{throw Error('Artifact scope revoked');};
  assert.throws(()=>f.service.digest({},f.bindings[0]),/revoked/);
});
