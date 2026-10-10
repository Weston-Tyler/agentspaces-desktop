import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../app/store.mjs';
import {Engine} from '../app/engine.mjs';
import {OwnerApprovalAuth} from '../app/owner-approval-auth.mjs';
import {WorkBoard} from '../app/work-board-service.mjs';
import {ContinuationWaker} from '../app/work-continuation.mjs';
const op=(action,extra={})=>({action,deliveryId:randomUUID(),...extra});
async function fixture(t,{wakeEnabled=true}={}){
 const root=mkdtempSync(join(tmpdir(),'as-continuation-'));t.after(()=>rmSync(root,{recursive:true,force:true}));let now=Date.now();
 const engine=new Engine(new Store(root),{diagnostics:()=>({}),close(){}},{clock:()=>now,nativeFactory:()=>{throw Error('No native calls');}});
 engine.workspace.index={profile:{id:'scope',account:'synthetic',active:true,policy:'local-retrieval'}};
 engine.discussions.participant=b=>{if(b.revoked)throw Error('revoked');return {id:b.sessionId,scopeId:'scope',account:'synthetic'};};
 const source={id:'a',provider:'codex',host:'remote',cwd:'/fixture',nativeThreadId:'00000000-0000-4000-8000-000000000001'};
 engine.session=id=>({...source,id});engine.permissions=()=>({enrolled:true,retrieve:true,share:true,content:true});
 const board=engine.workBoard,a={sessionId:'a'},password='synthetic standing approval password';
 const auth=new OwnerApprovalAuth(engine.store,{clock:engine.clock});await auth.configure(password);
 const work=await board.mutate(op('create',{title:'Implement brief',brief:'Test then implement and qualify',repository:'https://example.test/repo',base:'base',allowedFiles:'app'}),a);
 await board.mutate(op('claim',{entryId:work.entryId,leaseMinutes:60}),a);
 const item=board.view(a).items[0];
 const scope={repo:item.value.repository,branch:'feat/work',folder:'/fixture',action:'Continue this brief to gate',limits:['No device changes'],standing:{workEntryId:item.entryId,workHash:item.hash,alwaysAsk:['push','merge','deploy','devices','provisioning'],maxWakes:2}};
 const request=await board.mutate(op('decision_create',{title:'Continue brief',question:'May I continue?',options:[{id:'yes',label:'Yes'},{id:'no',label:'No'}],recommendation:'yes',approval:scope}),a);
 const row=board.decisions(a,{entryId:request.entryId}).items[0];
 const answer=op('decision_approve',{entryId:request.entryId,requestHash:row.hash,outcome:'approve',wakeEnabled,limits:[],expiresAt:now+3600000,rationale:'Within brief'});
 const issued=await board.mutate(answer,null,await auth.verify(password,answer));
 const continuation={state:'pending',stepId:'step-1',summary:'Run regression checks',kind:'tests',decisionId:row.entryId,requestHash:row.hash,receiptId:issued.resultEntryId};
 const update=(value=continuation)=>board.mutate(op('update',{entryId:item.entryId,status:'in_progress',summary:'Ready for next check',branch:scope.branch,head:'head',evidence:'Synthetic test',continuation:value}),a);
 return {engine,board,a,auth,password,item,scope,request,row,continuation,update,advance:ms=>now+=ms};
}
test('standing approval binds exact brief and source; pending step retains always-ask limits',async t=>{
 const f=await fixture(t);await f.update();
 let row=f.board.continuations(f.a).items[0];assert.equal(row.state,'ready');assert.equal(row.step.stepId,'step-1');
 await f.update({...f.continuation,stepId:'step-2',kind:'push'});
 assert.equal(f.board.continuations(f.a).items[0].state,'waiting_on_owner');
 await f.update({...f.continuation,state:'gate_ready'});assert.equal(f.board.continuations(f.a).items[0].state,'gate_ready');
 await assert.rejects(f.board.mutate(op('update',{entryId:f.item.entryId,status:'in_progress',summary:'wrong branch',branch:'other',head:'head',evidence:'',continuation:f.continuation}),f.a),/branch/);
});
test('idle wakes deduplicate across restart and never dispatch busy or unknown native state',async t=>{
 const f=await fixture(t);await f.update();let native='busy',sends=0;
 const waker=new ContinuationWaker(f.engine,{inspect:async()=>({state:native}),route:async(group,message)=>{message.routing={allocated:true};sends++;}});
 await waker.tick();assert.equal(sends,0);native='unknown';await waker.tick();assert.equal(sends,0);
 native='idle';await waker.tick();assert.equal(sends,1);await waker.tick();assert.equal(sends,1);
 const restarted=new ContinuationWaker(f.engine,{inspect:async()=>({state:'idle'}),route:async(group,message)=>{message.routing={allocated:true};sends++;}});
 await restarted.tick();assert.equal(sends,1);
 f.engine.workBoard=new WorkBoard(f.engine);assert.equal(f.engine.workBoard.continuations(f.a).items[0].state,'wake_recorded');
});
test('expiry, revocation, closed claims and wake caps prevent future native starts',async t=>{
 const f=await fixture(t);await f.update();let sends=0;
 const waker=new ContinuationWaker(f.engine,{inspect:async()=>({state:'idle'}),route:async(group,message)=>{message.routing={allocated:true};sends++;}});
 await waker.tick();await f.update({...f.continuation,stepId:'step-2'});await waker.tick();assert.equal(sends,2);
 await f.update({...f.continuation,stepId:'step-3'});await waker.tick();assert.equal(sends,2);assert.equal(f.board.continuations(f.a).items[0].state,'wake_budget_exhausted');
 const revoke=op('decision_revoke',{entryId:f.request.entryId,rationale:'Pause'});await f.board.mutate(revoke,null,await f.auth.verify(f.password,revoke));
 assert.equal(f.board.continuations(f.a).items[0].state,'approval_revoked');await waker.tick();assert.equal(sends,2);
});
test('draining and revocation during metadata observation prevent a wake',async t=>{
 const f=await fixture(t);await f.update();let sends=0,allowed=false,observed=0;
 const waker=new ContinuationWaker(f.engine,{dispatchAllowed:()=>allowed,inspect:async()=>{observed++;const revoke=op('decision_revoke',{entryId:f.request.entryId,rationale:'Pause'});await f.board.mutate(revoke,null,await f.auth.verify(f.password,revoke));return {state:'idle'};},route:async(group,message)=>{message.routing={allocated:true};sends++;}});
 await waker.tick();assert.equal(observed,0);allowed=true;await waker.tick();assert.equal(observed,1);assert.equal(sends,0);
});
import {CodexDiscussionHub} from '../app/codex-discussions.mjs';
test('idle inspection reads native metadata only, leaves pause/cold/busy queues alone',async t=>{
 const f=await fixture(t);f.engine.store.data.desktopPreferences={allowNativeFullAccess:true};const calls=[];let state='active',queue=[];
 const hub=new CodexDiscussionHub(f.engine,{adapterFactory:()=>({open:async()=>{},close(){},request:async(method)=>{calls.push(method);return method==='thread/read'?{thread:{id:f.engine.session('a').nativeThreadId,cwd:'/fixture',status:{type:state},canAcceptDirectInput:true}}:{data:queue};}})});
 t.after(()=>hub.close());
 assert.equal((await hub.inspectContinuation('a')).state,'busy');state='notLoaded';assert.equal((await hub.inspectContinuation('a')).state,'unknown');
 state='idle';queue=[{id:'user-paused-input'}];assert.equal((await hub.inspectContinuation('a')).state,'queued');queue=[];assert.equal((await hub.inspectContinuation('a')).state,'idle');
 assert.ok(calls.every(method=>['thread/read','thread/queue/list'].includes(method)));
 f.engine.session=id=>({id,provider:'claude',host:'remote'});assert.equal((await hub.inspectContinuation('a')).state,'unsupported');
});
test('expired grants, inactive claims and terminal progress stop waking',async t=>{
 const f=await fixture(t);await f.update();f.advance(3600001);
 assert.equal(f.board.continuations(f.a).items[0].state,'claim_inactive');
 await f.board.mutate(op('claim',{entryId:f.item.entryId,leaseMinutes:60}),f.a);
 assert.equal(f.board.continuations(f.a).items[0].state,'approval_expired');
});
test('continuation binding never falls back to a cold native resume',async t=>{
 const f=await fixture(t);f.engine.store.data.desktopPreferences={allowNativeFullAccess:true};let resumed=0;
 const hub=new CodexDiscussionHub(f.engine,{adapterFactory:()=>({open:async()=>{},close(){},bindLoadedThread:async()=>{throw Object.assign(Error('cold'),{code:'native_loaded_target_not_available'});},bindExistingThread:async()=>{resumed++;}})});
 hub.validate=()=>f.engine.session('a');t.after(()=>hub.close());await assert.rejects(hub.bind(f.engine.session('a'),{continuation:true}),/cold/);assert.equal(resumed,0);
});
test('standing wake grants are off until owner enables them and step IDs cannot change work',async t=>{
 const f=await fixture(t,{wakeEnabled:false});await f.update();assert.equal(f.board.continuations(f.a).items[0].state,'wake_disabled');
 await assert.rejects(f.update({...f.continuation,summary:'Different work'}),/reused/);
 await f.update({...f.continuation,state:'blocked'});assert.equal(f.board.continuations(f.a).items[0].state,'blocked');
});
test('known unsent wake intent survives drain without allocating another message',async t=>{
 const f=await fixture(t);await f.update();let allowed=true,sends=0;
 const original=f.engine.store.save.bind(f.engine.store);f.engine.store.save=()=>{original();if((f.engine.store.data.discussions??[]).some(g=>g.messages.some(m=>m.continuation)))allowed=false;};
 const waker=new ContinuationWaker(f.engine,{dispatchAllowed:()=>allowed,inspect:async()=>({state:'idle'}),route:async(g,m)=>{m.routing={allocated:true};sends++;}});
 await waker.tick();assert.equal(sends,0);assert.equal(f.board.continuations(f.a).items[0].state,'ready_to_deliver');
 f.engine.store.save=original;allowed=true;await waker.tick();assert.equal(sends,1);
 assert.equal(f.engine.store.data.discussions.flatMap(g=>g.messages).length,1);
});
test('dispatch fence checks current step but completed native replies may still be recorded',async t=>{
 const f=await fixture(t);await f.update();let sent;
 const waker=new ContinuationWaker(f.engine,{inspect:async()=>({state:'idle'}),route:async(g,m)=>{m.routing={allocated:true};sent={group:g,message:m};}});
 await waker.tick();const hub=new CodexDiscussionHub(f.engine,{adapterFactory:()=>{throw Error('No native');}});t.after(()=>hub.close());
 assert.doesNotThrow(()=>hub.validateContinuation('a',sent.group.id,sent.message.id));
 await f.update({...f.continuation,state:'gate_ready'});
 assert.throws(()=>hub.validateContinuation('a',sent.group.id,sent.message.id),/no longer authorized/);
 assert.doesNotThrow(()=>hub.validate('a',sent.group.id,sent.message.id));
});
