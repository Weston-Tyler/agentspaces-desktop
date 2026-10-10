import { cbor, spaceIdLocal } from '@agentspaces/client';
import { createHash } from 'node:crypto';
export const COORD = Object.freeze({decision:'agentspaces.desktop.Decision#v1',answer:'agentspaces.desktop.DecisionAnswer#v1',machine:'agentspaces.desktop.Machine#v1',reservation:'agentspaces.desktop.MachineReservation#v1',receipt:'agentspaces.desktop.MachineReceipt#v1'});
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
 if(Object.keys(options).some(k=>k!=='limit'))throw Error('Unknown decision list field');
 const {limit=100}=options;
 if(!Number.isInteger(limit)||limit<1||limit>200)throw Error('Invalid limit');
 b.access(binding);if(b.writing)throw Error('Work board is saving; refresh shortly');b.peer=null;b.open();b.access(binding);
 const answers=records(b,COORD.answer),now=b.engine.clock();
 const all=records(b,COORD.decision).map(r=>{const answer=answers.find(a=>a.value.decisionId===r.entryId);return {...r,status:r.completed?(answer?.value.status??'closed'):r.expiresAt<=now?'expired':'open',answer:answer??null};})
 .sort((a,b)=>(a.status==='open'?0:1)-(b.status==='open'?0:1)||a.value.createdAt-b.value.createdAt||a.entryId.localeCompare(b.entryId));
 return {items:all.slice(0,limit),total:all.length,truncated:all.length>limit,canAnswer:!binding,authority:'Owner-recorded coordination decisions; native approvals remain authoritative'};
}
export const decisionFields={decision_create:['title','question','options','recommendation','blockedWork'],decision_answer:['entryId','optionId','rationale'],decision_withdraw:['entryId','rationale']};
export async function decisionChange(b,input,binding,actor,agent) {
 const now=b.engine.clock();
 if(input.action==='decision_create') {
  const {options,blockedWork=[]}=input;
  if(!Array.isArray(options)||options.length<2||options.length>8)throw Error('Provide 2–8 options');
  const choices=options.map(o=>({id:text(o.id,80,'option id'),label:text(o.label,2000,'option label')}));
  if(new Set(choices.map(o=>o.id)).size!==choices.length||!choices.some(o=>o.id===input.recommendation))throw Error('Unique options and matching recommendation required');
  if(!Array.isArray(blockedWork)||blockedWork.length>20||blockedWork.some(id=>typeof id!=='string'||!b.peer.states.has(id)||b.peer.states.get(id).record.type!=='agentspaces.desktop.FollowUpRequest#v1'))throw Error('Unknown blocked work item');
  return {entryId:write(b,COORD.decision,{title:text(input.title,200,'title'),question:text(input.question,12000,'question'),options:choices,recommendation:input.recommendation,blockedWork:[...new Set(blockedWork)],createdBy:actor,createdAt:now},agent),status:'open'};
 }
 const row=find(b,COORD.decision,input.entryId);
 if(row.completed||row.expiresAt<=now)throw Error('Decision is closed or expired');
 if(input.action==='decision_answer'&&binding)throw Error('Only the owner can answer decisions');
 if(input.action==='decision_withdraw'&&binding&&row.value.createdBy!==actor)throw Error('Only the requester or owner can withdraw');
 if(input.action==='decision_answer'&&!row.value.options.some(o=>o.id===input.optionId))throw Error('Unknown decision option');
 const value={decisionId:row.entryId,status:input.action==='decision_answer'?'answered':'withdrawn',optionId:input.optionId??null,rationale:text(input.rationale,8000,'rationale'),actor,at:now};
 await finish(b,row.entryId,agent);const resultEntryId=write(b,COORD.answer,value,agent);
 return {entryId:row.entryId,resultEntryId,status:value.status};
}
