import { COORD, COORD_SPACE, records, find, write, finish, text } from './coordination-records.mjs';
export const machineFields={machine_create:['name','host','lockPaths','gateCommand'],machine_request:['machineId','title','minutes','exclusive','priority'],machine_acquire:['entryId'],machine_release:['entryId','summary'],machine_cancel:['entryId','summary'],machine_reconcile:['entryId','summary'],machine_heartbeat:['entryId'],machine_prioritize:['entryId']};
const AGE=15*60000, HEARTBEAT=10*60000;
function latest(b,id) {return records(b,COORD.receipt).filter(r=>r.value.requestId===id).sort((a,c)=>c.value.sequence-a.value.sequence)[0]?.value??null;}
function event(b,id,kind,extra,agent) {const previous=latest(b,id);return write(b,COORD.receipt,{requestId:id,sequence:(previous?.sequence??0)+1,kind,at:b.engine.clock(),...extra},agent);}
function projection(b) {
 const now=b.engine.clock(),machines=records(b,COORD.machine),requests=records(b,COORD.reservation).map(r=>{
  const e=latest(b,r.entryId),terminal=['released','cancelled','reconciled'].includes(e?.kind);
  const admitted=records(b,COORD.receipt).filter(x=>x.value.requestId===r.entryId&&x.value.kind==='acquired').map(x=>x.value)[0];
  const heartbeat=e?.at??r.value.createdAt;
  const state=terminal?e.kind:admitted?(admitted.deadline<=now?'reconciliation_required':'reserved'):(heartbeat+HEARTBEAT<=now||r.expiresAt<=now)?'expired':'waiting';
  return {...r,state,event:e,admission:admitted,heartbeatDeadline:heartbeat+HEARTBEAT,rank:Math.min(3,((records(b,COORD.receipt).some(x=>x.value.requestId===r.entryId&&x.value.kind==='priority')||r.value.priority==='release')?2:0)+Math.floor((now-r.value.createdAt)/AGE))};
 });
 for(const m of machines) {
  const q=requests.filter(r=>r.value.machineId===m.entryId&&r.state==='waiting').sort((a,c)=>c.rank-a.rank||a.value.createdAt-c.value.createdAt||a.entryId.localeCompare(c.entryId));
  q.forEach((r,i)=>r.position=i+1);
 }
 return {machines,requests,observedAt:now,authority:'Signed AgentSpaces records and claims; actual host locks must also be acquired',automaticExecution:false};
}
export function machineView(b,binding,options={}) {
 if(Object.keys(options).length)throw Error('Unknown machine list field');
 b.access(binding);if(b.writing)throw Error('Work board is saving; refresh shortly');b.peer=null;b.open();b.access(binding);
 const view=projection(b);return {...view,machines:view.machines.filter(m=>!m.value.slot),requests:view.requests.slice(-200),truncated:view.requests.length>200,canConfigure:!binding};
}
export async function machineChange(b,input,binding,actor,agent) {
 const now=b.engine.clock(),all=projection(b);
 if(input.action==='machine_create') {
  if(binding)throw Error('Only the owner can configure machines');
  const host=text(input.host,200,'host'),{lockPaths,gateCommand=[]}=input;
  if(!Array.isArray(lockPaths)||!lockPaths.length||lockPaths.length>8||new Set(lockPaths).size!==lockPaths.length||lockPaths.some(p=>typeof p!=='string'||!p.startsWith('/')||p.length>4096||p.includes('\0')))throw Error('Provide 1–8 unique absolute Linux lock paths');
  if(!Array.isArray(gateCommand)||gateCommand.length>20||gateCommand.some(x=>typeof x!=='string'||!x||x.length>4096))throw Error('Invalid admission gate argv');
  if(all.machines.some(m=>!m.value.slot&&m.value.host===host&&m.value.lockPaths.some(p=>lockPaths.includes(p))))throw Error('Machine lock paths already registered');
  const machineId=write(b,COORD.machine,{name:text(input.name,200,'name'),host,lockPaths,gateCommand,createdAt:now},agent);
  // Each slot uses the owning claim lattice. No shadow filesystem lock is created.
  const slots=lockPaths.map((path,index)=>write(b,COORD.machine,{machineId,index,path,slot:true},agent));
  return {machineId,slots};
 }
 if(input.action==='machine_request') {
  const m=find(b,COORD.machine,input.machineId);if(m.value.slot||m.expiresAt<=now)throw Error('Machine unavailable');
  if(binding&&b.engine.session(actor).host!==m.value.host)throw Error('Requester must run on the configured machine host');
  const minutes=input.minutes??15;if(!Number.isInteger(minutes)||minutes<1||minutes>15)throw Error('Runtime cap must be 1–15 minutes');
  const priority=input.priority??'normal';if(!['normal','release'].includes(priority)||priority==='release'&&binding)throw Error('Release priority requires owner submission');
  if(input.exclusive!==undefined&&typeof input.exclusive!=='boolean')throw Error('Invalid exclusive flag');
  if(all.requests.some(r=>r.value.createdBy===actor&&r.value.machineId===m.entryId&&['waiting','reserved','reconciliation_required'].includes(r.state)))throw Error('Requester already has active work on this machine');
  return {entryId:write(b,COORD.reservation,{machineId:m.entryId,title:text(input.title,200,'title'),minutes,exclusive:input.exclusive??false,priority,createdBy:actor,createdAt:now},agent),status:'waiting'};
 }
 const row=all.requests.find(r=>r.entryId===input.entryId);if(!row)throw Error('Unknown machine request');
 if(binding&&row.value.createdBy!==actor)throw Error('Only requester or owner can change this request');
 const m=find(b,COORD.machine,row.value.machineId);
 if(input.action==='machine_prioritize') {
  if(binding)throw Error('Only the owner can prioritize release work');
  if(row.state!=='waiting')throw Error('Only waiting work can be prioritized');
  event(b,row.entryId,'priority',{priority:'release',actor},agent);return {entryId:row.entryId,status:'waiting',priority:'release'};
 }
 if(input.action==='machine_reconcile') {
  if(binding)throw Error('Only the owner can reconcile a stopped runner');
  if(row.state!=='reconciliation_required')throw Error('No expired runner requires reconciliation');
  await retireSlots(b,row,m,agent);
  event(b,row.entryId,'reconciled',{summary:text(input.summary,8000,'stopped-runner evidence'),actor},agent);await finish(b,row.entryId,agent);return {entryId:row.entryId,status:'reconciled'};
 }
 if(input.action==='machine_release'||input.action==='machine_cancel') {
  if(input.action==='machine_cancel'&&!['waiting','expired'].includes(row.state))throw Error('Running work must stop and release; cancellation does not kill it');
  if(input.action==='machine_release'&&!['reserved','reconciliation_required'].includes(row.state))throw Error('Request is not running');
  if(input.action==='machine_release')await retireSlots(b,row,m,b.agent(row.value.createdBy));
  event(b,row.entryId,input.action==='machine_release'?'released':'cancelled',{summary:text(input.summary,8000,'summary'),actor},agent);
  await finish(b,row.entryId,agent);return {entryId:row.entryId,status:input.action==='machine_release'?'released':'cancelled'};
 }
 if(row.state!=='waiting')throw Error('Request is not waiting; inspect state before retrying');
 if(input.action==='machine_heartbeat') {event(b,row.entryId,'heartbeat',{},agent);return {entryId:row.entryId,status:'waiting',heartbeatDeadline:now+HEARTBEAT};}
 if(m.expiresAt<=now)throw Error('Machine definition expired');
 if(binding&&b.engine.session(actor).host!==m.value.host)throw Error('Requester host changed');
 if(row.position!==1)throw Error(`Waiting for queue position ${row.position}`);
 const busy=all.requests.filter(r=>r.value.machineId===row.value.machineId&&['reserved','reconciliation_required'].includes(r.state));
 if(busy.some(r=>r.state==='reconciliation_required'))throw Error('Expired runner requires owner reconciliation before admission');
 const occupied=new Set(busy.flatMap(r=>r.admission.slotIds));
 const slots=all.machines.filter(s=>s.value.slot&&!s.completed&&s.expiresAt>now&&s.value.machineId===m.entryId);
 const free=slots.filter(s=>!occupied.has(s.entryId));
 if(busy.some(r=>r.value.exclusive)||row.value.exclusive&&busy.length||!free.length)throw Error('Machine slots busy');
 const selected=row.value.exclusive?free:[free[0]];
 for(const slot of selected) {
  const held=await b.peer.takeEntry(COORD_SPACE,COORD.machine,'worker',row.value.minutes*60000,0,700,agent,slot.entryId);
  if(held!==slot.entryId)throw Error('Resource claim is still held; wait for its lease');
 }
 const admission={slotIds:selected.map(s=>s.entryId),lockPaths:selected.map(s=>s.value.path),host:m.value.host,gateCommand:m.value.gateCommand,deadline:now+row.value.minutes*60000,minutes:row.value.minutes,actor};
 event(b,row.entryId,'acquired',admission,agent);
 return {entryId:row.entryId,status:'reserved',...admission,requiresActualLocks:true};
}

async function retireSlots(b,row,m,agent) {
 for(const id of row.admission.slotIds) {
  const slot=find(b,COORD.machine,id),claim=b.peer.claims.get(id)?.claim;
  if(Number(claim?.expiresAtMillis)>b.engine.clock())b.peer.requireHeld(COORD_SPACE,id,agent);
  else if(await b.peer.takeEntry(COORD_SPACE,COORD.machine,'worker',60000,0,700,agent,id)!==id)throw Error('Resource unavailable for reconciliation');
  b.peer.completeEntry(COORD_SPACE,id,agent);
  write(b,COORD.machine,{machineId:m.entryId,index:slot.value.index,path:slot.value.path,slot:true},agent);
 }
}
