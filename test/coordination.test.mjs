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
 engine.session = id => ({id,host:'remote'});
 return {root,engine,board:engine.workBoard,advance:ms=>now+=ms};
}
const decision={action:'decision_create',deliveryId:'decision-new-001',title:'Choose mode',question:'Which profile?',options:[{id:'a',label:'Baseline'},{id:'b',label:'Candidate'}],recommendation:'a'};
const machine={action:'machine_create',deliveryId:'machine-new-001',name:'Test host',host:'remote',lockPaths:['/tmp/synthetic-slot-1','/tmp/synthetic-slot-2'],gateCommand:[]};
const op=(action,entryId,extra={})=>({action,entryId,deliveryId:crypto.randomUUID(),...extra});
import { randomUUID } from 'node:crypto';
const crypto={randomUUID};
test('decisions retain source evidence and owner-only answers across restart',async t=>{
 const f=fixture(t),a={sessionId:'a'};const d=await f.board.mutate(decision,a);
 assert.equal(f.board.decisions(a).items[0].status,'open');assert.equal(f.board.decisions(a).canAnswer,false);
 await assert.rejects(f.board.mutate(op('decision_answer',d.entryId,{optionId:'b',rationale:'Pick candidate'}),a),/Only the owner/);
 await assert.rejects(f.board.mutate(op('decision_answer',d.entryId,{optionId:'bogus',rationale:'Invalid'}),null),/Unknown decision option/);
 const answer=op('decision_answer',d.entryId,{optionId:'a',rationale:'Keep baseline until tests finish'});
 await f.board.mutate(answer,null);assert.equal((await f.board.mutate(answer,null)).duplicate,true);
 const restored=new WorkBoard(f.engine);const row=restored.decisions(a).items[0];assert.equal(row.status,'answered');assert.equal(row.answer.value.actor,'desktop-owner');assert.equal(row.answer.value.optionId,'a');assert.match(row.hash,/^[a-f0-9]{64}$/);
 await assert.rejects(f.board.mutate(op('decision_withdraw',d.entryId,{rationale:'Too late'}),a),/closed/);
});
test('requesters cannot withdraw peers decisions or supply invented blocked work',async t=>{
 const f=fixture(t);await assert.rejects(f.board.mutate({...decision,blockedWork:['invented']},{sessionId:'a'}),/Unknown blocked/);
 const d=await f.board.mutate(decision,{sessionId:'a'});
 await assert.rejects(f.board.mutate(op('decision_withdraw',d.entryId,{rationale:'No'}),{sessionId:'b'}),/requester/);
 await f.board.mutate(op('decision_withdraw',d.entryId,{rationale:'Resolved elsewhere'}),{sessionId:'a'});assert.equal(f.board.decisions(null).items[0].status,'withdrawn');
});
async function queue(f,id,actor,extra={}){return f.board.mutate({action:'machine_request',deliveryId:randomUUID(),machineId:id,title:'Tests',minutes:1,...extra},actor);}
test('machine admission is FIFO, supports exclusive slots, and releases claims for the next job',async t=>{
 const f=fixture(t),a={sessionId:'a'},b={sessionId:'b'};
 await assert.rejects(f.board.mutate(machine,a),/Only the owner/);
 const m=await f.board.mutate(machine,null),one=await queue(f,m.machineId,a,{exclusive:true});f.advance(1);const two=await queue(f,m.machineId,b);
 await assert.rejects(f.board.mutate(op('machine_acquire',two.entryId),b),/queue position 2/);
 const acquired=await f.board.mutate(op('machine_acquire',one.entryId),a);assert.equal(acquired.lockPaths.length,2);
 await assert.rejects(f.board.mutate(op('machine_acquire',two.entryId),b),/slots busy/);
 await assert.rejects(f.board.mutate(op('machine_release',one.entryId,{summary:'Forged release'}),b),/requester/);
 await f.board.mutate(op('machine_release',one.entryId,{summary:'Process group exited'}),a);
 assert.equal((await f.board.mutate(op('machine_acquire',two.entryId),b)).lockPaths.length,1);
});
test('expired runners block new admission until explicit owner reconciliation, including after restart',async t=>{
 const f=fixture(t),a={sessionId:'a'},b={sessionId:'b'};const m=await f.board.mutate(machine,null),one=await queue(f,m.machineId,a);
 await f.board.mutate(op('machine_acquire',one.entryId),a);f.advance(61000);f.board=new WorkBoard(f.engine);
 const two=await queue(f,m.machineId,b);
 assert.equal(f.board.machines(null).requests.find(x=>x.entryId===one.entryId).state,'reconciliation_required');
 await assert.rejects(f.board.mutate(op('machine_acquire',two.entryId),b),/reconciliation/);
 await assert.rejects(f.board.mutate(op('machine_reconcile',one.entryId,{summary:'Stopped'}),a),/Only the owner/);
 await f.board.mutate(op('machine_reconcile',one.entryId,{summary:'Verified old runner stopped and actual locks free'}),null);
 await f.board.mutate(op('machine_acquire',two.entryId),b);
});
test('release priority and aging are bounded; stale waiters do not block active work',async t=>{
 const f=fixture(t),a={sessionId:'a'};const m=await f.board.mutate(machine,null),one=await queue(f,m.machineId,a);
 await assert.rejects(queue(f,m.machineId,{sessionId:'b'},{priority:'release'}),/owner/);
 for(let n=0;n<10;n++){f.advance(5*60000);await f.board.mutate(op('machine_heartbeat',one.entryId),a);}
 const urgent=await queue(f,m.machineId,null,{priority:'release'});
 assert.equal(f.board.machines(null).requests.find(r=>r.entryId===one.entryId).position,1);
 await f.board.mutate(op('machine_cancel',one.entryId,{summary:'No longer needed'}),a);
 assert.equal(f.board.machines(null).requests.find(r=>r.entryId===urgent.entryId).position,1);
 f.advance(11*60000);assert.equal(f.board.machines(null).requests.find(r=>r.entryId===urgent.entryId).state,'expired');
 const active=await queue(f,m.machineId,a);assert.equal((await f.board.mutate(op('machine_acquire',active.entryId),a)).status,'reserved');
});
test('owner can prioritize a queued agent job without replacing its requester',async t=>{
 const f=fixture(t),a={sessionId:'a'},b={sessionId:'b'},m=await f.board.mutate(machine,null);
 const first=await queue(f,m.machineId,a);f.advance(1);const second=await queue(f,m.machineId,b);
 await assert.rejects(f.board.mutate(op('machine_prioritize',second.entryId),b),/owner/);
 await f.board.mutate(op('machine_prioritize',second.entryId),null);
 const rows=f.board.machines(a).requests;assert.equal(rows.find(r=>r.entryId===second.entryId).position,1);assert.equal(rows.find(r=>r.entryId===first.entryId).position,2);
 await f.board.mutate(op('machine_acquire',second.entryId),b);
});
test('two concurrent admission calls allocate different slots and durable duplicate requests never allocate twice',async t=>{
 const f=fixture(t),a={sessionId:'a'},b={sessionId:'b'},m=await f.board.mutate(machine,null);
 const first=await queue(f,m.machineId,a);f.advance(1);const second=await queue(f,m.machineId,b);
 const request=op('machine_acquire',first.entryId);
 const [x,y]=await Promise.all([f.board.mutate(request,a),f.board.mutate(op('machine_acquire',second.entryId),b)]);const duplicate=await f.board.mutate(request,a);assert.equal(duplicate.duplicate,true);assert.deepEqual(x.slotIds,duplicate.slotIds);
 assert.notEqual(x.slotIds[0],y.slotIds[0]);
 const restored=new WorkBoard(f.engine);assert.equal(restored.machines(null).requests.filter(r=>r.state==='reserved').length,2);
});

