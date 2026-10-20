import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Engine} from '../app/engine.mjs';
import {Store} from '../app/store.mjs';
import {FabricAdapter} from '../app/fabric.mjs';
import {startServer} from '../app/server.mjs';

test('real HTTP contribution settles the addressed steer without capturing or duplicating the active owner answer',async t=>{
 const root=mkdtempSync(join(tmpdir(),'as-steered-http-'));let app;
 t.after(async()=>{await app?.close();rmSync(root,{recursive:true,force:true});});
 const engine=new Engine(new Store(root),new FabricAdapter({stateRoot:root}));engine.loadSample();engine.mode='workspace-connected';
 const source=engine.session('sample-codex-old');Object.assign(source,{fixture:false,nativeThreadId:'11111111-2222-4333-8444-555555555555',host:'remote',cwd:'/tmp/agentspaces-steered-http'});
 engine.store.data.projects[source.project].fixture=false;engine.store.data.projects[source.project].targets={'remote:codex':{path:source.cwd,host:'remote',provider:'codex'}};
 for(const id of [source.id,'sample-claude-new'])engine.grant(id,{enrolled:true,content:true,share:true,retrieve:true});engine.store.data.desktopPreferences={allowNativeFullAccess:true};
 let fake,steerCount=0;
 app=await startServer({root,port:0,engine,codexAdapterFactory:options=>fake={events:new EventEmitter(),open:async()=>{},close(){},bindLoadedThread:async()=>({nativeThreadId:source.nativeThreadId}),steer:async args=>{steerCount++;await options.persistReceipt({clientId:args.clientId,nativeThreadId:args.threadId,nativeTurnId:'active-owner-turn',deliveryMode:'steer',status:'steered',expectExplicitReply:true});return {supported:true,nativeTurnId:'active-owner-turn'};},answer:async()=>{throw Error('No new conversation turn or model call allowed');}}});
 const group=engine.discussions.create({title:'Synthetic steering',sessionIds:[source.id,'sample-claude-new']});
 const call=async(path,body,token=app.admin)=>{const r=await fetch(app.address+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 const posted=await call('/api/discussions/post',{id:group.id,text:'Review the synthetic regression evidence',targets:[source.id],deliveryId:'http-steered-message-001'});assert.equal(posted.status,200);
 const message=posted.body.messages[0],requestId=message.targets[0].requestId;assert.equal((await app.codexAgents.wait(requestId)).status,'steered-awaiting-reply');assert.equal(steerCount,1);
 fake.events.emit('notification',{method:'turn/completed',params:{threadId:source.nativeThreadId,turn:{id:'active-owner-turn',status:'completed',items:[{type:'agentMessage',text:'Owner-private task summary'}]}}});assert.equal(engine.discussions.group(group.id).messages.length,1);
 const token=engine.issueConnector(source.id).token,reply={id:group.id,text:'Exact regression reply',nativeTurnId:'unreported',deliveryId:'http-steered-reply-001',replyTo:message.id};
 assert.equal((await call('/api/discussions/contribute',reply,token)).status,200);assert.equal(engine.store.data.codexDiscussionDeliveries[requestId].status,'native-participant-contributed');
 assert.equal((await call('/api/discussions/contribute',reply,token)).status,200);assert.equal(engine.discussions.group(group.id).messages.length,2);assert.equal(steerCount,1);assert.equal(engine.modelCalls,0);
});
