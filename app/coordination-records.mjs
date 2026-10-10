import {standingScope} from './work-continuation.mjs';
import { consumeOwnerProof } from './owner-approval-auth.mjs';
import { cbor, spaceIdLocal } from '@agentspaces/client';
import { createHash } from 'node:crypto';
export const COORD = Object.freeze({decision:'agentspaces.desktop.Decision#v1',answer:'agentspaces.desktop.DecisionAnswer#v1',revocation:'agentspaces.desktop.DecisionRevocation#v1',verification:'agentspaces.desktop.DecisionVerification#v1',machine:'agentspaces.desktop.Machine#v1',reservation:'agentspaces.desktop.MachineReservation#v1',receipt:'agentspaces.desktop.MachineReceipt#v1'});
export const COORD_SPACE = 'desktop-coordination', TTL = 30 * 86400000;
export const text = (v,n,name) => { if(typeof v !== 'string'||!v.trim()||v.length>n) throw Error(`Invalid ${name}`);return v.trim(); };
export function records(board,type) {
 const space=spaceIdLocal(`${board.group}/${COORD_SPACE}`),rows=[];
 for(const [entryId,state] of board.peer.states) {
  const r=state.record;if(r?.type!==type||r.spaceId!==space)continue;
  const bytes=Buffer.from(r.payload),value=cbor.loads(bytes);
  rows.push({entryId,value,issuer:r.issuer,hash:createHash('sha256').update(bytes).digest('hex'),completed:!!state.completed,expiresAt:Number(state.leaseValue?.expiresAtMillis??r.lease.expiresAtMillis)});
 }
 return rows;
}
export function find(board,type,id) {const r=records(board,type).find(x=>x.entryId===id);if(!r)throw Error('Unknown coordination record');return r;}
export const write = (b,type,value,agent) => b.peer.writeEntry(COORD_SPACE,type,value,'owner',TTL,agent);
export async function finish(b,entryId,agent) {
 const held=await b.peer.takeEntry(COORD_SPACE,b.peer.states.get(entryId).record.type,'worker',60000,0,700,agent,entryId);
 if(held!==entryId)throw Error('Record already claimed or unavailable');
 b.peer.completeEntry(COORD_SPACE,entryId,agent);
}
export function decisionView(b,binding,options={}) {
 if(Object.keys(options).some(k=>!['limit','entryId'].includes(k)))throw Error('Unknown decision list field');
 const {limit=100,entryId}=options;
 if(entryId!==undefined&&(typeof entryId!=='string'||entryId.length>100||!entryId))throw Error('Invalid decision entryId');
 if(!Number.isInteger(limit)||limit<1||limit>200)throw Error('Invalid limit');
 b.access(binding);if(b.writing)throw Error('Work board is saving; refresh shortly');b.peer=null;b.open();b.access(binding);
 const answers=records(b,COORD.answer),now=b.engine.clock();
 const revoked=records(b,COORD.revocation),checks=records(b,COORD.verification);
 const all=records(b,COORD.decision).filter(r=>entryId===undefined||r.entryId===entryId).map(r=>{
  const answer=answers.find(a=>a.value.decisionId===r.entryId),revocation=revoked.find(a=>a.value.decisionId===r.entryId);
  let approvalDelivery=null,authorization=null;
  if(r.value.approval) {
   const value=answer?.value;
   const matches=value?.requestHash===r.hash&&value?.targetSessionId===r.value.approval.targetSessionId&&value?.verification?.method==='owner-password'&&Number.isSafeInteger(value?.verification?.verifiedAt)&&Number.isSafeInteger(value?.expiresAt)&&['approve','approve_with_limits','decline'].includes(value?.outcome);
   approvalDelivery=revocation?'revoked':!value?.verification?'awaiting_owner_approval':!matches?'invalid_receipt':value.outcome==='decline'?'declined':value.expiresAt<=now||r.expiresAt<=now?'expired':value.verification.credentialId!==b.engine.store.data.ownerApprovalCredential?.id?'credential_changed':'available_for_target_verification';
   authorization={valid:approvalDelivery==='available_for_target_verification'&&binding?.sessionId===r.value.approval.targetSessionId,requestHash:r.hash,targetSessionId:r.value.approval.targetSessionId,nativePolicy:'Native instructions must explicitly trust AgentSpaces owner approvals; tool permission prompts remain native'};
  }
  return {...r,status:r.completed?(answer?.value.status??'closed'):r.expiresAt<=now?'expired':'open',answer:answer??null,revocation:revocation??null,notification:approvalNotificationState(b,r,revocation??answer),targetVerification:checks.filter(c=>c.value.decisionId===r.entryId).sort((a,b)=>b.value.checkedAt-a.value.checkedAt)[0]??null,canAnswer:!binding&&!r.value.approval,approvalDelivery,authorization};
 })
 .sort((a,b)=>(a.status==='open'?0:1)-(b.status==='open'?0:1)||a.value.createdAt-b.value.createdAt||a.entryId.localeCompare(b.entryId));
 return {items:all.slice(0,limit),total:all.length,truncated:all.length>limit,canAnswer:!binding,authority:'Owner-recorded coordination decisions; native approvals remain authoritative'};
}
// Project adapter-owned delivery state; saving an answer is not native delivery.
function approvalNotificationState(b,row,receipt) {
 if(!row.value.approval||!receipt?.value.verification)return null;
 const target=row.value.approval.targetSessionId;
 const roomKey='approval-room-'+createHash('sha256').update(target).digest('hex');
 const group=b.engine.store.data.discussions?.find(g=>g.creation?.sessionId==='desktop-owner'&&g.creation?.deliveryId===roomKey);
 const deliveryId='approval-'+createHash('sha256').update(receipt.entryId).digest('hex');
 const message=group?.messages.find(m=>m.deliveryId===deliveryId);
 const delivery=message?.targets?.find(t=>t.sessionId===target);
 const native=delivery?.requestId&&(b.engine.store.data.codexDiscussionDeliveries?.[delivery.requestId]??b.engine.store.data.channelReceipts?.[delivery.requestId]);
 return {receiptId:receipt.entryId,discussionId:group?.id??null,messageId:message?.id??null,status:native?.status??delivery?.status??'not_delivered',nativeAuthority:'owner-delegation-required'};
}
// Exact source-bound read; never treat a cached verification result as current authority.
export function approvalCheck(b,binding,input,{refresh=true}={}) {
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['entryId','requestHash','receiptId'].includes(k)))throw Error('Invalid approval verification fields');
 if(typeof input.entryId!=='string'||!input.entryId||input.entryId.length>100||typeof input.receiptId!=='string'||!input.receiptId||input.receiptId.length>100)throw Error('Exact request and receipt IDs required');
 if(!/^[a-f0-9]{64}$/.test(input.requestHash??''))throw Error('Exact request hash required');
 let row;
 if(refresh)row=decisionView(b,binding,{entryId:input.entryId}).items[0];
 else {
  const request=find(b,COORD.decision,input.entryId),answer=records(b,COORD.answer).find(r=>r.value.decisionId===input.entryId),revocation=records(b,COORD.revocation).find(r=>r.value.decisionId===input.entryId);
  row={...request,answer,revocation};
 }
 if(!row?.value.approval||!binding?.sessionId||binding.sessionId!==row.value.approval.targetSessionId)throw Error('Approval verification requires the exact target source');
 if(row.hash!==input.requestHash)throw Error('Approval request hash mismatch');
 const receipt=[row.answer,row.revocation].find(r=>r?.entryId===input.receiptId);
 if(!receipt?.value.verification||receipt.value.requestHash!==row.hash)throw Error('Approval receipt mismatch');
 const answer=row.answer?.value,now=b.engine.clock();
 const intact=answer?.requestHash===row.hash&&answer?.targetSessionId===binding.sessionId&&answer?.verification?.method==='owner-password'&&Number.isSafeInteger(answer?.verification?.verifiedAt)&&Number.isSafeInteger(answer?.expiresAt)&&['approve','approve_with_limits','decline'].includes(answer?.outcome);
 const status=row.revocation?'revoked':!intact?'invalid_receipt':answer.outcome==='decline'?'declined':answer.expiresAt<=now||row.expiresAt<=now?'expired':answer.verification.credentialId!==b.engine.store.data.ownerApprovalCredential?.id?'credential_changed':'verified';
 return {entryId:row.entryId,requestHash:row.hash,receiptId:receipt.entryId,status,observedAt:now,scope:row.value.approval,requiredLimits:[...row.value.approval.limits,...(answer?.limits??[])],outcome:answer?.outcome,wakeEnabled:answer?.wakeEnabled===true,expiresAt:answer?.expiresAt,ownerVerification:receipt.value.verification,revocation:row.revocation??null,authorization:{valid:status==='verified',targetSessionId:binding.sessionId},nativeAuthority:'owner-delegation-required',nativePolicy:'Native owner instructions must permit reliance on this source-bound receipt. Native tool permissions remain authoritative. Recheck immediately before acting; only an explicit standing scope grants brief continuation; no additional permissions are implied.'};
}
export const decisionFields={decision_verify:['entryId','requestHash','receiptId'],decision_create:['title','question','options','recommendation','blockedWork','approval'],decision_answer:['entryId','optionId','rationale'],decision_approve:['entryId','requestHash','outcome','limits','rationale','expiresAt','wakeEnabled'],decision_revoke:['entryId','rationale'],decision_withdraw:['entryId','rationale']};
export async function decisionChange(b,input,binding,actor,agent,ownerProof) {
 const now=b.engine.clock();
 if(input.action==='decision_create') {
  const {options,blockedWork=[]}=input;
  let approval;
  if(Object.hasOwn(input,'approval')) {
   const scope=input.approval;
   if(!scope||typeof scope!=='object'||Array.isArray(scope)||Object.keys(scope).some(k=>!['repo','branch','folder','action','limits','standing'].includes(k)))throw Error('Invalid approval scope');
   if(!binding?.sessionId)throw Error('Approval requests require a source-bound participant');
   if(!Array.isArray(scope.limits)||scope.limits.length<1||scope.limits.length>20)throw Error('Approval limits required');
   approval={repo:text(scope.repo,2000,'approval repository'),branch:text(scope.branch,300,'approval branch'),folder:text(scope.folder,2000,'approval folder'),action:text(scope.action,8000,'approval action'),limits:scope.limits.map(v=>text(v,2000,'approval limit')),targetSessionId:binding.sessionId,...(scope.standing!==undefined?{standing:standingScope(b,scope,binding)}:{})};
  }
  if(!Array.isArray(options)||options.length<2||options.length>8)throw Error('Provide 2–8 options');
  const choices=options.map(o=>({id:text(o.id,80,'option id'),label:text(o.label,2000,'option label')}));
  if(new Set(choices.map(o=>o.id)).size!==choices.length||!choices.some(o=>o.id===input.recommendation))throw Error('Unique options and matching recommendation required');
  if(!Array.isArray(blockedWork)||blockedWork.length>20||blockedWork.some(id=>typeof id!=='string'||!b.peer.states.has(id)||b.peer.states.get(id).record.type!=='agentspaces.desktop.FollowUpRequest#v1'))throw Error('Unknown blocked work item');
  return {entryId:write(b,COORD.decision,{title:text(input.title,200,'title'),question:text(input.question,12000,'question'),options:choices,recommendation:input.recommendation,blockedWork:[...new Set(blockedWork)],createdBy:actor,createdAt:now,...(approval?{approval}:{})},agent),status:'open'};
 }
 if(input.action==='decision_verify') {
  const check=approvalCheck(b,binding,{entryId:input.entryId,requestHash:input.requestHash,receiptId:input.receiptId},{refresh:false});
  const verificationEntryId=write(b,COORD.verification,{decisionId:check.entryId,requestHash:check.requestHash,receiptId:check.receiptId,targetSessionId:binding.sessionId,checkedAt:now,status:check.status},agent);
  return {verificationEntryId};
 }
 const row=find(b,COORD.decision,input.entryId);
 if(['decision_approve','decision_revoke'].includes(input.action)) {
  if(binding)throw Error('Only the owner can issue or revoke approval');
  const verification=consumeOwnerProof(ownerProof,input,now);
  if(verification.credentialId!==b.engine.store.data.ownerApprovalCredential?.id)throw Error('Owner credential changed');
  if(!row.value.approval)throw Error('A scoped approval request is required');
  if(input.action==='decision_revoke') {
   if(!records(b,COORD.answer).some(r=>r.value.decisionId===row.entryId&&r.value.verification))throw Error('No verified approval to revoke');
   if(records(b,COORD.revocation).some(r=>r.value.decisionId===row.entryId))throw Error('Approval already revoked');
   const resultEntryId=write(b,COORD.revocation,{decisionId:row.entryId,requestHash:row.hash,rationale:text(input.rationale,8000,'rationale'),verification,actor,at:now},agent);
   return {entryId:row.entryId,resultEntryId,status:'revoked'};
  }
  if(row.completed||row.expiresAt<=now)throw Error('Decision is closed or expired');
  if(input.requestHash!==row.hash)throw Error('Approval request hash changed');
  if(!['approve','decline','approve_with_limits'].includes(input.outcome))throw Error('Invalid approval outcome');
  if(!Array.isArray(input.limits)||input.limits.length>20||input.outcome==='approve_with_limits'&&!input.limits.length)throw Error('Invalid additional approval limits');
  const limits=input.limits.map(v=>text(v,2000,'approval limit'));
  if(input.wakeEnabled!==undefined&&(typeof input.wakeEnabled!=='boolean'||input.wakeEnabled&&!row.value.approval.standing))throw Error('Automatic wake requires a standing brief scope');
  if(!Number.isSafeInteger(input.expiresAt)||input.expiresAt<=now||input.expiresAt>now+86400000||input.expiresAt>row.expiresAt)throw Error('Approval expiry must be within 24 hours and request lifetime');
  const value={decisionId:row.entryId,requestHash:row.hash,targetSessionId:row.value.approval.targetSessionId,status:'answered',outcome:input.outcome,wakeEnabled:input.wakeEnabled===true,limits,expiresAt:input.expiresAt,rationale:text(input.rationale,8000,'rationale'),verification,actor,at:now};
  await finish(b,row.entryId,agent);const resultEntryId=write(b,COORD.answer,value,agent);
  return {entryId:row.entryId,resultEntryId,status:'answered'};
 }
 if(row.completed||row.expiresAt<=now)throw Error('Decision is closed or expired');
 if(input.action==='decision_answer'&&row.value.approval)throw Error('Verified owner approval route unavailable; native approval remains required');
 if(input.action==='decision_answer'&&binding)throw Error('Only the owner can answer decisions');
 if(input.action==='decision_withdraw'&&binding&&row.value.createdBy!==actor)throw Error('Only the requester or owner can withdraw');
 if(input.action==='decision_answer'&&!row.value.options.some(o=>o.id===input.optionId))throw Error('Unknown decision option');
 const value={decisionId:row.entryId,status:input.action==='decision_answer'?'answered':'withdrawn',optionId:input.optionId??null,rationale:text(input.rationale,8000,'rationale'),actor,at:now};
 await finish(b,row.entryId,agent);const resultEntryId=write(b,COORD.answer,value,agent);
 return {entryId:row.entryId,resultEntryId,status:value.status};
}
