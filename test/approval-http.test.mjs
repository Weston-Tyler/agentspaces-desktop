import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../app/store.mjs';
import {Engine} from '../app/engine.mjs';
import {startServer} from '../app/server.mjs';
import {notifyApproval} from '../app/approval-notification.mjs';
test('HTTP owner approval requires separate password; public cookie and participant token cannot issue authority',async t=>{
 const root=mkdtempSync(join(tmpdir(),'as-approval-')),store=new Store(root);
 const engine=new Engine(store,{diagnostics:()=>({}),close(){}},{nativeFactory:()=>{throw Error('No native calls');}});
 engine.workspace.index={profile:{id:'scope',account:'synthetic',active:true,policy:'local-retrieval'}};
 engine.discussions.participant=b=>({id:b.sessionId,scopeId:'scope',account:'synthetic',fixture:true});
 engine.connector=token=>{if(token!=='participant')throw Error('denied');return {sessionId:'a'};};
 const app=await startServer({root,port:0,engine});t.after(async()=>{await app.close();rmSync(root,{recursive:true,force:true});});
 const cookie=(await fetch(app.address)).headers.get('set-cookie').split(';')[0];
 const headers={Cookie:cookie,'x-agentspaces':'local-companion','Content-Type':'application/json'};
 const admin={Authorization:`Bearer ${app.admin}`,'Content-Type':'application/json'},agent={Authorization:'Bearer participant','Content-Type':'application/json'};
 const post=async(path,data,h=headers)=>{const r=await fetch(app.address+'/api/'+path,{method:'POST',headers:h,body:JSON.stringify(data)});return {status:r.status,value:await r.json()};};
 const password='synthetic HTTP owner password for tests';
 assert.notEqual((await post('approvals/configure',{password})).status,200);
 assert.equal((await post('approvals/configure',{password},admin)).status,200);
 const created=await post('decisions/change',{action:'decision_create',deliveryId:'http-request-001',title:'Tests',question:'Run tests?',options:[{id:'yes',label:'Yes'},{id:'no',label:'No'}],recommendation:'yes',approval:{repo:'synthetic',branch:'test',folder:'/fixture',action:'Run tests',limits:['No push']}},agent);
 assert.equal(created.status,200);
 const row=(await post('decisions/list',{entryId:created.value.entryId},agent)).value.items[0];
 const decision={action:'decision_approve',deliveryId:'http-answer-001',entryId:row.entryId,requestHash:row.hash,outcome:'approve',limits:[],rationale:'Proceed',expiresAt:Date.now()+60000};
 assert.notEqual((await post('decisions/change',decision)).status,200);
 assert.notEqual((await post('approvals/answer',{password,decision},agent)).status,200);
 assert.notEqual((await post('approvals/answer',{password:'wrong',decision})).status,200);
 const accepted=await post('approvals/answer',{password,decision});assert.equal(accepted.status,200);assert.equal(accepted.value.notification.status,'not_delivered');
 assert.equal((await post('decisions/list',{entryId:row.entryId},agent)).value.items[0].authorization.valid,true);
 assert.equal((await post('approvals/answer',{password,decision})).value.duplicate,true);
 assert.ok(!readFileSync(store.path,'utf8').includes(password));
});
test('approval notification selects only its bound source and retries reuse the same message',async()=>{
 const row={entryId:'request',hash:'a'.repeat(64),value:{approval:{targetSessionId:'source'}},answer:{value:{verification:{method:'owner-password'}}}};
 const groups=[],engine={store:{data:{discussions:groups}},workBoard:{decisions:()=>({items:[row]})},discussions:{
  participant:()=>({id:'source',fixture:false}),
  create:(input,creation)=>{const g={id:'room',members:input.sessionIds.map(sessionId=>({sessionId})),messages:[],creation};groups.push(g);return g;},
  group:id=>groups.find(g=>g.id===id),
  post:input=>{if(!groups[0].messages.some(m=>m.deliveryId===input.deliveryId))groups[0].messages.push({...input,id:'message',targets:input.targets.map(sessionId=>({sessionId}))});}
 }};
 let wakes=0;const route=async(g,m)=>{if(!m.routed){m.routed=true;wakes++;}};
 for(let i=0;i<2;i++)await notifyApproval(engine,{entryId:'request',resultEntryId:'receipt'},route);
 assert.equal(groups.length,1);assert.equal(groups[0].messages.length,1);assert.equal(wakes,1);
 assert.deepEqual(groups[0].messages[0].targets,[{sessionId:'source'}]);assert.match(groups[0].messages[0].text,/not authority/);
 groups[0].members.push({sessionId:'other'});await assert.rejects(notifyApproval(engine,{entryId:'request',resultEntryId:'receipt'},route),/membership/);
});
