import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Engine} from '../app/engine.mjs';
import {Store} from '../app/store.mjs';
import {ProviderRouting} from '../app/provider-routing.mjs';
import {recordUsage} from '../app/usage.mjs';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'as-provider-routing-'));t.after(()=>rmSync(root,{recursive:true,force:true}));let now=Date.parse('2026-10-10T12:00:00Z');
 const engine=new Engine(new Store(root),{diagnostics:()=>({}),close(){}},{clock:()=>now,nativeFactory:()=>{throw Error('No native execution');}});
 const profile={id:'synthetic-scope',account:'synthetic-owner',active:true,policy:'local-retrieval',hosts:['local'],providers:['codex','claude'],roots:{},exclusions:{},indexFiles:false};
 engine.workspace.index={schema:1,fixture:false,profile,nodes:[],edges:[],sessions:[],coverage:[],errors:[],observedAt:new Date(now).toISOString(),stale:false};
 const sources=['codex','claude'].map((provider,i)=>{const nativeThreadId='00000000-0000-4000-8000-'+String(i+1).padStart(12,'0');return{id:provider+'@local:'+nativeThreadId,nativeThreadId,provider,host:'local',cwd:join(root,'worktree'),account:profile.account,scopeId:profile.id,title:'Synthetic '+provider,fixture:false};});
 engine.workspace.restore(sources);engine.workspace.index.sessions=sources;engine.workspace.save();engine.store.save();
 const bindings=sources.map(s=>engine.connector(engine.issueConnector(s.id).token));
 const room=engine.discussions.create({title:'Synthetic room',sessionIds:sources.map(s=>s.id)});
 const service=new ProviderRouting(engine);t.after(()=>assert.equal(engine.modelCalls,0));
 return{root,engine,sources,bindings,service,room,tick:ms=>{now+=ms;}};
}
async function work(f){
 const result=await f.engine.workBoard.mutate({action:'create',deliveryId:'create-work-001',title:'Synthetic brief',brief:'Run fixture tests',repository:'synthetic/repo',base:'a'.repeat(40),allowedFiles:'app/fixture.mjs'},f.bindings[0]);
 await f.engine.workBoard.mutate({action:'claim',entryId:result.entryId,deliveryId:'claim-work-001'},f.bindings[0]);
 await f.engine.workBoard.mutate({action:'update',entryId:result.entryId,deliveryId:'update-work-001',status:'blocked',summary:'Waiting on provider',branch:'fixture/branch',head:'b'.repeat(40),evidence:'Synthetic evidence'},f.bindings[0]);
 f.engine.workspace.index.nodes.push({id:'worktree:synthetic',kind:'worktree',path:f.sources[0].cwd,host:'local',repositoryId:'repository:synthetic',branch:'refs/heads/fixture/branch',head:'b'.repeat(40)});
 const row=f.engine.workBoard.view(f.bindings[0]).items[0];
 return{workEntryId:row.entryId,workHash:row.hash,worktreeId:'worktree:synthetic',targetSessionId:f.sources[1].id};
}
test('owner availability expires without implying quotas and scoped agents cannot impersonate owner reports',t=>{
 const f=fixture(t);const input={provider:'claude',state:'limited',minutes:5};
 assert.throws(()=>f.service.report(input,f.bindings[0]),/native.*receipt|nativeRequestId/);
 const report=f.service.report(input);assert.equal(report.origin,'owner-report');assert.equal(report.weeklyQuota,null);
 const before=f.service.view({},f.bindings[0]);assert.equal(before.providers.find(p=>p.provider==='claude').availability.state,'limited');
 f.tick(300001);const after=f.service.view({},f.bindings[0]);assert.equal(after.providers.find(p=>p.provider==='claude').availability.state,'unknown');
 assert.equal(after.providers.find(p=>p.provider==='claude').availability.report.state,'limited');
});
test('native error reports require this source exact persisted receipt; raw diagnostics and provider quota claims never escape',t=>{
 const f=fixture(t),receipt={requestId:'error-receipt',sessionId:f.sources[0].id,discussionId:f.room.id,status:'native-agent-unavailable',reasonCode:'native_rpc_rejected',at:new Date(f.engine.clock()).toISOString(),reason:'PRIVATE-SYNTHETIC-TOKEN'};
 f.engine.store.data.codexDiscussionDeliveries={'error-receipt':receipt};
 const reported=f.service.report({nativeRequestId:'error-receipt',minutes:5},f.bindings[0]);
 assert.equal(reported.origin,'native-error-receipt');assert.equal(reported.appliesTo,'source');assert.equal(reported.sourceId,f.sources[0].id);
 assert(!JSON.stringify(reported).includes('PRIVATE-SYNTHETIC'));assert.equal(reported.weeklyQuota,null);
 assert.throws(()=>f.service.report({nativeRequestId:'error-receipt',minutes:5},f.bindings[1]),/receipt/);
 assert.throws(()=>f.service.report({nativeRequestId:'invented',minutes:5},f.bindings[0]),/receipt/);
 assert.equal(f.service.view({},f.bindings[0]).providers.find(p=>p.provider==='codex').availability.state,'unknown');
});
test('observed metrics distinguish known zero, omitted fields and unknown receipts without adding overlapping streams',t=>{
 const f=fixture(t),source=f.sources[0];
 recordUsage(f.engine.store,{provider:source.provider,account:source.account,threadId:source.nativeThreadId,turnId:'turn-a',scope:'turn',input:0,output:5});
 f.engine.store.data.codexDiscussionDeliveries={a:{sessionId:source.id,usage:{known:false}},b:{sessionId:source.id,usage:{known:true,inputTokens:7,outputTokens:2}}};
 const usage=f.service.view({},f.bindings[0]).providers.find(p=>p.provider==='codex').usage;
 assert.equal(usage.sessions.metrics.input.value,0);assert.equal(usage.sessions.metrics.cachedInput.value,null);
 assert.equal(usage.discussions.metrics.inputTokens.value,7);assert.equal(usage.discussions.metrics.inputTokens.unknownRecords,1);
 assert.equal(usage.combinedTotal,null);assert.equal(usage.weeklyQuota,null);
 const scoped=f.service.view({},f.bindings[1]).providers.find(p=>p.provider==='codex');assert.equal(scoped.usage.sessions.records,0);
});
test('handoff preview pins brief, result, repo and worktree; request uses decision contract and never transfers claim',async t=>{
 const f=fixture(t),input=await work(f),before=structuredClone(f.engine.workBoard.view(f.bindings[0]).items[0]);
 const preview=f.service.preview(input,f.bindings[0]);assert.equal(preview.proposal.workHash,input.workHash);assert.equal(preview.proposal.head,'b'.repeat(40));assert.equal(preview.proposal.repository,'synthetic/repo');
 const result=await f.service.request({...input,proposalHash:preview.proposalHash,deliveryId:'handoff-request-001'},f.bindings[0]);
 const decision=f.engine.workBoard.decisions(f.bindings[0]).items.find(row=>row.entryId===result.entryId);
 assert.deepEqual(decision.value.blockedWork,[input.workEntryId]);assert.match(decision.value.question,/proposal only/);assert(decision.value.question.includes(preview.proposalHash));
 const after=f.engine.workBoard.view(f.bindings[0]).items[0];assert.equal(after.holder,before.holder);assert.equal(after.claimExpiresAt,before.claimExpiresAt);assert.equal(after.results.length,before.results.length);
 assert.equal(Object.keys(f.engine.store.data.headlessJobReceipts??{}).length,0);
});
test('handoff rejects stale revisions, foreign claims, changed availability, revoked targets and stale worktree inventory',async t=>{
 const f=fixture(t),input=await work(f);assert.throws(()=>f.service.preview(input,f.bindings[1]),/holder|owner/);
 const preview=f.service.preview(input,f.bindings[0]);
 f.service.report({provider:'claude',state:'unavailable',minutes:5});
 assert.throws(()=>f.service.preview(input,f.bindings[0]),/available/);
 await assert.rejects(f.service.request({...input,proposalHash:preview.proposalHash,deliveryId:'handoff-request-002'},f.bindings[0]));
 f.service.report({provider:'claude',state:'available',minutes:5});
 f.engine.workspace.index.nodes[0].head='c'.repeat(40);assert.throws(()=>f.service.preview(input,f.bindings[0]),/revision/);
 f.engine.workspace.index.nodes[0].head='b'.repeat(40);f.engine.workspace.index.stale=true;assert.throws(()=>f.service.preview(input,f.bindings[0]),/fresh/);
 f.engine.workspace.index.stale=false;f.engine.grant(f.sources[1].id,{enrolled:false,share:false,retrieve:false});assert.throws(()=>f.service.preview(input,f.bindings[0]),/eligible|sharing/);
});

