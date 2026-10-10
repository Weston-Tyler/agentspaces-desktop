import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../app/store.mjs';
import { Engine } from '../app/engine.mjs';
import { WorkBoard } from '../app/work-board-service.mjs';
function fixture(t) {
 const root=mkdtempSync(join(tmpdir(),'as-lane-artifacts-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 let now=Date.now();const engine=new Engine(new Store(root),{diagnostics:()=>({}),close(){}},{clock:()=>now,nativeFactory:()=>{throw Error('No native calls');}});
 engine.workspace.index={profile:{id:'scope',account:'synthetic-account',active:true,policy:'local-retrieval'}};
 engine.store.data.projects.p={id:'p',account:'synthetic-account',metadataGrant:true};
 engine.catalog=['a','b'].map(id=>({id,project:'p',scopeId:'scope',account:'synthetic-account',provider:'codex',nativeThreadId:'native-'+id,title:'Lane '+id,host:'local'}));
 engine.workspace.sessionAllowed=()=>true;const revoked=new Set();engine.permissions=s=>({enrolled:true,retrieve:!revoked.has(s.id),share:!revoked.has(s.id)});
 engine.discussions.participant=b=>{if(revoked.has(b.sessionId))throw Error('revoked');return engine.session(b.sessionId);};
 return {root,engine,board:engine.workBoard,a:{sessionId:'a'},b:{sessionId:'b'},revoked,now:()=>now,advance:ms=>now+=ms};
}
const brief={action:'create',deliveryId:'create-artifact-0001',title:'Lane task',brief:'Goal and tests',repository:'https://example.invalid/repo',base:'a'.repeat(40),allowedFiles:'src/a.js'};
const upload=id=>({action:'artifact_create',deliveryId:'upload-report-0001',workEntryId:id,name:'report.md',text:'# Synthetic evidence',mediaType:'text/markdown'});
async function claim(f){const item=await f.board.mutate(brief,f.a);await f.board.mutate({action:'claim',entryId:item.entryId,deliveryId:'claim-report-0001'},f.a);return item.entryId;}
test('artifact immutable versions use owning replica, exact hash, scoped source and survive restart',async t=>{
 const f=fixture(t),id=await claim(f),request=upload(id),first=await f.board.mutate(request,f.a);
 assert.equal((await f.board.mutate(request,f.a)).entryId,first.entryId);
 const read=f.board.artifacts(f.b,{entryId:first.entryId}).items[0];
 assert.equal(read.value.artifact.text,request.text);assert.equal(read.value.artifact.digest,createHash('sha256').update(request.text).digest('hex'));assert.equal(read.value.source.participantId,'a');
 const second=await f.board.mutate({...request,deliveryId:'upload-report-0002',text:'Corrected evidence',previousEntryId:first.entryId},f.a);
 assert.equal(second.version,2);assert.equal(new WorkBoard(f.engine).artifacts(f.b,{entryId:second.entryId}).items[0].value.previousEntryId,first.entryId);
 assert.ok(!JSON.stringify(f.board.artifacts(f.b,{workEntryId:id})).includes('Corrected evidence'));
 await assert.rejects(f.board.mutate({...request,deliveryId:'upload-report-fork',previousEntryId:first.entryId},f.a),/latest/);
});
test('artifact drop rejects foreign claim, path tricks, oversized bytes, invented links and revoked author reads',async t=>{
 const f=fixture(t),id=await claim(f),request=upload(id);
 await assert.rejects(f.board.mutate(request,f.b),/claim/);
 for(const changes of [{name:'../report.md'},{name:'a/b.md'},{text:'😀'.repeat(5000)},{workEntryId:'invented'},{path:'/tmp/escape'}])await assert.rejects(f.board.mutate({...request,...changes},f.a));
 const first=await f.board.mutate(request,f.a);f.revoked.add('a');
 assert.throws(()=>f.board.artifacts(f.b,{entryId:first.entryId}),/unavailable/);
});
test('lane status defaults unknown and uses exact result/decision/native provenance without chat parsing',async t=>{
 const f=fixture(t),id=await claim(f);
 assert.equal(f.board.lanes(f.b,{}).items.find(x=>x.sessionId==='a').status,'unknown');
 await f.board.mutate({action:'update',entryId:id,deliveryId:'progress-lane-0001',status:'blocked',summary:'Need input',branch:'feature/a',head:'b'.repeat(40),evidence:'fixture report'},f.a);
 let lane=f.board.lanes(f.b,{}).items.find(x=>x.sessionId==='a');assert.equal(lane.status,'blocked');assert.equal(lane.branch,'feature/a');assert.equal(lane.provenance.kind,'work-result');
 f.engine.session('a').executionObservation={state:'active',observedAt:new Date(f.now()).toISOString(),source:'native-thread-list'};
 lane=f.board.lanes(f.b,{}).items.find(x=>x.sessionId==='a');assert.equal(lane.status,'working');assert.equal(lane.provenance.kind,'native-thread-list');
 f.advance(61000);assert.equal(f.board.lanes(f.b,{}).items.find(x=>x.sessionId==='a').status,'blocked');
 f.revoked.add('a');assert.ok(!f.board.lanes(f.b,{}).items.some(x=>x.sessionId==='a'));
});

test('lane decisions are explicit owner waits and expired artifacts are not readable',async t=>{
 const f=fixture(t),id=await claim(f),created=await f.board.mutate(upload(id),f.a);
 await f.board.mutate({action:'decision_create',deliveryId:'lane-decision-0001',title:'Choose next step',question:'Proceed?',options:[{id:'yes',label:'Yes'},{id:'no',label:'No'}],recommendation:'yes',blockedWork:[id]},f.a);
 const row=f.board.lanes(f.b,{}).items.find(lane=>lane.sessionId==='a');assert.equal(row.status,'waiting-owner');assert.equal(row.provenance.kind,'decision-request');
 f.advance(30*86400000+1);assert.throws(()=>f.board.artifacts(f.b,{entryId:created.entryId}),/unavailable/);assert.equal(f.board.artifacts(f.b,{}).items.length,0);
});
