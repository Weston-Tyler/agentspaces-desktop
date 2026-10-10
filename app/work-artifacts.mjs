import { cbor, spaceIdLocal } from '@agentspaces/client';
import { createHash } from 'node:crypto';
import { TYPES } from './fabric.mjs';
const SPACE='desktop-work-board',TTL=30*86400000;
const hash=text=>createHash('sha256').update(text).digest('hex');
export const artifactFields={artifact_create:['workEntryId','discussionId','messageId','name','text','mediaType','previousEntryId']};
function rows(b) {
 const sid=spaceIdLocal(`${b.group}/${SPACE}`),out=[];
 for(const [entryId,state] of b.peer.states){const r=state.record;if(r?.spaceId!==sid||r.type!==TYPES.finding)continue;
  const value=cbor.loads(Buffer.from(r.payload));if(value?.kind!=='lane-artifact')continue;
  out.push({entryId,issuer:r.issuer,hash:hash(Buffer.from(r.payload)),expiresAt:Number(state.leaseValue?.expiresAtMillis??r.lease.expiresAtMillis),value});
 }
 return out;
}
function work(b,id){const state=b.peer.states.get(id);if(state?.record?.type!==TYPES.request||state.record.spaceId!==spaceIdLocal(`${b.group}/${SPACE}`))throw Error('Unknown artifact work item');return state;}
function room(b,binding,discussionId,messageId) {
 if(!discussionId)return;
 const context=binding?b.engine.discussions.context(discussionId,binding):b.engine.discussions.view(b.engine.discussions.group(discussionId));
 if(context.available===false||!context.messages.some(message=>message.id===messageId))throw Error('Artifact room message unavailable');
}
function readable(b,row,binding){
 if(row.expiresAt<=b.engine.clock())throw Error('Artifact unavailable');
 const value=row.value;
 if(value.source.participantId!=='desktop-owner'){
  const source=b.engine.session(value.source.participantId),grant=b.engine.permissions(source),profile=b.engine.workspace.index.profile;
  if(!grant.enrolled||!grant.retrieve||!grant.share||source.account!==profile.account||source.scopeId!==profile.id||source.account!==value.source.account||source.project!==value.source.project||(source.nativeThreadId??null)!==value.source.threadId||source.provider!==value.source.provider||(source.host??'local')!==value.source.host||!b.engine.workspace.sessionAllowed(source))throw Error('Artifact author unavailable');
 }
 if(value.workEntryId)work(b,value.workEntryId);
 room(b,binding,value.discussionId,value.messageId);
 if(hash(value.artifact.text)!==value.artifact.digest||Buffer.byteLength(value.artifact.text)!==value.artifact.bytes)throw Error('Artifact hash mismatch');
}
export function checkArtifactReceipt(b,binding,entryId){const row=rows(b).find(row=>row.entryId===entryId);if(!row)throw Error('Artifact unavailable');readable(b,row,binding);}
export function artifactView(b,binding,options={}){
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['entryId','workEntryId','discussionId','limit'].includes(k)))throw Error('Invalid artifact query');
 const {limit=100}=options;if(!Number.isInteger(limit)||limit<1||limit>200)throw Error('Invalid artifact limit');
 for(const key of ['entryId','workEntryId','discussionId'])if(options[key]!==undefined&&(typeof options[key]!=='string'||!options[key]||options[key].length>100))throw Error('Invalid artifact identifier');
 b.access(binding);if(b.writing)throw Error('Work board is saving; refresh shortly');b.peer=null;b.open();b.access(binding);
 const filtered=rows(b).filter(row=>(!options.entryId||row.entryId===options.entryId)&&(!options.workEntryId||row.value.workEntryId===options.workEntryId)&&(!options.discussionId||row.value.discussionId===options.discussionId));
 const admitted=[];for(const row of filtered){try{readable(b,row,binding);admitted.push(row);}catch(error){if(options.entryId)throw error;}}
 if(options.entryId&&!admitted.length)throw Error('Artifact unavailable');
 admitted.sort((a,b)=>b.value.createdAt-a.value.createdAt||a.entryId.localeCompare(b.entryId));
 return {items:admitted.slice(0,limit).map(row=>options.entryId?row:{...row,value:{...row.value,artifact:{...row.value.artifact,text:undefined}}}),total:admitted.length,truncated:admitted.length>limit,authority:'AgentSpaces finding records in the companion-owned work replica',contentTrust:'untrusted source-authored evidence'};
}
export async function artifactChange(b,input,binding,actor,agent){
 const {name,text,mediaType='text/plain',workEntryId,discussionId,messageId,previousEntryId}=input;
 if(typeof name!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_. -]{0,119}$/.test(name)||name.includes('..'))throw Error('Artifact name must be a label, not a path');
 if(typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>16384)throw Error('Artifact text exceeds the 16 KiB bound');
 if(!['text/plain','text/markdown','application/json'].includes(mediaType))throw Error('Unsupported artifact media type');
 if(!workEntryId&&!discussionId)throw Error('Exact work or room message link required');
 for(const id of [workEntryId,discussionId,messageId,previousEntryId])if(id!==undefined&&(typeof id!=='string'||!id||id.length>100))throw Error('Invalid artifact identifier');
 if(!!discussionId!==!!messageId)throw Error('Room and exact message IDs required together');
 if(workEntryId){const state=work(b,workEntryId);if(state.completed)throw Error('Upload work artifacts before completion');b.peer.requireHeld(SPACE,workEntryId,agent);}
 room(b,binding,discussionId,messageId);
 const prior=rows(b).filter(row=>row.value.name===name&&row.value.source.participantId===actor&&(row.value.workEntryId??null)===(workEntryId??null)&&(row.value.discussionId??null)===(discussionId??null)&&(row.value.messageId??null)===(messageId??null)).sort((a,b)=>b.value.version-a.value.version)[0];
 if((prior?.entryId??undefined)!==previousEntryId)throw Error('Use the latest artifact entry as previousEntryId');
 const source=actor==='desktop-owner'?{participantId:actor,account:b.scope.account}:b.engine.session(actor);
 const version=(prior?.value.version??0)+1,value={kind:'lane-artifact',name,version,previousEntryId:prior?.entryId??null,workEntryId:workEntryId??null,discussionId:discussionId??null,messageId:messageId??null,createdAt:b.engine.clock(),
  source:{participantId:actor,threadId:source.nativeThreadId??null,provider:source.provider??'owner',host:source.host??'local',account:source.account,project:source.project??null,version:source.sourceVersion??'source-authored'},
  artifact:{text,mediaType,digest:hash(text),bytes:Buffer.byteLength(text)},trust:'untrusted source-authored evidence'};
 const entryId=b.peer.writeEntry(SPACE,TYPES.finding,value,'worker',TTL,agent);
 return {entryId,version,digest:value.artifact.digest,bytes:value.artifact.bytes};
}
