const el=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
const field=(form,label,input)=>{const wrap=el('label',label);wrap.append(input);form.append(wrap);return input;};
const option=(select,value,label)=>{const node=el('option',label);node.value=value;select.append(node);};
export function mountProviderRouting(root,{api,notice}){
 if(!root)return;root.replaceChildren();
 const intro=el('p','Provider availability is reported with an expiry. Token observations do not reveal weekly allowances or billing. Changing providers always requires a reviewed handoff and native permission.'),refresh=el('button','Refresh provider status'),cards=el('div'),report=el('form'),reportTitle=el('h3','Report provider availability');
 refresh.type='button';refresh.className='secondary';report.className='card work-board-create';report.append(reportTitle);
 const provider=field(report,'Provider',el('select')),state=field(report,'Owner-reported availability',el('select')),minutes=field(report,'Expires in minutes',el('input')),save=el('button','Save availability report');
 for(const value of ['codex','claude'])option(provider,value,value);
 for(const value of ['unknown','available','limited','unavailable'])option(state,value,value);
 minutes.type='number';minutes.min='1';minutes.max='1440';minutes.value='60';save.type='submit';save.className='primary';report.append(save);
 const handoff=el('details'),form=el('form');handoff.className='card';handoff.append(el('summary','Propose a provider handoff'),el('p','The current work claim stays with its holder. Preview uses the latest progress and fresh indexed worktree; both native sources must use that same worktree. No job starts from this form.'),form);
 const work=field(form,'Existing brief',el('select')),target=field(form,'Target source',el('select')),tree=field(form,'Observed worktree',el('select')),previewButton=el('button','Preview exact handoff'),proposalView=el('pre'),request=el('button','Send proposal to decision inbox');
 previewButton.type='submit';previewButton.className='secondary';request.type='button';request.className='primary';request.disabled=true;form.append(previewButton);handoff.append(proposalView,request);
 root.append(intro,refresh,cards,report,handoff);
 let board=[],preview=null,payload=null,pendingRequest=null;
 const invalidate=()=>{preview=null;payload=null;pendingRequest=null;request.disabled=true;proposalView.textContent='';};
 for(const input of [work,target,tree])input.addEventListener('change',invalidate);
 async function load(){
  refresh.disabled=true;
  try{
   const [status,items,workspace]=await Promise.all([api('providers/status',{}),api('work-board/list',{limit:200}),api('workspace')]);
   if(!root.isConnected)return;cards.replaceChildren();work.replaceChildren();target.replaceChildren();tree.replaceChildren();invalidate();board=items.items;
   for(const row of status.providers){
    const card=el('section'),report=row.availability.report;card.className='card';
    card.append(el('h2',row.provider),el('p',`Availability: ${row.availability.state}${report?' · owner report observed '+new Date(report.observedAt).toLocaleString()+' · expires '+new Date(report.expiresAt).toLocaleString(): ' · no current owner report'}`),el('p','Weekly allowance: unknown · Billing: unknown'));
    for(const [stream,value] of Object.entries(row.usage).filter(([,value])=>value?.metrics)){
     card.append(el('h3',`${stream}: ${value.records} observations`));
     for(const [key,metric] of Object.entries(value.metrics))card.append(el('p',`${key}: ${metric.value===null?'unknown':metric.value} · ${metric.knownRecords} known / ${metric.unknownRecords} unknown`));
    }
    if(row.sourceReports.length)card.append(el('p',`${row.sourceReports.filter(item=>!item.expired).length} current source-specific native error reports; these do not establish a provider-wide quota limit.`));
    const provenance=el('details');provenance.append(el('summary','Availability provenance'),el('pre',JSON.stringify({ownerReport:report,sourceReports:row.sourceReports},null,2)));card.append(provenance);cards.append(card);
    for(const source of row.eligibleSources)option(target,source.sessionId,`${row.provider} · ${source.title} · ${source.host}`);
   }
   for(const item of board.filter(item=>!['expired','completed'].includes(item.status)))option(work,item.entryId,item.value.title);
   for(const node of workspace.nodes??[])if(node.kind==='worktree')option(tree,node.id,`${node.path} · ${node.branch??'detached'} @ ${node.head?.slice(0,12)??'unknown'}`);
   save.disabled=!status.canSetAvailability;
  }catch(error){notice(error.message,true);cards.replaceChildren(el('p','Provider status unavailable. Connect an active workspace and refresh.'));save.disabled=true;}
  finally{refresh.disabled=false;}
 }
 report.addEventListener('submit',async event=>{event.preventDefault();save.disabled=true;try{await api('providers/availability',{provider:provider.value,state:state.value,minutes:Number(minutes.value)});await load();notice('Owner availability report saved.');}catch(error){notice(error.message,true);}finally{save.disabled=false;}});
 form.addEventListener('submit',async event=>{
  event.preventDefault();previewButton.disabled=true;invalidate();
  try{const item=board.find(item=>item.entryId===work.value);payload={workEntryId:work.value,workHash:item?.hash,worktreeId:tree.value,targetSessionId:target.value};preview=await api('providers/handoff/preview',payload);proposalView.textContent=JSON.stringify(preview,null,2);request.disabled=false;}
  catch(error){notice(error.message,true);}finally{previewButton.disabled=false;}
 });
 request.addEventListener('click',async()=>{
  if(!preview||!payload)return;request.disabled=true;
  pendingRequest??={...payload,proposalHash:preview.proposalHash,deliveryId:crypto.randomUUID()};
  try{const result=await api('providers/handoff/request',pendingRequest);notice(`Decision request ${result.entryId} created. No native work started and no claim transferred.`);invalidate();}
  catch(error){notice(error.message+' Retry preserves the same request. Preview again if its evidence changed.',true);request.disabled=false;}
 });
 refresh.addEventListener('click',load);load();
}
