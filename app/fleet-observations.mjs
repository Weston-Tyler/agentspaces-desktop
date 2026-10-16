import {Peer,cbor,spaceIdLocal,wire,vote,capabilities} from '@agentspaces/client';
import {discoverFabricCards} from './fabric-discovery.mjs';

// The retained upstream namespace is intentional; this record is shared by the JVM adapters.
export const MODEL_USAGE_TOTAL='ai.badmonkey.agentspaces.springai.model.wire.ModelUsageTotal#v1';
const fields=['promptTokens','completionTokens','totalTokens'];
const count=value=>Number.isSafeInteger(value)&&value>=0;
const label=(value,max=200)=>typeof value==='string'&&value.length>0&&value.length<=max;
const present=dto=>{
 const removed=new Set((dto.removes??[]).map(dot=>JSON.stringify([dot.replica,dot.counter])));
 return (dto.adds??[]).some(dot=>!removed.has(JSON.stringify([dot.replica,dot.counter])));
};
function options({space,now=Date.now(),limit=1000}={}){
 if(space!==undefined&&(!label(space,200)||/[\x00-\x1f]/.test(space)))throw Error('Explicit fleet observation space required');
 if(!count(now)||!Number.isInteger(limit)||limit<1||limit>1000)throw Error('Fleet observation limit must be 1–1000 and time must be valid');
 return {space,now,limit};
}
function coverage(truncated=false,rejectedRecords=0){return {complete:false,fleetSize:null,truncated,rejectedRecords,scanned:0,payloadBytes:0,scope:'Locally observed live signed records; disconnected, missing and expired publishers are unknown'};}

// Reuse upstream snapshot authentication for both immutable records and mutable lease state.
// This isolated verifier has no socket, publishers, timers, private source catalog, or model route.
function selected(peer,space,types,now,limit){
 if(!peer)return {states:new Map(),coverage:coverage()};
 const verifier=new Peer(peer.identity,peer.group,()=>now);verifier.founding=peer.founding;
 verifier.revocations.restoreSigned(peer.revocations.exportSigned(),now);
 const target=spaceIdLocal(`${peer.group}/${space}`);let seen=0,rejected=0,truncated=false,scanned=0,payloadBytes=0;
 for(const [entryId,dto] of peer.states){
  if(scanned>=10000){truncated=true;break;}scanned++;
  const record=dto?.record;
  if(!record||record.spaceId!==target||!types.has(record.type)||(record.group!==undefined&&record.group!==peer.group))continue;
  if(seen++>=limit){truncated=true;break;}
  // Invalid payloads consume the same byte budget as valid records. A read must
  // not monopolize the companion while native delivery is waiting to progress.
  const bytes=record.payload instanceof Uint8Array?record.payload.byteLength:0;
  if(payloadBytes+bytes>1024*1024){truncated=true;break;}payloadBytes+=bytes;
  try{
   if(!(record.payload instanceof Uint8Array)||record.payload.length>65536)throw Error('bounded payload required');
   verifier.restoreSnapshot({group:peer.group,states:[dto],claims:peer.claims.has(entryId)?{[entryId]:peer.claims.get(entryId)}:{}});
   const verified=verifier.states.get(entryId);
   if(!verified){rejected++;continue;}
   const expires=Number(verified.leaseValue?.expiresAtMillis??verified.record.lease?.expiresAtMillis);
   if(verified.completed||!Number.isSafeInteger(expires)||expires<=now||!present(verified))verifier.states.delete(entryId);
  }catch{verifier.states.delete(entryId);rejected++;}
 }
 return {states:verifier.states,coverage:{...coverage(truncated,rejected),scanned,payloadBytes,maxExaminedRecords:10000,maxPayloadBytes:1024*1024}};
}
export function fleetUsageView(peer,input={}){
 const {space,now,limit}=options(input);
 const base={enabled:space!==undefined,connected:!!peer?.connected(),observedAt:now,space:space??null,combinedNativeTotal:null,billing:null,weeklyQuota:null,modelCalls:0,coverage:coverage(),observations:[],models:[]};
 if(!space||!peer)return base;
 const result=selected(peer,space,new Set([MODEL_USAGE_TOTAL]),now,limit),issuers=new Map();
 for(const [entryId,dto] of result.states){
  try{
   const record=dto.record,value=cbor.loads(Buffer.from(record.payload)),issuer=record.issuer.split('/')[0],issuedAt=wire.hlcPhysical(record.issued);
   if(!label(value?.model)||value.peer!==issuer||!fields.every(field=>count(value[field]))||!count(value.sinceMillis)||value.sinceMillis>issuedAt||issuedAt>now)throw Error('invalid usage');
   const key=JSON.stringify([issuer,value.model]);if(!issuers.has(key))issuers.set(key,[]);
   issuers.get(key).push({entryId,issuer,model:value.model,sinceMillis:value.sinceMillis,issuedAt,issuedLogical:Number(String(record.issued).split(':')[1]),...Object.fromEntries(fields.map(field=>[field,value[field]]))});
  }catch{result.coverage.rejectedRecords++;}
 }
 for(const samples of issuers.values()){
  const epochs=[...new Set(samples.map(row=>row.sinceMillis))].sort((a,b)=>b-a),current=samples.filter(row=>row.sinceMillis===epochs[0]).sort((a,b)=>a.issuedAt-b.issuedAt||a.issuedLogical-b.issuedLogical||a.entryId.localeCompare(b.entryId));
  const chosen=current.at(-1),consistent=current.every((row,index)=>index===0||fields.every(field=>row[field]>=current[index-1][field]&&(row.totalTokens!==current[index-1].totalTokens||row[field]===current[index-1][field])));
  base.observations.push({...chosen,...(!consistent?Object.fromEntries(fields.map(field=>[field,null])):{}),reason:consistent?null:'non_monotone_counter',resetObserved:epochs.length>1,earlierEpochs:epochs.length-1,samples:current.length,provenance:'verified issuing peer; payload peer is checked against its signed identity'});
 }
 base.observations.sort((a,b)=>a.model.localeCompare(b.model)||a.issuer.localeCompare(b.issuer));
 for(const model of new Set(base.observations.map(row=>row.model))){
  const rows=base.observations.filter(row=>row.model===model),windows=new Set(rows.map(row=>row.sinceMillis));
  let reason=result.coverage.truncated?'truncated_observation':windows.size!==1?'different_counter_windows':rows.some(row=>row.reason)?'ambiguous_counter':null;
  const sums=Object.fromEntries(fields.map(field=>[field,rows.reduce((sum,row)=>sum+(row[field]??0),0)]));
  if(!reason&&!fields.every(field=>count(sums[field])))reason='unsafe_integer_sum';
  base.models.push({model,observedIssuers:rows.length,sinceMillis:windows.size===1?rows[0].sinceMillis:null,...Object.fromEntries(fields.map(field=>[field,reason?null:sums[field]])),reason,complete:false});
 }
 base.coverage=result.coverage;return base;
}

