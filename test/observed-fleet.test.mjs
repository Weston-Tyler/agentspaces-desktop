import test from 'node:test';
import assert from 'node:assert/strict';
import { configureFleetObservations, observedFleet } from '../app/observed-fleet.mjs';
const engine=()=>({fabricProject:'demo',clock:()=>1800000000000,fabric:{peer:null,diagnostics:()=>({wireVersion:3}),discovery:()=>({cards:[]})},session:id=>({id,project:id==='outside'?'other':'demo',fixture:id!=='native'}),permissions:source=>({enrolled:true,retrieve:source.id!=='revoked'})});
test('fleet observations are off by default and require explicit bounded connect options',()=>{
 const e=engine();assert.equal(observedFleet(e).usage.enabled,false);
 e.fabricObservationOptions=configureFleetObservations({usage:'metrics',advisory:'votes',semantic:true});
 const view=observedFleet(e,{query:'summarize',limit:20});assert.equal(view.usage.enabled,true);assert.equal(view.advisory.enabled,true);assert.equal(view.semantic.enabled,true);
 for(const options of [{usage:'../secrets'},{other:'x'},{semantic:'true'},{usage:'x'.repeat(201)}])assert.throws(()=>configureFleetObservations(options),/observation/);
 assert.throws(()=>observedFleet(e,{limit:101}),/observation/);
});
test('cached fleet data respects exact fixture project, current grants and native separation',()=>{
 const e=engine();assert.doesNotThrow(()=>observedFleet(e,{}, {sessionId:'permitted'}));
 for(const id of ['outside','native','revoked'])assert.throws(()=>observedFleet(e,{}, {sessionId:id}),/scope denied/);
 assert.throws(()=>observedFleet(e,{scope:'other'}),/observation/);
});
test('large signed discovery projections cannot recreate oversized scoped responses',()=>{
 const e=engine();e.fabric.discovery=()=>({cards:Array.from({length:100},(_,i)=>({id:String(i),description:'x'.repeat(6000)})),coverage:{complete:false}});
 const value=observedFleet(e);assert.ok(Buffer.byteLength(JSON.stringify(value))<=512*1024);assert.equal(value.response.truncated,true);assert.equal(value.discovery.truncated,true);
});
