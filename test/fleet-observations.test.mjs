import test from 'node:test';
import assert from 'node:assert/strict';
import {Identity,Peer,cbor,vote,wire} from '@agentspaces/client';
import {fleetUsageView,fleetAdvisoryView,fleetSemanticView,MODEL_USAGE_TOTAL} from '../app/fleet-observations.mjs';
import {discoverFabricCards} from '../app/fabric-discovery.mjs';
const NOW=1800000000000;
const makePeer=()=>new Peer(Identity.generate(),'synthetic-fleet',()=>NOW);
const usage=(peer,values={},space='metrics')=>peer.writeEntry(space,MODEL_USAGE_TOTAL,{model:'synthetic-model',peer:peer.identity.peerId,promptTokens:7,completionTokens:3,totalTokens:10,sinceMillis:NOW-1000,...values},'meter',60000);
test('observations are disabled until an explicit space is selected and never combine native or billing totals',()=>{
 const peer=makePeer();usage(peer);
 assert.equal(fleetUsageView(peer).enabled,false);
 const view=fleetUsageView(peer,{space:'metrics',now:NOW});
 assert.equal(view.observations.length,1);assert.equal(view.models[0].totalTokens,10);
 assert.equal(view.combinedNativeTotal,null);assert.equal(view.billing,null);assert.equal(view.weeklyQuota,null);
 assert.equal(view.coverage.complete,false);assert.equal(view.coverage.fleetSize,null);
});
test('signed issuer dedup preserves counter epochs and never sums replicas or earlier resets',()=>{
 const peer=makePeer();usage(peer);usage(peer);usage(peer,{promptTokens:14,completionTokens:6,totalTokens:20});
 let view=fleetUsageView(peer,{space:'metrics',now:NOW});
 assert.equal(view.observations.length,1);assert.equal(view.observations[0].totalTokens,20);assert.equal(view.models[0].totalTokens,20);
 usage(peer,{sinceMillis:NOW-500,promptTokens:1,completionTokens:1,totalTokens:2});
 view=fleetUsageView(peer,{space:'metrics',now:NOW});
 assert.equal(view.observations[0].totalTokens,2);assert.equal(view.observations[0].resetObserved,true);assert.equal(view.observations[0].earlierEpochs,1);
});
test('payload peer spoofing, malformed counters, unknown scope, expired and forged records never enter usage',()=>{
 const peer=makePeer();usage(peer,{peer:'pretended-issuer'});usage(peer,{totalTokens:-1});usage(peer,{},'private-other');
 const expired=usage(peer);peer.states.get(expired).leaseValue.expiresAtMillis=NOW-1;
 const forged=usage(peer);peer.states.get(forged).record.payload=cbor.dumps({model:'forged',peer:peer.identity.peerId,promptTokens:1,completionTokens:1,totalTokens:2,sinceMillis:NOW-1000});
 const view=fleetUsageView(peer,{space:'metrics',now:NOW});assert.equal(view.observations.length,0);assert(view.coverage.rejectedRecords>=3);
});
test('different issuer windows and bounded reads explicitly withhold a comparable aggregate',()=>{
 const a=makePeer(),b=makePeer();usage(a);usage(b,{sinceMillis:NOW-2000});a.restoreSnapshot(b.exportSnapshot());
 const view=fleetUsageView(a,{space:'metrics',now:NOW});assert.equal(view.observations.length,2);assert.equal(view.models[0].totalTokens,null);assert.equal(view.models[0].reason,'different_counter_windows');
 const bounded=fleetUsageView(a,{space:'metrics',now:NOW,limit:1});assert.equal(bounded.coverage.truncated,true);assert.equal(bounded.models[0].totalTokens,null);
});
test('regressed components in one counter epoch remain unknown and unsafe sums never round',()=>{
 const peer=makePeer();usage(peer);usage(peer,{promptTokens:6,completionTokens:5,totalTokens:11});
 const view=fleetUsageView(peer,{space:'metrics',now:NOW});assert.equal(view.observations[0].totalTokens,null);assert.equal(view.observations[0].reason,'non_monotone_counter');
 const a=makePeer(),b=makePeer();usage(a,{promptTokens:Number.MAX_SAFE_INTEGER,completionTokens:0,totalTokens:Number.MAX_SAFE_INTEGER});usage(b,{promptTokens:1,completionTokens:0,totalTokens:1});a.restoreSnapshot(b.exportSnapshot());
 assert.equal(fleetUsageView(a,{space:'metrics',now:NOW}).models[0].totalTokens,null);
});
test('later cumulative regressions without a new epoch are not presented as valid totals',()=>{
 const peer=makePeer();usage(peer,{promptTokens:14,completionTokens:6,totalTokens:20});usage(peer);
 const view=fleetUsageView(peer,{space:'metrics',now:NOW});assert.equal(view.observations[0].totalTokens,null);assert.equal(view.models[0].reason,'ambiguous_counter');
});
test('signed removals and expired leases stay absent; a forged renewal cannot resurrect usage',()=>{
 const peer=makePeer(),removed=usage(peer),expired=usage(peer),forged=usage(peer);
 const removedState=peer.states.get(removed);peer.states.set(removed,wire.signState({...removedState,removes:removedState.adds},peer.identity));
 for(const id of [expired,forged]){const dto=peer.states.get(id);peer.states.set(id,wire.signState({...dto,leaseValue:{...dto.leaseValue,expiresAtMillis:NOW-1}},peer.identity));}
 peer.states.get(forged).leaseValue.expiresAtMillis=NOW+60000;
 const view=fleetUsageView(peer,{space:'metrics',now:NOW});assert.equal(view.observations.length,0);assert.equal(view.coverage.rejectedRecords,1);
});
test('malformed or colliding advisory proposals cannot produce a winner',()=>{
 const peer=makePeer();vote.propose(peer,'votes','proposal-1','Synthetic option?',['yes','no'],1);vote.cast(peer,'votes','proposal-1','yes');
 peer.writeEntry('votes',vote.PROPOSAL_TYPE,{proposalId:'proposal-1',question:'Competing definition?',options:['yes','no'],quorum:1});
 peer.writeEntry('votes',vote.PROPOSAL_TYPE,{proposalId:'malformed',question:'Invalid options',options:'yes',quorum:1});
 const view=fleetAdvisoryView(peer,{space:'votes',now:NOW});assert.equal(view.proposals.length,1);assert.equal(view.proposals[0].ambiguous,true);assert.equal(view.proposals[0].winner,null);assert.equal(view.coverage.rejectedRecords,1);
});
test('advisory votes use upstream peer dedup, space and lease bounds without approval authority',()=>{
 const peer=makePeer();vote.propose(peer,'votes','proposal-1','Synthetic option?',['yes','no'],1);vote.cast(peer,'votes','proposal-1','yes');vote.cast(peer,'votes','proposal-1','no',60000,null,'other-name');
 vote.propose(peer,'elsewhere','private-proposal','Private question',['yes'],1);
 const view=fleetAdvisoryView(peer,{space:'votes',now:NOW});assert.equal(view.proposals.length,1);assert.deepEqual(view.proposals[0].tally,{yes:1,no:0});assert.equal(view.proposals[0].ownerApproval,false);assert.equal(view.proposals[0].winner,'yes');
 const bounded=fleetAdvisoryView(peer,{space:'votes',now:NOW,limit:1});assert.equal(bounded.proposals[0].winner,null);assert.equal(bounded.coverage.truncated,true);
});
test('semantic ranking stays local, disabled by default, rejects tampering and expired cards',()=>{
 const peer=makePeer(),now=new Date(NOW).toISOString();
 peer.publishAd('AgentCard',{id:`aspace://${peer.group}/agent/${peer.identity.peerId}/fixture`,agent:`${peer.identity.peerId}/fixture`,group:peer.group,issuer:peer.identity.peerId,issued:now,ttl:'PT1H',description:'synthetic recipe kitchen',goals:[],consumes:[],produces:[],actions:[]});
 peer.send=()=>{throw Error('No remote query or model call permitted');};
 assert.equal(fleetSemanticView(peer,{query:'recipe',now:NOW}).enabled,false);
 const view=fleetSemanticView(peer,{enabled:true,query:'recipe',now:NOW});assert.equal(view.matches.length,1);assert.equal(view.modelCalls,0);assert.equal(view.querySentRemotely,false);assert.equal(view.matches[0].nativeThreadId,undefined);
 const ad=peer.ads.values().next().value;ad.stored.signature=new Uint8Array(64);
 assert.equal(fleetSemanticView(peer,{enabled:true,query:'recipe',now:NOW}).matches.length,0);
});
test('semantic requested-limit truncation is explicit even when discovery cache fits its own bound',()=>{
 const peer=makePeer();
 for(let i=0;i<3;i++)peer.publishAd('AgentCard',{id:`aspace://${peer.group}/agent/${peer.identity.peerId}/fixture-${i}`,agent:`${peer.identity.peerId}/fixture-${i}`,group:peer.group,issuer:peer.identity.peerId,issued:new Date(NOW).toISOString(),ttl:'PT1H',description:'synthetic recipe kitchen',goals:[],consumes:[],produces:[],actions:[]});
 const short=fleetSemanticView(peer,{enabled:true,query:'recipe',now:NOW,limit:1});
 assert.equal(short.matches.length,1);assert.equal(short.coverage.truncated,true);
 const full=fleetSemanticView(peer,{enabled:true,query:'recipe',now:NOW,limit:3});
 assert.equal(full.matches.length,3);assert.equal(full.coverage.truncated,false);
});
test('all observation health reflects socket connectivity while disconnected cached usage remains readable',()=>{
 const peer=makePeer();usage(peer);
 const views=()=>[fleetUsageView(peer,{space:'metrics',now:NOW}),fleetAdvisoryView(peer,{space:'votes',now:NOW}),fleetSemanticView(peer,{enabled:true,now:NOW})];
 assert(views().every(view=>view.connected===false));assert.equal(views()[0].observations.length,1);
 peer.connected=()=>true;assert(views().every(view=>view.connected===true));
 peer.connected=()=>false;assert(views().every(view=>view.connected===false));assert.equal(views()[0].observations.length,1);
});
test('usage scans stop after bounded unrelated records and withhold incomplete sums',()=>{
 const peer=makePeer();usage(peer);
 for(let i=0;i<10000;i++)peer.states.set(`unrelated-${i}`,{record:{type:'unrelated',spaceId:'elsewhere'}});
 const view=fleetUsageView(peer,{space:'metrics',now:NOW});
 assert.equal(view.coverage.scanned,10000);assert.equal(view.coverage.truncated,true);assert.equal(view.models[0].totalTokens,null);
});
test('invalid matching payloads consume the cumulative read budget before signature checks',()=>{
 const peer=makePeer(),entry=usage(peer),sample=peer.states.get(entry),payload=new Uint8Array(65536);
 for(let i=0;i<20;i++)peer.states.set(`forged-${i}`,{...sample,record:{...sample.record,entryId:`forged-${i}`,payload}});
 const view=fleetUsageView(peer,{space:'metrics',now:NOW});
 assert.equal(view.coverage.truncated,true);assert(view.coverage.payloadBytes<=1024*1024);assert(view.coverage.scanned<20);assert.equal(view.models[0].totalTokens,null);
});
test('semantic ranking can reuse the internal verified discovery result without rescanning advertisements',()=>{
 const peer=makePeer();peer.publishAd('AgentCard',{id:`aspace://${peer.group}/agent/${peer.identity.peerId}/fixture`,agent:`${peer.identity.peerId}/fixture`,group:peer.group,issuer:peer.identity.peerId,issued:new Date(NOW).toISOString(),ttl:'PT1H',description:'synthetic recipe kitchen',goals:[],consumes:[],produces:[],actions:[]});
 const verified=discoverFabricCards(peer,{now:NOW,limit:200});
 peer.ads.values=()=>{throw Error('Verified discovery must be reused');};
 const result=fleetSemanticView(peer,{enabled:true,query:'recipe',now:NOW},verified);
 assert.equal(result.matches.length,1);assert.equal(result.coverage.truncated,false);
});
