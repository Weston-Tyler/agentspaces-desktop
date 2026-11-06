import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { answerCodexSide } from '../app/codex-side-chat.mjs';

const parentId='11111111-2222-4333-8444-555555555555', childId='66666666-7777-4888-8999-000000000000';
const turnId='01111111-2222-4333-8444-555555555555', cwd='/synthetic';
function fixture({foreign=false,wrongChild=false,afterFork,loseReply=false,withMcp=false}={}){
  const events=new EventEmitter(),calls=[];
  const adapter={events,async request(method,params){
    calls.push({method,params});
    if(method==='thread/read')return {thread:{id:parentId,cwd,status:{type:'active'}}};
    if(method==='config/read')return {config:{mcp_servers:{sample:{}}}};
    if(method==='thread/fork'){
      afterFork?.();
      return {thread:{id:wrongChild?parentId:childId,ephemeral:true,forkedFromId:parentId,cwd},cwd,sandbox:{type:'readOnly'},approvalPolicy:'never'};
    }
    if(method==='mcpServerStatus/list')return {data:withMcp?[{name:'configured-provider'}]:[],nextCursor:null};
    if(method==='turn/start'){
      if(loseReply)throw new Error('Disconnected after request');
      const item=(threadId,text)=>events.emit('notification',{method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',text,phase:'final_answer'}}});
      if(!foreign)item(childId,'Side answer');
      item(parentId,'Private main task answer');
      events.emit('notification',{method:'turn/completed',params:{threadId:childId,turn:{id:turnId,status:'completed'}}});
      return {turn:{id:turnId,status:'inProgress'}};
    }
    if(method==='thread/unsubscribe')return {};
    throw new Error('Unexpected native request');
  }};
  return {adapter,calls};
}
function run(adapter, options={}) {
  return answerCodexSide(adapter,{parentId,cwd,question:'What did the fixture prove?',timeoutMs:1000,fence(){},beforeStart(){},...options});
}

test('native side answer correlates the exact ephemeral child and ignores parent output', async()=>{
  const {adapter,calls}=fixture();
  const result=await run(adapter,{beforeStart(id){assert.equal(id,childId);assert.equal(calls.length,4);}});
  assert.deepEqual(result,{parentId,childId,nativeTurnId:turnId,text:'Side answer',usage:{known:false}});
  assert.deepEqual(calls.map(({method,params})=>[method,params.threadId]),
    [['thread/read',parentId],['config/read',undefined],['thread/fork',parentId],['mcpServerStatus/list',childId],['turn/start',childId],['thread/unsubscribe',childId]]);
  assert.equal(calls[2].params.ephemeral,true);
  assert.equal(calls[2].params.excludeTurns,true);
  assert.equal(calls[2].params.sandbox,'read-only');
  assert.equal(calls[2].params.approvalPolicy,'never');
  assert.deepEqual(calls[2].params.config.mcp_servers,{sample:{enabled:false,required:false}});
  assert.equal(adapter.events.listenerCount('notification'),0);
});
test('a main thread response cannot substitute for the ephemeral answer',async()=>{
  const {adapter}=fixture({foreign:true});
  await assert.rejects(run(adapter),/native_side_answer_unavailable/);
});
test('side chat refuses a parent handle returned as a child',async()=>{
  const {adapter,calls}=fixture({wrongChild:true});
  await assert.rejects(run(adapter),/native_side_policy_not_verified/);
  assert.deepEqual(calls.map(row=>row.method),['thread/read','config/read','thread/fork']);
});
test('grant revocation before submission drops the ephemeral child without starting a turn',async()=>{
  let granted=true;const {adapter,calls}=fixture({afterFork(){granted=false;}});
  await assert.rejects(run(adapter,{fence(){if(!granted)throw Error('grant revoked');}}),/grant revoked/);
  assert.deepEqual(calls.map(row=>row.method),['thread/read','config/read','thread/fork','thread/unsubscribe']);
});
test('uncertain submission only detaches the ephemeral child observation',async()=>{
  const {adapter,calls}=fixture({loseReply:true});
  await assert.rejects(run(adapter),/Disconnected/);
  assert.deepEqual(calls.slice(-2).map(({method,params})=>[method,params.threadId]),
    [['turn/start',childId],['thread/unsubscribe',childId]]);
});

test('a child with an inherited MCP server never submits a model turn',async()=>{
 const {adapter,calls}=fixture({withMcp:true});
 await assert.rejects(run(adapter),/native_side_external_tools_not_disabled/);
 assert.deepEqual(calls.map(row=>row.method),['thread/read','config/read','thread/fork','mcpServerStatus/list','thread/unsubscribe']);
});
