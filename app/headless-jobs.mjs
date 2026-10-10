import { createHash,randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { readFile,lstat,realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { collectNativeProcess } from './answer-provider.mjs';
import { nativeAdapterCompatible } from './native-versions.mjs';
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const active=job=>['starting','running','finalizing','outcome-unknown'].includes(job.status);
export class HeadlessJobs {
 constructor(engine,{spawnProcess=spawn,inspectProvider,admitLaunch=()=>true}={}) {
  Object.assign(this,{engine,spawnProcess,admitLaunch});this.inspectProvider=inspectProvider??(async provider=>{await engine.probe('local');return engine.tools.find(tool=>tool.host==='local'&&tool.provider===provider);});
  engine.store.data.headlessJobReceipts??={};this.pending=new Map();this.tail=Promise.resolve();
  for(const job of Object.values(this.records()))if(active(job)){job.status='outcome-unknown';job.observation='companion-restarted';}
  this.save();
 }
 records(){return this.engine.store.data.headlessJobReceipts;}
 save(){this.engine.store.save();}
 activeCount(){return Object.values(this.records()).filter(active).length;}
 assertOwner(binding){if(binding)throw Error('Headless job launch and private logs require the owner');this.engine.workBoard.access(null);}
 capabilities(){return {launch:'owner-only',agentLaunch:{state:'blocked_requires_owner_launch',requestTool:'request_headless_job',decisionAnswerExecutes:false,nativePermissions:'Native clients remain authoritative'},providers:['codex','claude'],hosts:['local'],remote:'unsupported: durable remote process ownership is not implemented',nativePermissions:'inherited; no permission bypass flags',cancellation:false,providerHandoff:'explicit owner launch only',usage:'reported when native output includes usage; no inferred subscription balance'};}
 list(binding,options={}) {
  this.engine.workBoard.access(binding);if(Object.keys(options).some(key=>key!=='id'))throw Error('Unknown job list field');
  if(options.id!==undefined&&(typeof options.id!=='string'||options.id.length>100))throw Error('Invalid job identifier');
  const scope=this.engine.workspace.index.profile;
  const permitted=job=>{if(!binding||!job.discussionId)return true;try{const room=this.engine.discussions.context(job.discussionId,binding);return room.available!==false&&room.messages.some(message=>message.id===job.messageId);}catch{return false;}};
  return {items:Object.values(this.records()).filter(job=>job.scopeId===scope.id&&job.account===scope.account&&permitted(job)&&(!options.id||job.id===options.id)).map(({log,briefText,...job})=>binding?{id:job.id,provider:job.provider,status:job.status,observation:job.observation,workEntryId:job.workEntryId,discussionId:job.discussionId,finalArtifactId:job.finalArtifactId??null,startedAt:job.startedAt,endedAt:job.endedAt??null,exitCode:job.exitCode??null}:job),capabilities:this.capabilities()};
 }
 log(binding,{id}={}){this.assertOwner(binding);if(typeof id!=='string'||!id)throw Error('Exact job identifier required');const metadata=this.list(null,{id}).items[0];if(!metadata)throw Error('Unknown job');const job=this.records()[id];return {id,text:job.log??'',truncated:!!job.logTruncated,trust:'untrusted native stdout; private owner log; stderr is not retained'};}
 launch(input,binding){const run=this.tail.then(()=>this.start(input,binding));this.tail=run.catch(()=>{});return run;}
 async request(input,binding){
  const board=this.engine.workBoard;board.access(binding);if(!binding?.sessionId)throw Error('A source-bound agent request is required');
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['deliveryId','provider','host','cwd','workEntryId','discussionId','messageId','briefText','budget'].includes(key)))throw Error('Exact headless launch request fields required');
  if(!/^[A-Za-z0-9-]{8,100}$/.test(input.deliveryId??'')||!['codex','claude'].includes(input.provider)||input.host!==undefined&&input.host!=='local')throw Error('Supported local provider and deliveryId required');
  if(typeof input.cwd!=='string'||!isAbsolute(input.cwd)||input.cwd.length>4096||typeof input.briefText!=='string'||!input.briefText.trim()||Buffer.byteLength(input.briefText)>8000)throw Error('Exact absolute cwd and brief text up to 8 KiB required');
  const budget=input.budget;if(!budget||Object.keys(budget).some(key=>!['observationMs','maxTurns','maxCostUsd'].includes(key))||!Number.isInteger(budget.observationMs)||budget.observationMs<1000||budget.observationMs>900000||!Number.isInteger(budget.maxTurns)||budget.maxTurns<1||budget.maxTurns>100||!Number.isFinite(budget.maxCostUsd)||budget.maxCostUsd<=0||budget.maxCostUsd>50)throw Error('Explicit bounded observation, turn and cost budget required');
  const work=board.view(binding,{limit:200}).items.find(item=>item.entryId===input.workEntryId);if(!work||!['available','claimed'].includes(work.status))throw Error('Available owning work item required');
  if(work.status==='claimed'){board.open();board.peer.requireHeld('desktop-work-board',work.entryId,board.agent(binding.sessionId));}
  if(!!input.discussionId!==!!input.messageId)throw Error('Exact room message required');
  if(input.discussionId){const room=this.engine.discussions.context(input.discussionId,binding);if(room.available===false||!room.messages.some(message=>message.id===input.messageId))throw Error('Exact permitted room message required');}
  const launch=structuredClone(input),question='Review this exact headless launch request. An answer records your decision but does not spend or launch automatically. Owner launch still requires a current available/owner-held work claim and qualified native CLI; native permissions remain authoritative. Codex turn/cost numbers are requested limits, not enforced caps.\n\n'+JSON.stringify(launch);
  if(question.length>12000)throw Error('Launch request exceeds decision size bound');
  const decision=await board.mutate({action:'decision_create',deliveryId:'headless-request-'+hash([binding.sessionId,input.deliveryId]).slice(0,60),title:'Headless '+input.provider+' job request',question,options:[{id:'approve_owner_launch',label:'Approve; owner launches the exact payload after checking the work claim'},{id:'decline',label:'Decline'}],recommendation:'approve_owner_launch',blockedWork:[work.entryId]},binding);
  return {...decision,state:'blocked_requires_owner_launch',launch,automaticExecution:false};
 }
 async start(input,binding){
  this.assertOwner(binding);if(!this.admitLaunch())throw Error('Companion update is draining; launch deferred');
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['deliveryId','provider','host','cwd','workEntryId','discussionId','messageId','briefText','briefPath','budget'].includes(key)))throw Error('Unknown headless job field');
  if(!/^[A-Za-z0-9-]{8,100}$/.test(input.deliveryId??'')||!['codex','claude'].includes(input.provider))throw Error('Exact deliveryId and supported provider required');
  if(input.host!==undefined&&input.host!=='local')throw Error('Only local headless process ownership is supported');
  if(typeof input.cwd!=='string'||!isAbsolute(input.cwd)||input.cwd.length>4096)throw Error('Absolute owned working directory required');
  const cwd=await realpath(input.cwd);if(!(await lstat(cwd)).isDirectory())throw Error('Working directory required');
  if((typeof input.briefText==='string')===(typeof input.briefPath==='string'))throw Error('Provide exactly one briefText or briefPath');
  let brief=input.briefText;
  if(input.briefPath!==undefined){if(!isAbsolute(input.briefPath)||input.briefPath.length>4096)throw Error('Absolute brief path required');const stat=await lstat(input.briefPath);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>16384)throw Error('Brief must be an unlinked file up to 16 KiB');brief=await readFile(input.briefPath,'utf8');}
  if(!brief?.trim()||Buffer.byteLength(brief)>16384)throw Error('Brief text must be 1–16384 UTF-8 bytes');
  const budget=input.budget;
  if(!budget||Object.keys(budget).some(key=>!['observationMs','maxTurns','maxCostUsd'].includes(key))||!Number.isInteger(budget.observationMs)||budget.observationMs<1000||budget.observationMs>900000||!Number.isInteger(budget.maxTurns)||budget.maxTurns<1||budget.maxTurns>100||!Number.isFinite(budget.maxCostUsd)||budget.maxCostUsd<=0||budget.maxCostUsd>50)throw Error('Explicit bounded observation, turn and cost budget required');
  if(typeof input.workEntryId!=='string'||!input.workEntryId||input.workEntryId.length>100)throw Error('Exact owning work item required');
  if(!!input.discussionId!==!!input.messageId)throw Error('Exact room and message IDs required together');
  const scope=this.engine.workspace.index.profile,id=hash([scope.id,scope.account,input.deliveryId]);
  const inputHash=hash({provider:input.provider,cwd,workEntryId:input.workEntryId,discussionId:input.discussionId??null,messageId:input.messageId??null,briefHash:hash(brief),budget});
  const prior=this.records()[id];if(prior){if(prior.inputHash!==inputHash)throw Error('deliveryId reused for different job');return {...this.list(null,{id}).items[0],duplicate:true,replayed:false};}
  if(Object.keys(this.records()).length>=100)throw Error('Headless job receipt capacity reached');
  if(this.activeCount()>=3||Object.values(this.records()).some(job=>active(job)&&(job.cwd===cwd||job.workEntryId===input.workEntryId)))throw Error('An active or unresolved job already owns this work or directory');
  const tool=await this.inspectProvider(input.provider);if(!tool?.installed||!nativeAdapterCompatible(tool))throw Error('Installed qualified native provider required');
  this.assertOwner(null);
  const board=this.engine.workBoard,work=board.view(null,{limit:200}).items.find(item=>item.entryId===input.workEntryId);if(!work||!['available','claimed'].includes(work.status))throw Error('Available owning work item required');
  if(input.discussionId){const room=this.engine.discussions.view(this.engine.discussions.group(input.discussionId));if(room.available===false||!room.messages.some(message=>message.id===input.messageId))throw Error('Exact permitted room message required');}
  if(work.status==='available')await board.mutate({action:'claim',entryId:work.entryId,leaseMinutes:60,deliveryId:'job-claim-'+id.slice(0,60)},null);
  else {board.open();board.peer.requireHeld('desktop-work-board',work.entryId,board.agent('desktop-owner'));}
  if(!this.admitLaunch())throw Error('Companion update is draining; launch deferred');
  const record={id,inputHash,deliveryId:input.deliveryId,provider:input.provider,providerVersion:tool.version??'unknown',host:'local',cwd,workEntryId:work.entryId,workHash:work.hash,repository:work.value.repository,base:work.value.base,discussionId:input.discussionId??null,messageId:input.messageId??null,scopeId:scope.id,account:scope.account,briefHash:hash(brief),budget,status:'starting',observation:'attached',startedAt:new Date().toISOString(),log:'',usage:{known:false},budgetEnforcement:{time:'observation only; native process is never cancelled',turns:input.provider==='claude'?'native max-turns':'requested in brief; not natively enforced',cost:input.provider==='claude'?'native max-budget-usd':'requested in brief; not natively enforced'}};
  this.records()[id]=record;this.save();
  const args=input.provider==='codex'?['exec','--json','-']:['--print','--verbose','--output-format','stream-json','--max-turns',String(budget.maxTurns),'--max-budget-usd',String(budget.maxCostUsd)];
  const prompt=`Owner-authorized headless work brief. Follow native/repository instructions and native tool permissions. Work entry: ${work.entryId}. Repository: ${work.value.repository}. Base: ${work.value.base}. Allowed paths: ${work.value.allowedFiles}. Owning brief: ${work.value.brief}. Requested budget: ${budget.maxTurns} turns and USD ${budget.maxCostUsd}; stop and report if you cannot complete within it. This prompt does not bypass native controls. Return a concise final report with evidence and limits.\n\n${brief}`;
  let started=false,pending='',finalText='';const decoder=new StringDecoder('utf8');
  const observe=chunk=>{const text=decoder.write(chunk);record.log+=text;if(Buffer.byteLength(record.log)>65536){record.log=Buffer.from(record.log).subarray(-65500).toString('utf8');record.logTruncated=true;}
   pending+=text;const lines=pending.split('\n');pending=lines.pop();if(pending.length>65536){pending='';record.logTruncated=true;}
   for(const line of lines){try{const event=JSON.parse(line);if(event.type==='thread.started'&&typeof event.thread_id==='string')record.nativeThreadId=event.thread_id;
    if(event.type==='item.completed'&&event.item?.type==='agent_message')finalText=String(event.item.text??'');
    if(event.type==='result'&&typeof event.result==='string')finalText=event.result;
    if(event.usage&&typeof event.usage==='object'){const usage=Object.fromEntries(Object.entries(event.usage).filter(([key,value])=>['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'].includes(key)&&Number.isFinite(value)));record.usage={known:Object.keys(usage).length>0,...usage};}
   }catch{}}
   if(Buffer.byteLength(finalText)>15000){finalText=Buffer.from(finalText).subarray(0,14900).toString('utf8')+'\n[Final report truncated]';record.finalTruncated=true;}this.save();};
  const heartbeat=setInterval(()=>{if(!active(record))return;void board.mutate({action:'renew',entryId:record.workEntryId,leaseMinutes:60,deliveryId:'job-renew-'+randomUUID()},null).catch(()=>{record.claimStatus='renewal-unavailable';this.save();});},300000);heartbeat.unref?.();
  let finished;const completion=new Promise(resolve=>finished=resolve);this.pending.set(id,completion);
  const finish=async({code,signal}={})=>{if(record.endedAt)return;if(pending.trim())observe(Buffer.from('\n'));clearInterval(heartbeat);const terminalStatus=code===0?'finished':'died';record.status='finalizing';record.exitCode=Number.isInteger(code)?code:null;record.exitSignal=signal??null;record.endedAt=new Date().toISOString();this.save();
   try{const text=`Owner-launched native job ${id}. Provider: ${record.provider}. Exit: ${terminalStatus} (${record.exitCode??'unknown'}). This report is native output, not owner acceptance.\n\n`+(finalText||'No final answer was observed. Private stdout may contain additional evidence.');const output=await board.mutate({action:'artifact_create',deliveryId:'job-final-'+id.slice(0,60),workEntryId:record.workEntryId,...(record.discussionId?{discussionId:record.discussionId,messageId:record.messageId}:{}),name:'job-'+id.slice(0,12)+'.md',text,mediaType:'text/markdown'},null);record.finalArtifactId=output.entryId;record.artifactStatus='saved';}
   catch{record.artifactStatus='not-saved; owning claim or sharing access may have changed';}
   record.status=terminalStatus;this.save();finished({...record,log:undefined});};
  // Reuse the native process adapter. Its observer budget does not end native
  // execution. Safe-update callers must include activeCount until actual exit.
  void collectNativeProcess(this.spawnProcess,input.provider+(process.platform==='win32'?'.exe':''),args,{cwd,input:prompt,timeoutMs:budget.observationMs,limit:1048576,preserveProcess:true,onProcessStart:child=>{started=true;record.status='running';record.pid=child.pid??null;this.save();},onProcessOutput:observe,onProcessClose:finish}).catch(async error=>{record.observation=error.code==='native_timeout'?'timeout':'observation-error';this.save();if(!started)await finish({});});
  return this.list(null,{id}).items[0];
 }
 wait(id){return this.pending.get(id)??Promise.resolve(this.records()[id]);}
}
