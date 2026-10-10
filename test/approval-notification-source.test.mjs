import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Engine} from '../app/engine.mjs';
import {Store} from '../app/store.mjs';
import {OwnerApprovalAuth} from '../app/owner-approval-auth.mjs';
import {notifyApproval} from '../app/approval-notification.mjs';
async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'as-real-approval-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const engine=new Engine(new Store(root),{diagnostics:()=>({}),close(){}},{nativeFactory:()=>{throw Error('No native calls');}});
 const profile={id:'fictional-scope',account:'fictional-owner',active:true,policy:'local-retrieval',hosts:['local'],providers:['codex'],roots:{},exclusions:{},indexFiles:false};
 engine.workspace.index={schema:1,fixture:false,profile,nodes:[],edges:[],sessions:[],coverage:[],errors:[],observedAt:new Date().toISOString()};
 const nativeThreadId='00000000-0000-4000-8000-000000000001',source={id:'codex@local:'+nativeThreadId,nativeThreadId,provider:'codex',host:'local',cwd:'/fictional/project',project:'fictional-project',account:profile.account,scopeId:profile.id,title:'Fictional review agent',fixture:false};
 engine.workspace.restore([source]);engine.workspace.index.sessions=[source];engine.workspace.save();engine.store.save();
 const binding=engine.connector(engine.issueConnector(source.id).token),password='synthetic source-bound approval password',auth=new OwnerApprovalAuth(engine.store,{clock:engine.clock});await auth.configure(password);
 const request=await engine.workBoard.mutate({action:'decision_create',deliveryId:'fictional-request',title:'Run checks',question:'Run the scoped checks?',options:[{id:'yes',label:'Yes'},{id:'no',label:'No'}],recommendation:'yes',approval:{repo:'https://example.test/repo',branch:'feat/fixture',folder:'/fictional/project',action:'Run checks',limits:['No push']}},binding);
 const row=engine.workBoard.decisions(binding).items[0],answer={action:'decision_approve',entryId:request.entryId,requestHash:row.hash,outcome:'approve',limits:[],expiresAt:engine.clock()+60000,rationale:'Synthetic confirmation',deliveryId:'fictional-answer'};
 const result=await engine.workBoard.mutate(answer,null,await auth.verify(password,answer));
 return{engine,source,binding,result};
}
test('real scoped approval target gets one notification without minting a connector or weakening participant checks',async t=>{
 const f=await fixture(t),tokens=Object.keys(f.engine.store.data.connectors),delivered=[];
 for(let i=0;i<2;i++)await notifyApproval(f.engine,f.result,async(group,message)=>{delivered.push({group,message});});
 assert.equal(f.engine.store.data.discussions.length,1);assert.equal(delivered[0].message.id,delivered[1].message.id);assert.deepEqual(delivered[0].message.targets.map(x=>x.sessionId),[f.source.id]);assert.deepEqual(Object.keys(f.engine.store.data.connectors),tokens);assert.equal(f.engine.modelCalls,0);
});
test('revoked sharing and changed scope or account reject before notification routing',async t=>{
 for(const mutation of ['share','account','scopeId']){
  const f=await fixture(t);if(mutation==='share')f.engine.grant(f.source.id,{share:false});else f.engine.session(f.source.id)[mutation]='changed-boundary';
  let routed=false;await assert.rejects(notifyApproval(f.engine,f.result,async()=>{routed=true;}));assert.equal(routed,false);assert.equal(f.engine.store.data.discussions.length,0);
 }
});
test('an existing approval room refuses a changed source project boundary',async t=>{
 const f=await fixture(t);await notifyApproval(f.engine,f.result,async()=>{});f.engine.session(f.source.id).project='changed-project';let routed=false;
 await assert.rejects(notifyApproval(f.engine,f.result,async()=>{routed=true;}));assert.equal(routed,false);
});
