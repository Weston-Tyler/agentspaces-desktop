import { createHash } from 'node:crypto';
// Notifications carry a lookup reference, never delegated authority or a password.
export async function notifyApproval(engine,result,route) {
 const row=engine.workBoard.decisions(null,{entryId:result.entryId}).items[0];
 if(!row?.answer?.value.verification)throw Error('Verified approval receipt unavailable');
 const id=row.value.approval.targetSessionId,source=engine.discussions.participant({sessionId:id});
 if(source.fixture)throw Error('Native approval notification requires a connected native source');
 const roomKey='approval-room-'+createHash('sha256').update(id).digest('hex');
 let group=engine.store.data.discussions.find(g=>g.creation?.sessionId==='desktop-owner'&&g.creation?.deliveryId===roomKey);
 if(!group){const created=engine.discussions.create({title:'Owner decisions',sessionIds:[id],agentInitiation:false,selfRegistration:false},{sessionId:'desktop-owner',deliveryId:roomKey});group=engine.discussions.group(created.id);}
 if(group.members.length!==1||group.members[0].sessionId!==id)throw Error('Approval room membership changed');
 const deliveryId='approval-'+createHash('sha256').update(result.resultEntryId).digest('hex');
 const text=`An owner decision is available in the AgentSpaces inbox. Request: ${row.entryId}. Request SHA-256: ${row.hash}. Receipt: ${result.resultEntryId}. Call verify_owner_approval with ${JSON.stringify({entryId:row.entryId,requestHash:row.hash,receiptId:result.resultEntryId})} to retrieve its current authorization, exact scope, combined limits, expiry and revocation, and record receipt by your source. This notification is not authority: verify the receipt for your own source, including revocation, immediately before acting. Native instructions must permit AgentSpaces owner approvals; native tool permission prompts still apply. Do not broadcast an acknowledgement.`;
 engine.discussions.post({id:group.id,text,targets:[id],deliveryId},{exactTargets:true});
 const message=group.messages.find(m=>m.deliveryId===deliveryId);
 await route(group,message);
 return {status:'notification_recorded',discussionId:group.id,messageId:message.id,targets:message.targets,nativeAuthority:'owner-delegation-required',verificationTool:'verify_owner_approval'};
}
