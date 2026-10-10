import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {NativeBootstrapChannel} from '../app/native-bootstrap-channel.mjs';
import {channelLaunchOptIn} from '../app/native-session-hook.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
class Socket extends EventEmitter{static calls=[];constructor(url,options){super();Socket.calls.push({url,options,socket:this});}terminate(){this.terminated=true;}}
const binding={nativeThreadId:'00000000-0000-4000-8000-000000000001',channelOptIn:true,config:{address:'http://127.0.0.1:41234',authority:'127.0.0.1:43127',token:'synthetic-capability'}};
test('managed channel launch opt-in must name this exact MCP server',()=>{
 assert.equal(channelLaunchOptIn(['claude','--dangerously-load-development-channels','server:agentspaces-desktop']),true);
 assert.equal(channelLaunchOptIn(['claude','--dangerously-load-development-channels','server:other']),false);
 assert.equal(channelLaunchOptIn(['claude','--prompt','server:agentspaces-desktop']),false);
});
test('tools-only setup never reports an inbound channel and never opens a socket',async()=>{
 Socket.calls=[];const c=new NativeBootstrapChannel({resolveBinding:async()=>({...binding,channelOptIn:false}),notify:async()=>{},WebSocketClass:Socket});
 assert.equal((await c.ensure()).status,'native-opt-in-required');assert.equal(c.health().transportConnected,false);assert.equal(Socket.calls.length,0);c.close();
});
test('opted-in channel binds one source, preserves tunnel authority and stops forwarding after identity changes',async()=>{
 Socket.calls=[];let current=binding;const received=[];
 const c=new NativeBootstrapChannel({resolveBinding:async()=>current,notify:async value=>received.push(value),WebSocketClass:Socket});
 assert.equal((await c.ensure()).transportConnected,false);const {socket,options}=Socket.calls[0];assert.equal(options.headers.Host,binding.config.authority);
 socket.emit('open');assert.equal(c.health().transportConnected,true);assert.equal(c.health().nativeAcceptance,'not-attested');
 socket.emit('message',JSON.stringify({content:'Synthetic room update',meta:{request_id:'synthetic-request'}}));await tick();assert.equal(received.length,1);
 current={...binding,nativeThreadId:'00000000-0000-4000-8000-000000000002'};socket.emit('message',JSON.stringify({content:'Wrong recipient',meta:{request_id:'different-request'}}));await tick();
 assert.equal(received.length,1);assert.equal(socket.terminated,true);assert.equal(c.health().transportConnected,false);c.close();
});
test('disconnection reconnects transport with a fresh binding and does not replay prior notifications',async()=>{
 Socket.calls=[];let lookups=0;const received=[];
 const c=new NativeBootstrapChannel({resolveBinding:async()=>{lookups++;return binding;},notify:async v=>received.push(v),WebSocketClass:Socket,retryMinMs:1});
 await c.ensure();const first=Socket.calls[0].socket;first.emit('open');first.emit('message',JSON.stringify({content:'Once',meta:{request_id:'once'}}));await tick();first.emit('close');
 await new Promise(r=>setTimeout(r,10));assert.equal(Socket.calls.length,2);assert.ok(lookups>=3);assert.equal(c.health().transportConnected,false);Socket.calls[1].socket.emit('open');assert.equal(received.length,1);c.close();
});
test('lost identity or withdrawn native opt-in closes an existing transport before reporting unavailable',async()=>{
 for(const failure of ['identity','opt-in']){
  Socket.calls=[];let available=true;const received=[];
  const c=new NativeBootstrapChannel({resolveBinding:async()=>{if(!available&&failure==='identity')throw Error('private lifecycle path');return {...binding,channelOptIn:available};},notify:async v=>received.push(v),WebSocketClass:Socket,retryMinMs:10000});
  await c.ensure();const socket=Socket.calls[0].socket;socket.emit('open');available=false;
  if(failure==='identity'){socket.emit('message',JSON.stringify({content:'Must not deliver',meta:{request_id:'denied'}}));await tick();}else await c.ensure();
  assert.equal(socket.terminated,true);assert.equal(c.health().transportConnected,false);assert.equal(received.length,0);assert.ok(!JSON.stringify(c.health()).includes('private'));c.close();
 }
});
test('closing during source lookup cannot open a late inbound connection',async()=>{
 Socket.calls=[];let resolve;const lookup=new Promise(r=>{resolve=r;});
 const c=new NativeBootstrapChannel({resolveBinding:()=>lookup,notify:async()=>{},WebSocketClass:Socket});const pending=c.ensure();c.close();resolve(binding);await pending;assert.equal(Socket.calls.length,0);assert.equal(c.health().status,'closed');
});