const approvalScope={repo:'https://example.test/team/project',branch:'feat/example',folder:'/workspace/example',action:'Run the regression tests',limits:['No push','No deployment']};
test('approval requests persist immutable scope and cannot become authority through ordinary owner answers',async t=>{
 const f=fixture(t),actor={sessionId:'a'};
 const request={...decision,approval:approvalScope};
 const created=await f.board.mutate(request,actor);
 assert.equal((await f.board.mutate(request,actor)).duplicate,true);
 const restored=new WorkBoard(f.engine),row=restored.decisions(actor).items[0];
 assert.deepEqual({...row.value.approval},{...approvalScope,targetSessionId:'a'});
 assert.equal(row.approvalDelivery,'awaiting_owner_approval');
 assert.equal(row.canAnswer,false);
 for(const binding of [null,actor,{sessionId:'b'}])await assert.rejects(f.board.mutate(op('decision_answer',created.entryId,{optionId:'a',rationale:'Owner approved'}),binding),/verified owner approval route/i);
 assert.equal(f.board.decisions(null).items[0].status,'open');
 await f.board.mutate(op('decision_withdraw',created.entryId,{rationale:'Superseded'}),actor);
 assert.equal(f.board.decisions(null).items[0].status,'withdrawn');
});
test('approval scope rejects forged targets and missing or malformed boundaries',async t=>{
 const f=fixture(t),actor={sessionId:'a'};
 for(const approval of [null,{}, {...approvalScope,targetSessionId:'b'}, {...approvalScope,limits:[]}, {...approvalScope,repo:''}, {...approvalScope,standing:true}]) {
  await assert.rejects(f.board.mutate({...decision,approval},actor),/approval/i);
 }
 await assert.rejects(f.board.mutate({...decision,approval:approvalScope},null),/source-bound/i);
 assert.equal(f.board.decisions(null).items.length,0);
});

