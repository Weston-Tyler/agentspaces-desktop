import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Engine} from '../app/engine.mjs';import {Store} from '../app/store.mjs';import {FabricAdapter} from '../app/fabric.mjs';
import {routeConversation,messageDelivery} from '../app/conversation-routing.mjs';
test('an alias blocked by ancestry limits gets an actionable receipt; a fresh opening routes once',async t=>{
 const root=mkdtempSync(join(tmpdir(),'as-routing-receipt-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const engine=new Engine(new Store(root),new FabricAdapter({stateRoot:root}));engine.loadSample();
 const sender=engine.session('sample-claude-new'),peer=engine.session('sample-codex-old');for(const s of [sender,peer])engine.grant(s.id,{enrolled:true,content:true,retrieve:true,share:true});
 const id=engine.discussions.create({title:'Synthetic routing receipt',sessionIds:[sender.id,peer.id]}).id;engine.discussions.setPolicy({id,agentInitiation:true});const group=engine.discussions.group(id);let calls=0;
 const transport={codexAgents:{dispatch(){throw Error('No models');}},channels:{isConnected:()=>true,async deliver(){calls++;return {status:'delivered-to-native-transport'};}}};
 const post=(text,replyTo,suffix)=>{engine.discussions.contribute({id,text,replyTo,nativeTurnId:'synthetic',deliveryId:'routing-receipt-'+suffix},{sessionId:sender.id});return group.messages.at(-1);};
 let old=post('An earlier topic',null,'root');for(let i=1;i<=9;i++)old=post(i===9?'@codex1 Please read this':'Earlier continuation',old.id,'hop-'+i);
 await routeConversation(engine,transport,group,old);const receipt=messageDelivery(old);assert.equal(receipt.notificationStatus,'routing-limited');assert.equal(receipt.routingStatus,'forward-hop-limit-reached');assert.match(receipt.warning,/opening post without replyTo/);assert.equal(calls,0);
 const fresh=post('@codex1 New opening',null,'fresh');await routeConversation(engine,transport,group,fresh);assert.equal(fresh.targets[0].sessionId,peer.id);assert.equal(messageDelivery(fresh).selectedRecipients,1);assert.equal(calls,1);
 await routeConversation(engine,transport,group,old);await routeConversation(engine,transport,group,fresh);assert.equal(calls,1);assert.equal(engine.modelCalls,0);
});

test('room defaults to side, unsupported Claude stays pending, and a one-message main override works',async t=>{
 const root=mkdtempSync(join(tmpdir(),'as-routing-side-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const engine=new Engine(new Store(root),new FabricAdapter({stateRoot:root}));engine.loadSample();
 const sender=engine.session('sample-codex-old'),peer=engine.session('sample-claude-new');peer.fixture=false;
 for(const s of [sender,peer])engine.grant(s.id,{enrolled:true,content:true,retrieve:true,share:true});
 const id=engine.discussions.create({title:'Side routing fixture',sessionIds:[sender.id,peer.id],agentInitiation:true}).id;const group=engine.discussions.group(id);let nativeMainCalls=0;
 const transport={codexAgents:{},channels:{isConnected:()=>true,async deliver(){nativeMainCalls++;return {status:'delivered-to-native-transport'};}}};
 const post=(deliveryId,destination)=>{engine.discussions.post({id,text:'What was verified?',targets:[peer.id],deliveryId,destination});return group.messages.at(-1);};
 const pending=post('side-route-default');await routeConversation(engine,transport,group,pending);
 assert.equal(engine.discussions.policy(group).destination,'side');
 assert.equal(pending.targets[0].status,'side-chat-unavailable');
 assert.equal(messageDelivery(pending).notificationStatus,'side-chat-pending');
 assert.equal(messageDelivery(pending).targets[0].reasonCode,'native_side_provider_unavailable');
 assert.equal(nativeMainCalls,0);
 const explicit=post('side-route-main','main');await routeConversation(engine,transport,group,explicit);
 assert.equal(nativeMainCalls,1);
 assert.equal(engine.discussions.policy(group).destination,'side');
 engine.discussions.setPolicy({id,destination:'main'});
 await routeConversation(engine,transport,group,pending);
 assert.equal(nativeMainCalls,1,'no replay on changing the room preference');
 await routeConversation(engine,transport,group,post('main-room-default'));
 assert.equal(nativeMainCalls,2);
});
