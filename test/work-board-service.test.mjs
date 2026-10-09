import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../app/store.mjs';
import { Engine } from '../app/engine.mjs';
import { WorkBoard } from '../app/work-board-service.mjs';
import { cbor } from '@agentspaces/client';
function fixture(t) {
 const root=mkdtempSync(join(tmpdir(),'as-board-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 let now=Date.now();const engine=new Engine(new Store(root),{diagnostics:()=>({}),close(){}},{clock:()=>now,nativeFactory:()=>{throw Error('No native calls');}});
 engine.workspace.index={profile:{id:'scope',account:'synthetic-account',active:true,policy:'local-retrieval'}};
 // Permission checks are exercised over HTTP separately; here isolate lifecycle behavior.
 engine.discussions.participant=b=>{if(b.revoked)throw Error('revoked');return {id:b.sessionId,scopeId:'scope',account:'synthetic-account'};};
 return {root,engine,board:engine.workBoard,advance:ms=>now+=ms};
}
const create={action:'create',deliveryId:'create-fixture-0001',title:'Work item',brief:'Goal and tests',repository:'https://example.invalid/repo',base:'a'.repeat(40),allowedFiles:'src/one.js'};
const progress=id=>({action:'update',entryId:id,deliveryId:'update-fixture-0001',status:'blocked',summary:'Needs input',branch:'test/work',head:'b'.repeat(40),evidence:'Synthetic evidence'});
test('create, exact claim, progress, completion and receipts survive restart',async t=>{
 const f=fixture(t),a={sessionId:'a'},b={sessionId:'b'};
 const item=await f.board.mutate(create,a);const duplicate=await f.board.mutate(create,a);assert.equal(duplicate.entryId,item.entryId);assert.equal(duplicate.duplicate,true);
 await assert.rejects(f.board.mutate({...create,title:'different'},a),/reused/);
 await f.board.mutate({action:'claim',entryId:item.entryId,deliveryId:'claim-fixture-0001'},b);
 await assert.rejects(f.board.mutate(progress(item.entryId),a),/live claim/);
 await f.board.mutate(progress(item.entryId),b);
 const complete={...progress(item.entryId),action:'complete',deliveryId:'complete-fixture-0001'};
 await assert.rejects(f.board.mutate({...complete,evidence:''},b),/evidence/);
 await f.board.mutate(complete,b);
 const restored=new WorkBoard(f.engine);const view=restored.view(b);
 assert.equal(view.items.length,1);assert.equal(view.items[0].status,'completed');assert.equal(view.items[0].results.length,2);
 assert.equal((await restored.mutate(complete,b)).duplicate,true);assert.equal(f.engine.modelCalls,0);
});
test('simultaneous claims have one winner; expiry enables a new holder',async t=>{
 const f=fixture(t),item=await f.board.mutate(create,null);
 const outcomes=await Promise.allSettled(['a','b'].map(sessionId=>f.board.mutate({action:'claim',entryId:item.entryId,leaseMinutes:1,deliveryId:'race-claim-'+sessionId},{sessionId})));
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
 f.advance(61000);
 await assert.rejects(f.board.mutate(progress(item.entryId),{sessionId:'a'}),/live claim/);
 await f.board.mutate({action:'claim',entryId:item.entryId,deliveryId:'new-claim-0001'},{sessionId:'b'});
 assert.equal(f.board.view(null).items[0].status,'claimed');
});
test('revocation and workspace replacement deny reads and duplicate writes',async t=>{
 const f=fixture(t),a={sessionId:'a'};await f.board.mutate(create,a);
 a.revoked=true;assert.throws(()=>f.board.view(a),/revoked/);await assert.rejects(f.board.mutate(create,a),/revoked/);
 f.engine.workspace.index.profile.active=false;assert.throws(()=>f.board.view(null),/active/);
 f.engine.workspace.index.profile.active=true;f.engine.workspace.index.profile.id='other';assert.throws(()=>f.board.view(null),/another workspace/);
});
test('tampering fails closed on every reopen',async t=>{
 const f=fixture(t);await f.board.mutate(create,null);
 const path=join(f.root,'work-board','replica.cbor'),saved=cbor.loads(readFileSync(path));
 saved.replica.states[0].record.payload=cbor.dumps({title:'forged'});writeFileSync(path,cbor.dumps(saved));
 const restored=new WorkBoard(f.engine);
 assert.throws(()=>restored.view(null),/verification failed/);assert.throws(()=>restored.view(null),/verification failed/);
});

test('overlapping live repository paths block another lane while disjoint paths remain claimable',async t=>{
 const f=fixture(t),a={sessionId:'a'},b={sessionId:'b'};
 const first=await f.board.mutate(create,a);
 const overlap=await f.board.mutate({...create,deliveryId:'create-overlap-0001',allowedFiles:'src/'},b);
 const disjoint=await f.board.mutate({...create,deliveryId:'create-disjoint-0001',allowedFiles:'docs/readme.md'},b);
 await f.board.mutate({action:'claim',entryId:first.entryId,deliveryId:'claim-first-0001'},a);
 await assert.rejects(f.board.mutate({action:'claim',entryId:overlap.entryId,deliveryId:'claim-overlap-0001'},b),/overlaps/);
 await f.board.mutate({action:'claim',entryId:disjoint.entryId,deliveryId:'claim-disjoint-0001'},b);
 await assert.rejects(f.board.mutate({action:'renew',entryId:first.entryId,deliveryId:'renew-wrong-0001'},b),/live claim/);
 f.advance(5000);
 await f.board.mutate({action:'renew',entryId:first.entryId,deliveryId:'renew-right-0001'},a);
});
