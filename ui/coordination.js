const el=(tag,text)=>{const node=document.createElement(tag);if(tag==='button'){node.type='button';node.className='secondary';}if(text!==undefined)node.textContent=text;return node;};
function field(form,key,label,multi=false,required=true) {const wrap=el('label',label),input=el(multi?'textarea':'input');if(multi){input.rows=3;input.className='work-board-text';}input.maxLength=multi?12000:2000;input.name=key;input.required=required;wrap.append(input);form.append(wrap);return input;}
const values=form=>Object.fromEntries(new FormData(form));
export function mountCoordination(root,{api,notice,page}) {
 const refresh=el('button','Refresh'),status=el('p'),forms=el('div'),cards=el('div');root.replaceChildren(refresh,status,forms,cards);
 async function change(data,button) {
  button.disabled=true;button.operation??={...data,deliveryId:crypto.randomUUID()};
  try {await api(`${page}/change`,button.operation);button.operation=null;await load();return true;}
  catch(e){notice(e.message+' Retry keeps the same request identity.',true);}finally{button.disabled=false;}
 }
 function form(title,fields,action,build,parent=forms) {
  const details=el('details'),summary=el('summary',title),f=el('form');details.className='card work-board-create';details.append(summary,f);
  for(const args of fields)field(f,...args);
  const button=el('button',title);button.type='submit';button.className='primary';f.append(button);parent.append(details);
  f.addEventListener('submit',async e=>{e.preventDefault();try {if(await change({action,...build(values(f))},button)){f.reset();details.open=false;}}catch(error){notice(error.message,true);}});return f;
 }
 function approvalForm(card,row,revoke=false) {
  const f=el('form'),heading=el('h3',revoke?'Revoke approval':'Confirm scoped owner decision');f.append(heading);
  let outcome,limits,minutes;
  if(!revoke){
   const label=el('label','Decision');outcome=el('select');outcome.name='outcome';
   for(const [value,text] of [['approve','Approve within the requested limits'],['approve_with_limits','Approve with additional limits'],['decline','Decline']]){const option=el('option',text);option.value=value;outcome.append(option);}label.append(outcome);f.append(label);
   limits=field(f,'limits','Additional limits (one per line)',true,false);
   minutes=field(f,'minutes','Valid for minutes (1–1440)');minutes.type='number';minutes.min='1';minutes.max='1440';minutes.value='60';
  }
  const rationale=field(f,'rationale','Reason',true),password=field(f,'password','Owner approval password');password.type='password';password.autocomplete='current-password';
  const button=el('button',revoke?'Revoke':'Confirm and notify this thread');button.type='submit';f.append(button);card.append(f);
  let pending;
  f.addEventListener('input',e=>{if(e.target!==password)pending=null;});
  f.addEventListener('submit',async event=>{
   event.preventDefault();button.disabled=true;
   try {
    pending??={action:revoke?'decision_revoke':'decision_approve',entryId:row.entryId,deliveryId:crypto.randomUUID(),rationale:rationale.value,...(revoke?{}:{requestHash:row.hash,outcome:outcome.value,limits:limits.value.split('\n').map(x=>x.trim()).filter(Boolean),expiresAt:Date.now()+Number(minutes.value)*60000})};
    const secret=password.value;password.value='';
    const result=await api('approvals/answer',{password:secret,decision:pending});
    if(result.notification?.status==='not_delivered')notice('Decision saved; notification unavailable: '+result.notification.reason,true);
    else notice('Decision saved. Delivery status is visible in the Owner decisions room.');
    pending=null;await load();
   } catch(error){notice(error.message,true);}finally{button.disabled=false;}
  });
 }
 if(page==='decisions') form('Ask for a decision',[['title','Title'],['question','Question and relevant evidence',true],['options','Options (one per line)',true],['recommendation','Recommended option number'],['blockedWork','Blocked work item IDs (one per line)',true,false]],'decision_create',v=>{
  const options=v.options.split('\n').map(x=>x.trim()).filter(Boolean).map((label,i)=>({id:String(i+1),label}));
  return {...v,options,blockedWork:v.blockedWork.split('\n').map(x=>x.trim()).filter(Boolean)};
 });
 else form('Configure a machine',[['name','Display name'],['host','Connected host key'],['lockPaths','Existing Linux lock paths (one per slot)',true],['gateCommand','Optional admission gate argv as JSON',true,false]],'machine_create',v=>({...v,lockPaths:v.lockPaths.split('\n').map(x=>x.trim()).filter(Boolean),gateCommand:v.gateCommand?JSON.parse(v.gateCommand):[]}));
 refresh.addEventListener('click',load);
 async function load() {
  try {
   const data=await api(`${page}/list`,page==='decisions'?{limit:200}:{});if(!root.contains(status))return;
   status.textContent=`Refreshed ${new Date().toLocaleString()}${data.truncated?' · More records exist than shown':''}`;cards.replaceChildren();
   if(page==='decisions') {
    if(!data.items.length)cards.append(el('p','No decisions yet.'));
    for(const row of data.items) {
     const card=el('section');card.className='card work-board-item';card.append(el('h2',row.value.title),el('p',row.status),el('p',row.value.question));
     for(const option of row.value.options)card.append(el('p',`${option.id}. ${option.label}${option.id===row.value.recommendation?' (recommended)':''}`));
     card.append(el('p',`Requested by ${row.value.createdBy}`),el('p',`Blocked work: ${row.value.blockedWork.join(', ')||'None linked'}`));
     if(row.value.approval) {
      const scope=row.value.approval;
      const stateLabel={awaiting_owner_approval:'Awaiting your approval',available_for_target_verification:'Decision ready for the requesting agent',revoked:'Revoked',expired:'Expired',declined:'Declined',credential_changed:'Invalidated by password change'};
      card.append(el('p',`Owner approval: ${stateLabel[row.approvalDelivery]??row.approvalDelivery}`));
      if(row.notification)card.append(el('p',`Native notification: ${row.notification.status}. Receipt retrieval is shown separately.`));
      if(row.targetVerification)card.append(el('p',`Requesting thread checked receipt at ${new Date(row.targetVerification.value.checkedAt).toLocaleString()}. This records retrieval, not execution.`));
      for(const [label,value] of [['Action',scope.action],['Repository',scope.repo],['Branch',scope.branch],['Folder',scope.folder]])card.append(el('p',`${label}: ${value}`));
      card.append(el('h3','Required limits'));const list=el('ul');for(const limit of scope.limits)list.append(el('li',limit));card.append(list);
      if(row.answer?.value.verification){
       const answer=row.answer.value;card.append(el('p',`${{approve:'Approved',approve_with_limits:'Approved with additional limits',decline:'Declined'}[answer.outcome]} · Expires ${new Date(answer.expiresAt).toLocaleString()}`));
       for(const limit of answer.limits)card.append(el('p',`Additional limit: ${limit}`));
       const details=el('details');details.append(el('summary','Verification receipt'),el('pre',JSON.stringify({requestHash:row.hash,target:scope.targetSessionId,...answer.verification},null,2)));card.append(details);
      }
      if(data.canAnswer&&data.ownerAuthentication?.configured){
       if(row.status==='open')approvalForm(card,row);
       else if(row.answer?.value.verification&&!row.revocation)approvalForm(card,row,true);
      }else if(data.canAnswer)card.append(el('p','Set your separate approval password from the companion terminal: node app/cli.mjs owner-password. Never share that password with an agent.'));
     }
     if(row.answer)card.append(el('p',`${row.answer.value.status}: ${row.answer.value.optionId??''} — ${row.answer.value.rationale}`));
     if(row.status==='open'&&row.canAnswer)form('Record your answer',[['optionId','Selected option ID'],['rationale','Reason and scope of decision',true]],'decision_answer',v=>({...v,entryId:row.entryId}),card);
     if(row.status==='open')form('Withdraw decision',[['rationale','Reason']],'decision_withdraw',v=>({...v,entryId:row.entryId}),card);
     cards.append(card);
    }
   } else {
    if(!data.machines.length)cards.append(el('p','Configure a machine using its existing lock paths. No jobs are started by this page.'));
    for(const row of data.machines) {
     const card=el('section');card.className='card work-board-item';card.append(el('h2',row.value.name),el('p',`${row.value.host} · ${row.value.lockPaths.length} slots`),el('pre',row.value.lockPaths.join('\n')));
     form('Request test time',[['title','Job / test purpose'],['minutes','Maximum minutes (1–15)'],['priority','Priority: normal or release'],['exclusive','Whole machine: yes or no']],'machine_request',v=>({...v,machineId:row.entryId,minutes:Number(v.minutes),exclusive:v.exclusive==='yes'}),card);
     cards.append(card);
    }
    for(const row of data.requests) {
     const card=el('section');card.className='card work-board-item';card.append(el('h3',row.value.title),el('p',`${row.state}${row.position?' · Queue position '+row.position:''} · ${row.value.createdBy}`),el('p',`Request ${row.entryId}`));
     if(row.admission)card.append(el('p',`Deadline ${new Date(row.admission.deadline).toLocaleString()}`));
     if(row.state==='waiting'){const priority=el('button','Give release priority');priority.addEventListener('click',()=>change({action:'machine_prioritize',entryId:row.entryId},priority));card.append(priority);}
     if(row.state==='waiting'||row.state==='expired')form('Cancel request',[['summary','Reason']],'machine_cancel',v=>({...v,entryId:row.entryId}),card);
     if(row.state==='reconciliation_required')form('Confirm runner stopped',[['summary','Evidence that the job and descendants have stopped',true]],'machine_reconcile',v=>({...v,entryId:row.entryId}),card);
     cards.append(card);
    }
   }
  }catch(e){status.textContent=e.message;}
 }
 load();
}
