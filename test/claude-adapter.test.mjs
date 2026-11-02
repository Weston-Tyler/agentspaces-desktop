import test from 'node:test';
import assert from 'node:assert/strict';
import {readSdk} from '../app/claude-reader.mjs';
test('metadata and content require their actual pinned SDK methods and never fall through to model queries',async()=>{
 let models=0;const sdk={query(){models++;throw Error('No models');}},project={metadataGrant:true,allMetadataGrant:true,host:'local'};
 for(const action of ['list','info','read'])await assert.rejects(readSdk({action,project},sdk),/required read interface/);
 await assert.rejects(readSdk({action:'query',project},sdk),/Read-only helper refuses/);assert.equal(models,0);
});
test('metadata scope is checked before inspecting SDK capabilities',async()=>{
 await assert.rejects(readSdk({action:'list',project:{metadataGrant:false}},{}),/metadata grant/);
 const result=await readSdk({action:'list',project:{metadataGrant:true,allMetadataGrant:true}}, {listSessions:async()=>[]});assert.deepEqual(result.sessions,[]);
});
import {ClaudeReadAdapter} from '../app/claude-adapter.mjs';
import {REMOTE_HOST} from '../app/remote-host.mjs';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
test('Windows remote metadata uses overlapped SSH pipes, closes stdin and never opens a model',async()=>{
 let script='';const adapter=new ClaudeReadAdapter({host:REMOTE_HOST,platform:'win32',spawnProcess:(command,args,options)=>{
  assert.equal(command,'ssh');assert.deepEqual(options.stdio,['overlapped','overlapped','overlapped']);assert.equal(options.shell,false);
  const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.stdin=new PassThrough();c.kill=()=>{};c.stdin.on('data',x=>script+=x);c.stdin.on('finish',()=>queueMicrotask(()=>{c.stdout.write(JSON.stringify({sessions:[],nextCursor:null}));c.emit('close',0);}));return c;
 }});
 assert.deepEqual((await adapter.call({action:'list',project:{metadataGrant:true,allMetadataGrant:true,host:REMOTE_HOST}})).sessions,[]);assert(!script.includes('sdk.query('));adapter.close();
});
test('remote metadata preserves a native null result as unavailable rather than a parsing exception',async()=>{
 const adapter=new ClaudeReadAdapter({host:REMOTE_HOST,spawnProcess:()=>{
  const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.stdin=new PassThrough();c.kill=()=>{};c.stdin.on('finish',()=>queueMicrotask(()=>{c.stdout.write('null');c.emit('close',0);}));return c;
 }});assert.equal(await adapter.call({action:'info',nativeThreadId:'00000000-0000-4000-8000-000000000001',project:{metadataGrant:true,allMetadataGrant:true,host:REMOTE_HOST}}),null);adapter.close();
});
