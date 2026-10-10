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
     if(row.answer)card.append(el('p',`${row.answer.value.status}: ${row.answer.value.optionId??''} — ${row.answer.value.rationale}`));
     if(row.status==='open'&&data.canAnswer)form('Record your answer',[['optionId','Selected option ID'],['rationale','Reason and scope of decision',true]],'decision_answer',v=>({...v,entryId:row.entryId}),card);
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
