import {createHash} from 'node:crypto';
import {cbor,spaceIdLocal} from '@agentspaces/client';
import {TYPES} from './fabric.mjs';
import {approvalCheck,text} from './coordination-records.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const stepKinds=['analysis','implementation','tests','documentation','push','merge','deploy','devices','provisioning','other'];
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&!Object.keys(value).some(key=>!keys.includes(key));
export function standingScope(b,scope,binding){
 const value=scope.standing;
 if(!exact(value,['workEntryId','workHash','alwaysAsk','maxWakes']))throw Error('Invalid standing approval scope');
 text(value.workEntryId,100,'standing work item');
 if(!/^[a-f0-9]{64}$/.test(value.workHash??''))throw Error('Exact standing brief hash required');
 if(!Array.isArray(value.alwaysAsk)||!value.alwaysAsk.length||value.alwaysAsk.length>stepKinds.length||new Set(value.alwaysAsk).size!==value.alwaysAsk.length||value.alwaysAsk.some(k=>!stepKinds.includes(k)))throw Error('Explicit standing always-ask action kinds required');
 if(!Number.isInteger(value.maxWakes)||value.maxWakes<1||value.maxWakes>20)throw Error('Standing wake budget must be 1–20');
 const state=b.peer.states.get(value.workEntryId),r=state?.record;
 if(!r||r.type!==TYPES.request||r.spaceId!==spaceIdLocal(`${b.group}/desktop-work-board`)||state.completed||Number(state.leaseValue?.expiresAtMillis??r.lease.expiresAtMillis)<=b.engine.clock())throw Error('Standing brief must be an open work item');
 const work=cbor.loads(Buffer.from(r.payload)),digest=createHash('sha256').update(Buffer.from(r.payload)).digest('hex');
 if(digest!==value.workHash||work.repository!==scope.repo.trim().replace(/\/+$/,''))throw Error('Standing brief hash or repository mismatch');
 b.peer.requireHeld('desktop-work-board',value.workEntryId,b.agent(binding.sessionId));
 return {...value,alwaysAsk:[...value.alwaysAsk]};
}
export function progressContinuation(b,input,binding){
 const value=input.continuation;
 if(!exact(value,['state','stepId','summary','kind','decisionId','requestHash','receiptId'])||!['pending','blocked','gate_ready'].includes(value.state)||!stepKinds.includes(value.kind))throw Error('Invalid continuation step');
 if(input.status==='blocked'&&value.state==='pending')throw Error('Blocked progress cannot request a pending wake');
 if(input.action==='complete'&&value.state!=='gate_ready')throw Error('Completed continuation must be gate_ready');
 text(value.stepId,100,'continuation step ID');text(value.summary,2000,'continuation summary');
 const check=approvalCheck(b,binding,{entryId:value.decisionId,requestHash:value.requestHash,receiptId:value.receiptId},{refresh:false});
 if(!check.scope.standing||check.scope.standing.workEntryId!==input.entryId)throw Error('Continuation requires an exact standing brief grant');
 if(input.branch!==check.scope.branch)throw Error('Continuation branch differs from approval');
 // Step identity is immutable across progress retries; a new operation needs a new step ID.
 for(const state of b.peer.states.values())if(state.record?.type===TYPES.result){
  const previous=cbor.loads(Buffer.from(state.record.payload)),step=previous.continuation;
  if(previous.requestEntryId===input.entryId&&step?.stepId===value.stepId&&step.decisionId===value.decisionId&&step.receiptId===value.receiptId&&(step.summary!==value.summary||step.kind!==value.kind))throw Error('Continuation step ID reused with different work');
 }
 return {...value};
}
const prefix=step=>'continue-'+hash([step.decisionId,step.receiptId]).slice(0,24)+'-';
const deliveryId=(item,step)=>prefix(step)+hash([item.entryId,step.stepId]).slice(0,40);
const allMessages=engine=>(engine.store.data.discussions??[]).flatMap(group=>group.messages??[]);
export function continuationView(b,binding,options={}){
 const board=b.view(binding,options),messages=allMessages(b.engine);
 const items=[];
 for(const item of board.items){
  const latest=item.results.at(-1)?.value,step=latest?.continuation;if(!step)continue;
  const id=deliveryId(item,step),existing=messages.find(message=>message.deliveryId===id);
  let state=step.state,reason=null,grant=null;
  if(item.status!=='claimed')state='claim_inactive';
  else if(latest.status==='blocked')state='blocked';
  else if(step.state==='pending'){
   try {
    b.access({sessionId:latest.actor});b.peer.requireHeld('desktop-work-board',item.entryId,b.agent(latest.actor));
    grant=approvalCheck(b,{sessionId:latest.actor},{entryId:step.decisionId,requestHash:step.requestHash,receiptId:step.receiptId},{refresh:false});
    if(!grant.authorization.valid)state='approval_'+grant.status;
    else if(!grant.scope.standing||grant.scope.standing.workEntryId!==item.entryId||grant.scope.standing.workHash!==item.hash||grant.scope.repo.replace(/\/+$/,'')!==item.value.repository||latest.branch!==grant.scope.branch)state='scope_changed';
    else if((b.engine.session(latest.actor).cwd??b.engine.target(b.engine.session(latest.actor)).path)!==grant.scope.folder)state='scope_changed';
    else if(grant.scope.standing.alwaysAsk.includes(step.kind)||step.kind==='other')state='waiting_on_owner';
    else if(!grant.wakeEnabled)state='wake_disabled';
    else if(existing)state=existing.routing||existing.targets?.some(t=>t.routingAttempted)?'wake_recorded':'ready_to_deliver';
    else if(messages.filter(m=>m.deliveryId?.startsWith(prefix(step))).length>=grant.scope.standing.maxWakes)state='wake_budget_exhausted';
    else state='ready';
   }catch{state='source_or_claim_unavailable';}
  }
  const target=existing?.targets?.find(t=>t.sessionId===latest.actor);
  items.push({workEntryId:item.entryId,workHash:item.hash,resultEntryId:item.results.at(-1).entryId,sessionId:latest.actor,step,state,reason,deliveryId:id,nativeDelivery:target?.status??null,grant:grant?{expiresAt:grant.expiresAt,requiredLimits:grant.requiredLimits,alwaysAsk:grant.scope.standing?.alwaysAsk,maxWakes:grant.scope.standing?.maxWakes}:null});
 }
 return {items,observedAt:board.observedAt,coverage:board.coverage,nativeAuthority:'owner-delegation-required'};
}
export class ContinuationWaker {
 constructor(engine,{inspect,route,dispatchAllowed=()=>true,intervalMs=30000}={}){Object.assign(this,{engine,inspect,route,dispatchAllowed,intervalMs});this.running=false;this.closed=false;this.observations=new Map();this.cursor=0;}
 start(){if(!this.timer){this.timer=setInterval(()=>{void this.tick().catch(()=>{});},this.intervalMs);this.timer.unref?.();}return this;}
 close(){this.closed=true;clearInterval(this.timer);this.timer=null;}
 view(binding,options={}){const view=this.engine.workBoard.continuations(binding,options);return {...view,items:view.items.map(item=>({...item,nativeObservation:this.observations.get(item.sessionId)??{state:'unknown',reason:'No native idle observation yet'}}))};}
 async tick(){
  if(this.running||this.closed||!this.dispatchAllowed())return;
  this.running=true;
  try{
   const ready=this.engine.workBoard.continuations(null,{limit:200}).items.filter(item=>['ready','ready_to_deliver'].includes(item.state));
   const candidates=Array.from({length:Math.min(4,ready.length)},(_,i)=>ready[(this.cursor+i)%ready.length]);this.cursor=ready.length?(this.cursor+candidates.length)%ready.length:0;
   for(const candidate of candidates){
    if(this.closed||!this.dispatchAllowed())break;
    let observed;try{observed=await this.inspect(candidate.sessionId);}catch{observed={state:'unknown',reason:'Native lifecycle observation unavailable'};}this.observations.set(candidate.sessionId,{...observed,observedAt:this.engine.clock()});
    if(observed.state!=='idle')continue;
    const current=this.engine.workBoard.continuations(null,{limit:200}).items.find(item=>item.deliveryId===candidate.deliveryId&&item.resultEntryId===candidate.resultEntryId);
    if(!['ready','ready_to_deliver'].includes(current?.state)||this.closed||!this.dispatchAllowed())continue;
    const source=this.engine.session(current.sessionId);
    const grant=this.engine.permissions(source);if(!grant.enrolled||!grant.retrieve||!grant.share||!grant.content)continue;
    const roomKey='continuation-room-'+hash(current.sessionId);
    let group=(this.engine.store.data.discussions??[]).find(g=>g.creation?.sessionId==='desktop-owner'&&g.creation?.deliveryId===roomKey);
    if(!group){const created=this.engine.discussions.create({title:'Brief continuation',sessionIds:[current.sessionId],agentInitiation:false,selfRegistration:false},{sessionId:'desktop-owner',deliveryId:roomKey});group=this.engine.discussions.group(created.id);}
    if(group.members.length!==1||group.members[0].sessionId!==current.sessionId)continue;
    const lookup={entryId:current.step.decisionId,requestHash:current.step.requestHash,receiptId:current.step.receiptId};
    const messageText=`A pending step in your owner-approved standing brief is ready. Work item: ${current.workEntryId}; exact brief hash: ${current.workHash}; step: ${current.step.stepId} (${current.step.kind}). ${current.step.summary}\nCall verify_owner_approval with ${JSON.stringify(lookup)} and read the current work item before continuing. Continue within this exact brief, scope and all limits until gate_ready, blocked, grant expiry/revocation or an always-ask action. Native owner delegation and client permissions remain authoritative. This wake is not new approval. Update the board with the next explicit step or gate result. Never resume a paused queue, interrupt or cancel another turn. Do not broadcast an acknowledgement.`;
    this.engine.discussions.post({id:group.id,text:messageText,targets:[current.sessionId],deliveryId:current.deliveryId},{exactTargets:true});
    const message=group.messages.find(m=>m.deliveryId===current.deliveryId);
    // The durable message is the allocation. A crash or uncertain route never creates a second wake.
    message.continuation??={workEntryId:current.workEntryId,resultEntryId:current.resultEntryId,deliveryId:current.deliveryId};this.engine.store.save();
    if(!this.closed&&this.dispatchAllowed())await this.route(group,message);
   }
  }finally{this.running=false;}
 }
}