test('a recovered native receipt invalidates its old source availability report',t=>{
 const f=fixture(t);f.engine.store.data.codexDiscussionDeliveries={receipt:{requestId:'receipt',sessionId:f.sources[0].id,discussionId:f.room.id,status:'native-agent-unavailable',reasonCode:'native_rpc_timeout',at:new Date(f.engine.clock()).toISOString()}};
 f.service.report({nativeRequestId:'receipt',minutes:5},f.bindings[0]);
 f.engine.store.data.codexDiscussionDeliveries.receipt.status='native-agent-replied';
 const report=f.service.view({},f.bindings[0]).providers.find(row=>row.provider==='codex').sourceReports[0];
 assert.equal(report.invalidated,true);assert.equal(report.expired,true);
});

test('HTTP separates source error reporting from owner provider settings and exposes scoped observed usage',async t=>{
 const {startServer}=await import('../app/server.mjs');const f=fixture(t),app=await startServer({root:f.root,engine:f.engine,port:0});t.after(()=>app.close());
 const page=await fetch(app.address),cookie=page.headers.get('set-cookie').split(';')[0];
 const owner={Cookie:cookie,Origin:app.address,'X-AgentSpaces':'local-companion','Content-Type':'application/json'},scoped={Authorization:'Bearer '+f.engine.issueConnector(f.sources[0].id).token,'Content-Type':'application/json'};
 const post=(path,data,headers)=>fetch(app.address+path,{method:'POST',headers,body:JSON.stringify(data)});
 assert.equal((await post('/api/providers/availability',{provider:'claude',state:'available',minutes:10},owner)).status,200);
 assert.notEqual((await post('/api/providers/availability',{provider:'claude',state:'available',minutes:10},scoped)).status,200);
 const response=await post('/api/providers/status',{},scoped);assert.equal(response.status,200);assert.equal((await response.json()).canSetAvailability,false);
 f.engine.grant(f.sources[0].id,{enrolled:false,share:false,retrieve:false});assert.notEqual((await post('/api/providers/status',{},scoped)).status,200);
});

test('request rejects a preview after progress changes and duplicate requests retain one decision',async t=>{
 const f=fixture(t),input=await work(f),first=f.service.preview(input,f.bindings[0]);
 const args={...input,proposalHash:first.proposalHash,deliveryId:'handoff-stable-001'};
 const one=await f.service.request(args,f.bindings[0]),two=await f.service.request(args,f.bindings[0]);assert.equal(two.entryId,one.entryId);assert.equal(two.duplicate,true);
 await f.engine.workBoard.mutate({action:'update',entryId:input.workEntryId,deliveryId:'handoff-progress-001',status:'blocked',summary:'New evidence',branch:'fixture/branch',head:'b'.repeat(40),evidence:'new synthetic evidence'},f.bindings[0]);
 await assert.rejects(f.service.request({...args,deliveryId:'handoff-stale-002'},f.bindings[0]),/proposal changed/);
 assert.equal(f.engine.workBoard.decisions(f.bindings[0]).items.length,1);
});