export function fleetAdvisoryView(peer,input={}){
 const {space,now,limit}=options(input),base={enabled:space!==undefined,connected:!!peer?.connected(),observedAt:now,space:space??null,proposals:[],coverage:coverage(),authority:'Advisory only; never owner approval, native permission, or machine reservation',modelCalls:0};
 if(!space||!peer)return base;
 const result=selected(peer,space,new Set([vote.PROPOSAL_TYPE,vote.BALLOT_TYPE]),now,limit),safe=new Map(),counts=new Map();
 for(const [id,dto] of result.states){
  try{
   const value=cbor.loads(Buffer.from(dto.record.payload));
   if(!label(value?.proposalId,300))throw Error('invalid proposal');
   if(dto.record.type===vote.PROPOSAL_TYPE){
    if(!label(value.question,4000)||!Array.isArray(value.options)||value.options.length<1||value.options.length>32||!value.options.every(option=>label(option,200))||new Set(value.options).size!==value.options.length||!Number.isSafeInteger(value.quorum)||value.quorum<1)throw Error('invalid proposal');
    counts.set(value.proposalId,(counts.get(value.proposalId)??0)+1);
   }else if(!label(value.option,200)||value.voter!==dto.record.issuer)throw Error('invalid ballot');
   safe.set(id,dto);
  }catch{result.coverage.rejectedRecords++;}
 }
 for(const proposal of vote.proposals(safe).values()){
  const ambiguous=counts.get(proposal.proposalId)!==1,decision=ambiguous||result.coverage.truncated?null:vote.decision(safe,proposal.proposalId,'PEER');
  base.proposals.push({...proposal,tally:Object.fromEntries(vote.tally(safe,proposal.proposalId,proposal.options,'PEER')),granularity:'PEER',winner:decision?.winner??null,ambiguous,ownerApproval:false,complete:false});
 }
 base.coverage=result.coverage;return base;
}

// verifiedDiscovery is an internal trusted-call argument, never HTTP/tool input.
export function fleetSemanticView(peer,{enabled=false,query='',now=Date.now(),limit=20}={},verifiedDiscovery){
 if(typeof enabled!=='boolean'||typeof query!=='string'||query.length>2000||!count(now)||!Number.isInteger(limit)||limit<1||limit>100)throw Error('Invalid local semantic observation query');
 const result={enabled,connected:!!peer?.connected(),observedAt:now,matches:[],coverage:coverage(),querySentRemotely:false,modelCalls:0,method:'upstream hashing cosine; local signed-advertisement cache only'};
 if(!enabled||!peer||!query.trim())return result;
 const discovered=verifiedDiscovery??discoverFabricCards(peer,{now,limit:200}),embedder=new capabilities.HashingEmbedder(),vector=embedder.embed(query);
 result.coverage.truncated=discovered.truncated;result.coverage.rejectedRecords=discovered.rejected;
 result.coverage.scanned=discovered.coverage?.scanned??discovered.cards.length;
 result.coverage.payloadBytes=discovered.coverage?.signedBytes??0;
 for(const card of discovered.cards){
  try{
   const score=capabilities.cosine(vector,embedder.embed(capabilities.textOf('AgentCard',card)));
   if(Number.isFinite(score)&&score>=0.2)result.matches.push({id:card.id,type:'AgentCard',issuer:card.peerId,score,expiresAt:card.expiresAt,description:card.description,nativeReachability:'unknown',executionStarted:false});
  }catch{result.coverage.rejectedRecords++;}
 }
 result.matches.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));result.coverage.truncated ||= result.matches.length>limit;result.matches=result.matches.slice(0,limit);return result;
}
