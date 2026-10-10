import {createHash} from 'node:crypto';
import {normalizeHostPath} from './platform.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const strict=(value,fields)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!fields.includes(key)))throw Error('Unknown provider routing field');};
const text=(value,max,name)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(`Invalid ${name}`);return value;};
const metrics=(rows,fields,known)=>({records:rows.length,metrics:Object.fromEntries(fields.map(field=>{
 const accepted=rows.filter(row=>known(row,field)&&Number.isSafeInteger(row[field])&&row[field]>=0);
 return[field,{value:accepted.length?accepted.reduce((sum,row)=>sum+row[field],0):null,knownRecords:accepted.length,unknownRecords:rows.length-accepted.length}];
}))});
const within=(cwd,tree)=>{if(!cwd)return false;const path=normalizeHostPath(cwd,tree.host),root=normalizeHostPath(tree.path,tree.host);return path===root||path.startsWith(root+'/')||path.startsWith(root+'\\');};
const nativeCodes=new Set(['native_protocol_unavailable','native_daemon_version_mismatch','native_loaded_target_not_available','native_existing_thread_busy_or_unavailable','native_rpc_rejected','native_rpc_timeout','native_proxy_disconnected','native_proxy_not_connected','native_websocket_handshake_failed','native_websocket_not_ready']);
export class ProviderRouting {
 constructor(engine){this.engine=engine;}
 access(binding){if(binding)this.engine.discussions.participant(binding);this.engine.workBoard.access(binding);return this.engine.workspace.index.profile;}
 eligible(source){const profile=this.engine.workspace.index?.profile,grant=this.engine.permissions(source);return !source.fixture&&['codex','claude'].includes(source.provider)&&source.scopeId===profile?.id&&source.account===profile.account&&grant.enrolled&&grant.share&&grant.retrieve&&this.engine.workspace.sessionAllowed(source);}
 reports(binding){const p=this.access(binding),now=this.engine.clock();return (this.engine.store.data.providerAvailability??[]).filter(row=>row.scopeId===p.id&&row.account===p.account&&(!binding||row.appliesTo==='provider'||row.sourceId===binding.sessionId)).map(row=>{
  const receipt=row.evidence?this.engine.store.data.codexDiscussionDeliveries?.[row.evidence.requestId]:null;
  const invalidated=!!row.evidence&&(!receipt||receipt.sessionId!==row.sourceId||receipt.status!=='native-agent-unavailable'||receipt.reasonCode!==row.evidence.reasonCode||Date.parse(receipt.at)!==row.evidence.observedAt);
  return{...row,invalidated,expired:invalidated||row.expiresAt<=now};
 });}
 availability(provider,reports){const report=reports.filter(row=>row.provider===provider&&row.appliesTo==='provider').sort((a,b)=>b.observedAt-a.observedAt).at(0)??null;return{state:report&&!report.expired?report.state:'unknown',report,verifiedProviderQuota:false};}
 report(input,binding=null){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Provider report object required');
  const p=this.access(binding),now=this.engine.clock();let provider,state,origin,appliesTo,sourceId=null,evidence=null;
  const minutes=input.minutes??15;if(!Number.isInteger(minutes)||minutes<1||minutes>1440)throw Error('Availability expires in 1–1440 minutes');
  if(binding){
   if(!input.nativeRequestId)throw Error('nativeRequestId for an exact native error receipt required');
   strict(input,['nativeRequestId','minutes']);text(input.nativeRequestId,100,'native receipt');
   const receipt=this.engine.store.data.codexDiscussionDeliveries?.[input.nativeRequestId],source=this.engine.session(binding.sessionId);
   if(!receipt||receipt.requestId!==input.nativeRequestId||receipt.sessionId!==source.id||source.provider!=='codex'||receipt.status!=='native-agent-unavailable'||!nativeCodes.has(receipt.reasonCode)||!Number.isFinite(Date.parse(receipt.at))||now-Date.parse(receipt.at)>1800000||Date.parse(receipt.at)>now)throw Error('Current exact source native error receipt required');
   this.engine.discussions.context(receipt.discussionId,binding);
   provider=source.provider;state='unavailable';origin='native-error-receipt';appliesTo='source';sourceId=source.id;
   evidence={store:'codexDiscussionDeliveries',requestId:receipt.requestId,reasonCode:receipt.reasonCode,observedAt:Date.parse(receipt.at),hash:hash({requestId:receipt.requestId,sessionId:receipt.sessionId,discussionId:receipt.discussionId,status:receipt.status,reasonCode:receipt.reasonCode,at:receipt.at})};
  }else{
   strict(input,['provider','state','minutes']);
   if(!['codex','claude'].includes(input.provider)||!['available','limited','unavailable','unknown'].includes(input.state))throw Error('Invalid provider availability');
   provider=input.provider;state=input.state;origin='owner-report';appliesTo='provider';
  }
  const report={provider,state,origin,appliesTo,sourceId,scopeId:p.id,account:p.account,observedAt:now,expiresAt:Math.min(now+minutes*60000,evidence?evidence.observedAt+1800000:Infinity),evidence,weeklyQuota:null};
  report.hash=hash(report);
  this.engine.store.data.providerAvailability=[...(this.engine.store.data.providerAvailability??[]).filter(row=>!(row.provider===provider&&row.scopeId===p.id&&row.account===p.account&&row.sourceId===sourceId)).slice(-199),report];
  this.engine.store.save();this.engine.store.audit('Provider availability report saved',{provider,origin,appliesTo,hash:report.hash,expiresAt:report.expiresAt});return report;
 }
 view(input={},binding=null){
  strict(input,[]);const p=this.access(binding),reports=this.reports(binding),sources=this.engine.catalog.filter(source=>this.eligible(source));
  const providers=['codex','claude'].map(provider=>{
   const readable=sources.filter(source=>source.provider===provider&&(!binding||source.id===binding.sessionId));
   const raw=Object.values(this.engine.store.data.usage??{}).filter(row=>row.provider===provider&&row.account===p.account&&readable.some(source=>[source.id,source.nativeThreadId].includes(row.threadId)));
   const effective=raw.filter(row=>row.scope==='session-cumulative'||!raw.some(cumulative=>cumulative.scope==='session-cumulative'&&cumulative.threadId===row.threadId&&cumulative.coveredTurnIds?.includes(row.turnId)));
   const discussion=Object.values(this.engine.store.data.codexDiscussionDeliveries??{}).filter(row=>readable.some(source=>source.id===row.sessionId)).map(row=>row.usage??{known:false});
   return {provider,availability:this.availability(provider,reports),sourceReports:reports.filter(row=>row.provider===provider&&row.appliesTo==='source'),
    eligibleSources:sources.filter(source=>source.provider===provider).map(source=>({sessionId:source.id,title:source.title,host:source.host,cwd:source.cwd})),
    usage:{sessions:metrics(effective,['input','output','cachedInput','tool','subagent'],(row,field)=>row.reportedFields?.includes(field)),
     discussions:metrics(discussion,['inputTokens','outputTokens'],row=>row.known===true),combinedTotal:null,weeklyQuota:null,
     scope:'Observed metrics only. Session and discussion streams may overlap and are never added together. Missing or legacy-unclassified metrics remain unknown; no provider billing or weekly allowance is inferred.'}};
  });
  return{observedAt:this.engine.clock(),scopeId:p.id,providers,canSetAvailability:!binding,modelCalls:0,authority:'Reports inform proposals; native permissions and current work claims remain authoritative'};
 }
 preview(input,binding=null){
  strict(input,['workEntryId','workHash','worktreeId','targetSessionId']);this.access(binding);
  for(const key of ['workEntryId','worktreeId','targetSessionId'])text(input[key],key==='targetSessionId'?300:100,key);
  if(!/^[a-f0-9]{64}$/.test(input.workHash??''))throw Error('Exact work hash required');
  const board=this.engine.workBoard,work=board.view(binding,{limit:200}).items.find(row=>row.entryId===input.workEntryId);
  if(!work||work.hash!==input.workHash||['expired','completed'].includes(work.status))throw Error('Current open work brief and exact hash required');
  const latest=work.results.at(-1);if(!latest||work.resultsTruncated)throw Error('Complete bounded progress evidence required before handoff');
  const source=this.engine.session(latest.value.actor);
  if(binding&&(binding.sessionId!==source.id||work.holder!==board.agent(binding.sessionId).agentId))throw Error('Only the current work holder or owner can propose handoff');
  if(!this.eligible(source))throw Error('Original work source no longer eligible for sharing');
  const target=this.engine.session(input.targetSessionId);
  if(!this.eligible(target)||target.provider===source.provider)throw Error('Choose an eligible source on an alternate provider');
  const index=this.engine.workspace.index,observedAt=Date.parse(index.observedAt),now=this.engine.clock();
  if(index.stale||!Number.isFinite(observedAt)||observedAt>now||now-observedAt>900000)throw Error('Refresh workspace inventory for fresh handoff evidence');
  const tree=index.nodes.find(row=>row.id===input.worktreeId&&row.kind==='worktree');
  if(!tree||tree.host!==source.host||tree.host!==target.host||!within(source.cwd,tree)||!within(target.cwd,tree)||tree.readAllowed===false)throw Error('Both sources must be eligible in the same observed worktree');
  const branch=String(tree.branch??'').replace(/^refs\/heads\//,'');
  if(!/^[a-f0-9]{40,64}$/.test(tree.head??'')||tree.head!==latest.value.head||branch!==String(latest.value.branch).replace(/^refs\/heads\//,''))throw Error('Worktree revision differs from latest reported branch/head');
  const reports=this.reports(null),availability=this.availability(target.provider,reports);
  if(['limited','unavailable'].includes(availability.state)||reports.some(row=>row.sourceId===target.id&&!row.expired&&row.state==='unavailable'))throw Error('Target is not currently reported available; resolve the availability report first');
  const artifacts=typeof board.artifacts==='function'?board.artifacts(binding,{workEntryId:work.entryId,limit:20}):null;
  const repositoryNode=index.nodes.find(row=>row.id===tree.repositoryId&&row.kind==='repository');
  const proposal={kind:'provider-handoff-proposal',workEntryId:work.entryId,workHash:work.hash,title:work.value.title,repository:work.value.repository,base:work.value.base,
   repositoryEvidence:{nodeId:tree.repositoryId??null,path:repositoryNode?.path??null,remote:repositoryNode?.remote??null,hash:repositoryNode?hash(repositoryNode):null},
   sourceSessionId:source.id,sourceProvider:source.provider,targetSessionId:target.id,targetProvider:target.provider,worktreeId:tree.id,host:tree.host,worktree:tree.path,branch,head:tree.head,
   workspaceObservedAt:index.observedAt,worktreeEvidenceHash:hash(tree),progressEntryId:latest.entryId,progressHash:latest.hash,
   claim:{holder:work.holder,expiresAt:work.claimExpiresAt},availability:{state:availability.state,reportHash:availability.report?.hash??null,expiresAt:availability.report?.expiresAt??null},
   artifacts:(artifacts?.items??[]).map(row=>({entryId:row.entryId,hash:row.hash,digest:row.value.artifact.digest,version:row.value.version})),artifactsTruncated:artifacts?.truncated??false,
   limits:['proposal only; no native work started','Scope eligibility is verified; transport readiness and provider quota are not','No claim transfer; current holder must finish/release or its lease must expire before another source claims work','Owner decision does not bypass native approvals; target must recheck repository instructions, worktree state and exact evidence before execution'],billingAndWeeklyQuota:'unknown'};
  if(JSON.stringify(proposal).length>10000)throw Error('Handoff proposal exceeds the bounded decision contract');
  return{proposal,proposalHash:hash(proposal),modelCalls:0};
 }
 async request(input,binding=null){
  strict(input,['workEntryId','workHash','worktreeId','targetSessionId','proposalHash','deliveryId']);
  if(!/^[A-Za-z0-9-]{8,100}$/.test(input.deliveryId??'')||!/^[a-f0-9]{64}$/.test(input.proposalHash??''))throw Error('Stable deliveryId and exact proposalHash required');
  const {proposalHash:expected,proposal}=this.preview(Object.fromEntries(['workEntryId','workHash','worktreeId','targetSessionId'].map(key=>[key,input[key]])),binding);
  if(expected!==input.proposalHash)throw Error('Handoff proposal changed; preview again before requesting');
  const result=await this.engine.workBoard.mutate({action:'decision_create',deliveryId:'handoff-'+hash(input.deliveryId),title:`Provider handoff: ${proposal.title}`.slice(0,200),
   question:`Review this exact provider handoff (proposal only). No work starts and no claim changes.\n${JSON.stringify({proposalHash:expected,...proposal})}`,
   options:[{id:'consider_handoff',label:'Approve this proposal for native review; preserve existing claim until a safe handoff'},{id:'keep_provider',label:'Keep the current provider and assignment'}],recommendation:'consider_handoff',blockedWork:[proposal.workEntryId]},binding);
  return{...result,proposalHash:expected,executionStarted:false,claimTransferred:false,nativeApprovalRequired:true};
 }
}