import { OwnerApprovalAuth } from '../app/owner-approval-auth.mjs';
test('verified approval binds request hash, survives restart, is target scoped and can be revoked',async t=>{
 const f=fixture(t),a={sessionId:'a'},password='synthetic password for approval lifecycle';
 const auth=new OwnerApprovalAuth(f.engine.store,{clock:f.engine.clock});await auth.configure(password);
 const d=await f.board.mutate({...decision,approval:approvalScope},a),row=f.board.decisions(a).items[0];
 const answer=op('decision_approve',d.entryId,{requestHash:row.hash,outcome:'approve_with_limits',limits:['Only unit tests'],rationale:'Proceed locally',expiresAt:f.engine.clock()+3600000});
 await assert.rejects(f.board.mutate(answer,null),/proof/);
 const bad={...answer,requestHash:'0'.repeat(64)};await assert.rejects(f.board.mutate(bad,null,await auth.verify(password,bad)),/hash/);
 await f.board.mutate(answer,null,await auth.verify(password,answer));
 f.board=new WorkBoard(f.engine);
 assert.equal(f.board.decisions(a).items[0].authorization.valid,true);
 assert.equal(f.board.decisions({sessionId:'b'}).items[0].authorization.valid,false);
 assert.equal(f.board.decisions(a).items[0].answer.value.verification.method,'owner-password');
 const revoke=op('decision_revoke',d.entryId,{rationale:'Pause this work'});
 await assert.rejects(f.board.mutate(revoke,a),/owner/);
 await f.board.mutate(revoke,null,await auth.verify(password,revoke));
 assert.equal(f.board.decisions(a).items[0].authorization.valid,false);
 assert.equal(f.board.decisions(a).items[0].approvalDelivery,'revoked');
});
test('approval expiry and password rotation invalidate grants, while decision payloads cannot broaden scope',async t=>{
 const f=fixture(t),a={sessionId:'a'},password='synthetic password for expiry lifecycle';
 const auth=new OwnerApprovalAuth(f.engine.store,{clock:f.engine.clock});await auth.configure(password);
 const d=await f.board.mutate({...decision,approval:approvalScope},a),row=f.board.decisions(a).items[0];
 const answer=op('decision_approve',d.entryId,{requestHash:row.hash,outcome:'approve',limits:[],rationale:'Proceed',expiresAt:f.engine.clock()+1000});
 await f.board.mutate(answer,null,await auth.verify(password,answer));
 await auth.configure('a replacement synthetic owner password',password);
 assert.equal(f.board.decisions(a).items[0].approvalDelivery,'credential_changed');
 assert.equal(f.board.decisions(a).items[0].authorization.valid,false);
 f.advance(1001);
 assert.equal(f.board.decisions(a).items[0].authorization.valid,false);
 assert.equal(f.board.decisions(a).items[0].approvalDelivery,'expired');
});
