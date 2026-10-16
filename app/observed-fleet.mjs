import {fleetUsageView,fleetAdvisoryView,fleetSemanticView} from './fleet-observations.mjs';
// Runtime-only opt-in: a new connection/restart starts with no observation spaces.
// These names never cause native history, metadata or reports to be published.
export function configureFleetObservations(input={}) {
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['usage','advisory','semantic'].includes(key)))throw Error('Invalid fleet observation options');
 const options={};
 for(const key of ['usage','advisory'])if(input[key]!==undefined){
  if(typeof input[key]!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(input[key])||input[key].includes('..'))throw Error('Invalid fleet observation space');
  options[key]=input[key];
 }
 if(input.semantic!==undefined&&typeof input.semantic!=='boolean')throw Error('Invalid semantic observation option');
 options.semantic=input.semantic===true;return Object.freeze(options);
}
export function observedFleet(engine,input={},binding=null) {
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['query','limit'].includes(key)))throw Error('Invalid fleet observation query');
 const {query='',limit=100}=input;
 if(typeof query!=='string'||query.length>500||!Number.isInteger(limit)||limit<1||limit>100)throw Error('Invalid fleet observation query');
 if(binding){
  const source=engine.session(binding.sessionId),grant=engine.permissions(source);
  if(!source.fixture||source.project!==engine.fabricProject||!grant.enrolled||!grant.retrieve)throw Error('Fabric observation scope denied');
 }
 const options=engine.fabricObservationOptions??{},peer=engine.fabric.peer,now=engine.clock();
 const verifiedDiscovery=engine.fabric.discovery({limit:200});
 const matchedCards=verifiedDiscovery.cards.filter(card=>!query||`${card.description} ${(card.goals??[]).join(' ')} ${(card.consumes??[]).join(' ')} ${(card.produces??[]).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
 const discovery={...verifiedDiscovery,cards:matchedCards.slice(0,limit),truncated:verifiedDiscovery.truncated||matchedCards.length>limit};
 const result = {health:engine.fabric.diagnostics(),discovery,
  usage:fleetUsageView(peer,{space:options.usage,now,limit}),advisory:fleetAdvisoryView(peer,{space:options.advisory,now,limit}),
  semantic:fleetSemanticView(peer,{enabled:options.semantic===true,query,limit,now},verifiedDiscovery),
  aggregate:{supported:false,reason:'Active aggregation exchange is not enabled by this read-only view.'},
  nativeDeliverySeparate:true,modelCalls:0,publishesLocalMetadata:false,response:{byteLimit:512*1024,truncated:false}};
 // Bound each collection before sending through native scoped transports. No
 // content is deleted from the owning peer; omitted observations are explicit.
 for(const [section,key] of [['discovery','cards'],['usage','observations'],['usage','models'],['advisory','proposals'],['semantic','matches']]){
  const view=result[section],rows=view[key];let bytes=0,keep=0;
  for(const row of rows){bytes+=Buffer.byteLength(JSON.stringify(row))+1;if(bytes>96*1024)break;keep++;}
  if(keep<rows.length){view[key]=rows.slice(0,keep);view.truncated=true;if(view.coverage)view.coverage.truncated=true;result.response.truncated=true;}
 }
 if(result.usage.truncated)for(const model of result.usage.models){model.promptTokens=null;model.completionTokens=null;model.totalTokens=null;model.reason='response_truncated';}
 if(Buffer.byteLength(JSON.stringify(result))>result.response.byteLimit)throw Error('fabric_observation_response_too_large');
 return result;
}
