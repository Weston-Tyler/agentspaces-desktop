// Derived solely from current permissions, owning work/decision records and
// timestamped native metadata. No chat parsing, model calls or lane registry.
export function laneView(b,binding,options={}) {
 if(Object.keys(options).some(k=>k!=='limit'))throw Error('Unknown lane query field');
 const {limit=100}=options;if(!Number.isInteger(limit)||limit<1||limit>200)throw Error('Invalid lane limit');
 const work=b.view(binding,{limit:200}),decisions=b.decisions(binding,{limit:200}),artifacts=b.artifacts(binding,{limit:200}),now=b.engine.clock(),profile=b.engine.workspace.index.profile;
 const holders=new Map(Object.values(b.receipts).filter(r=>r.result.holderSource).map(r=>[r.result.holder,r.result.holderSource]));
 const sources=b.engine.catalog.filter(source=>{const p=b.engine.permissions(source);return source.scopeId===profile.id&&source.account===profile.account&&p.enrolled&&p.retrieve&&p.share&&b.engine.workspace.sessionAllowed(source);});
 const items=sources.sort((a,b)=>a.id.localeCompare(b.id)).slice(0,limit).map(source=>{
  const owned=work.items.filter(item=>holders.get(item.holder)===source.id||item.results.some(result=>result.value.actor===source.id));
  const progress=owned.flatMap(item=>item.results.filter(result=>result.value.actor===source.id).map(result=>({...result,workEntryId:item.entryId,activeClaim:holders.get(item.holder)===source.id}))).sort((a,b)=>Date.parse(b.value.at)-Date.parse(a.value.at))[0];
  const pending=decisions.items.find(row=>row.status==='open'&&(row.value.approval?.targetSessionId??row.value.createdBy)===source.id);
  const observation=source.executionObservation,observedAt=Date.parse(observation?.observedAt),fresh=observation?.source==='native-thread-list'&&Number.isFinite(observedAt)&&observedAt<=now&&now-observedAt<=60000;
  let status='unknown',provenance={kind:'unavailable',reason:'No fresh native activity or explicit blocking evidence'};
  if(fresh&&observation.state==='active'){status='working';provenance={kind:observation.source,observedAt:observation.observedAt};}
  else if(pending){status='waiting-owner';provenance={kind:'decision-request',entryId:pending.entryId,hash:pending.hash,at:pending.value.createdAt};}
  else if(progress?.activeClaim&&progress.value.status==='blocked'){status='blocked';provenance={kind:'work-result',entryId:progress.entryId,hash:progress.hash,at:progress.value.at};}
  else if(fresh&&observation.state==='idle'){status='idle';provenance={kind:observation.source,observedAt:observation.observedAt};}
  const reports=artifacts.items.filter(row=>row.value.source.participantId===source.id),report=reports[0];
  const activity=[{at:source.updatedAt,kind:'catalog-updated'},...owned.flatMap(item=>item.results.filter(result=>result.value.actor===source.id).map(result=>({at:result.value.at,kind:'work-result',entryId:result.entryId}))),...(report?[{at:new Date(report.value.createdAt).toISOString(),kind:'artifact',entryId:report.entryId}]:[])].filter(item=>Number.isFinite(Date.parse(item.at))&&Date.parse(item.at)<=now).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at))[0]??null;
  return {sessionId:source.id,nativeThreadId:source.nativeThreadId??null,title:source.title,provider:source.provider,status,provenance,branch:progress?.value.branch??null,head:progress?.value.head??null,revisionProvenance:progress?{kind:'source-reported-work-result',entryId:progress.entryId,hash:progress.hash}:null,lastActivity:activity,workEntryIds:owned.map(item=>item.entryId),lastReport:report?{entryId:report.entryId,name:report.value.name,version:report.value.version,digest:report.value.artifact.digest}:null};
 });
 return {items,total:sources.length,truncated:sources.length>limit,observedAt:new Date(now).toISOString(),coverage:{workTruncated:work.coverage.truncated,decisionsTruncated:decisions.truncated,artifactsTruncated:artifacts.truncated,nativeFreshnessMs:60000},authority:'Derived coordination view; reported results are not acceptance'};
}
