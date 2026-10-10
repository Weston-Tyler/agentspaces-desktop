import test from 'node:test';import assert from 'node:assert/strict';import { EventEmitter } from 'node:events';import { PassThrough } from 'node:stream';import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';import { tmpdir } from 'node:os';import { join } from 'node:path';
import { Store } from '../app/store.mjs';import { Engine } from '../app/engine.mjs';import { HeadlessJobs } from '../app/headless-jobs.mjs';
async function fixture(t){const root=mkdtempSync(join(tmpdir(),'as-headless-'));const engine=new Engine(new Store(root),{diagnostics:()=>({}),close(){}});engine.workspace.index={profile:{id:'scope',account:'owner',active:true,policy:'local-retrieval'}};let calls=0;const children=[];
 const jobs=new HeadlessJobs(engine,{spawnProcess:(_file,args,options)=>{calls++;const child=new EventEmitter();child.pid=1000+calls;child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kills=0;child.kill=()=>child.kills++;child.args=args;child.options=options;children.push(child);return child;},inspectProvider:async()=>({installed:true,adapterCompatible:true,version:'fixture'})});t.after(async()=>{for(const child of children)child.emit('close',0);await Promise.all(jobs.pending.values());await delay(10);rmSync(root,{recursive:true,force:true});});
 const work=await engine.workBoard.mutate({action:'create',deliveryId:'headless-create-01',title:'Brief job',brief:'Synthetic tests',repository:'https://example.invalid/repo',base:'a'.repeat(40),allowedFiles:'src/a.js'},null);
 return {root,engine,jobs,children,calls:()=>calls,input:{deliveryId:'headless-launch-01',provider:'codex',cwd:root,workEntryId:work.entryId,briefText:'Read the brief and report synthetic results.',budget:{observationMs:1000,maxTurns:3,maxCostUsd:1}}};}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('explicit owner launch claims owning work and preserves job identity, logs and final artifact',async t=>{const f=await fixture(t);const job=await f.jobs.launch(f.input,null);assert.equal(f.jobs.activeCount(),1);assert.equal((await f.jobs.launch(f.input,null)).id,job.id);assert.equal(f.calls(),1);const child=f.children[0];assert.deepEqual(child.args,['exec','--json','-']);child.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Synthetic final answer'}})+'\n');child.emit('close',0);await f.jobs.wait(job.id);assert.equal(f.jobs.activeCount(),0);const result=f.jobs.list(null,{id:job.id}).items[0];assert.equal(result.status,'finished');assert.ok(result.finalArtifactId);assert.match(f.jobs.log(null,{id:job.id}).text,/Synthetic final/);assert.equal(child.kills,0);});
test('agent launch, arbitrary arguments and another claim owner are denied before native spawn',async t=>{const f=await fixture(t);await assert.rejects(f.jobs.launch(f.input,{sessionId:'other'}),/owner/);await assert.rejects(f.jobs.launch({...f.input,args:['--dangerously-bypass-approvals-and-sandbox']},null),/field/);await assert.rejects(f.jobs.launch({...f.input,host:'remote'},null),/local/);assert.equal(f.calls(),0);});
test('observation timeout keeps active native process and closes only on actual native exit',async t=>{const f=await fixture(t);const job=await f.jobs.launch(f.input,null);await delay(1050);assert.equal(f.jobs.activeCount(),1);assert.equal(f.jobs.list(null,{id:job.id}).items[0].observation,'timeout');assert.equal(f.children[0].kills,0);f.children[0].stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Late final'}})+'\n');f.children[0].emit('close',0);await f.jobs.wait(job.id);assert.equal(f.jobs.list(null,{id:job.id}).items[0].status,'finished');});
test('restart preserves uncertain process outcome without spending again',async t=>{const f=await fixture(t);const job=await f.jobs.launch(f.input,null);const restarted=new HeadlessJobs(f.engine,{spawnProcess:()=>{throw Error('No replay');}});assert.equal(restarted.list(null,{id:job.id}).items[0].status,'outcome-unknown');assert.equal(restarted.activeCount(),1);assert.equal((await restarted.launch(f.input,null)).id,job.id);assert.equal(f.calls(),1);});

test('foreign work claim and update drain prohibit a process before spawning',async t=>{
 const f=await fixture(t);f.engine.discussions.participant=()=>({id:'peer',scopeId:'scope',account:'owner'});
 await f.engine.workBoard.mutate({action:'claim',entryId:f.input.workEntryId,deliveryId:'foreign-job-claim'}, {sessionId:'peer'});
 await assert.rejects(f.jobs.launch(f.input,null),/claim/);assert.equal(f.calls(),0);
 f.jobs.admitLaunch=()=>false;await assert.rejects(f.jobs.launch(f.input,null),/draining/);assert.equal(f.calls(),0);
});
test('Claude file brief uses native budget flags, keeps stderr private and reports nonzero exit',async t=>{
 const f=await fixture(t),path=join(f.root,'brief.md');writeFileSync(path,'Synthetic brief from explicitly selected file');
 const {briefText,...input}=f.input;const job=await f.jobs.launch({...input,provider:'claude',briefPath:path},null),child=f.children[0];
 assert.ok(child.args.includes('--max-turns'));assert.ok(child.args.includes('--max-budget-usd'));assert.ok(!child.args.some(arg=>arg.includes('skip-permissions')||arg==='--bare'));
 child.stderr.write('PRIVATE SYNTHETIC AUTH DIAGNOSTIC');child.stdout.write(JSON.stringify({type:'result',result:'Native failure explained',usage:{input_tokens:10,output_tokens:2}}));child.emit('close',1);await f.jobs.wait(job.id);
 const result=f.jobs.list(null,{id:job.id}).items[0];assert.equal(result.status,'died');assert.equal(result.usage.output_tokens,2);assert.ok(result.finalArtifactId);assert.ok(!f.jobs.log(null,{id:job.id}).text.includes('PRIVATE'));assert.equal(child.kills,0);
});


test('native spawn failure records died only at observed close and never cancels',async t=>{
 const f=await fixture(t),job=await f.jobs.launch(f.input,null),child=f.children[0];
 child.emit('error',new Error('Synthetic spawn failure'));await delay(10);assert.equal(f.jobs.activeCount(),1);assert.equal(child.kills,0);
 child.emit('close',-2);await f.jobs.wait(job.id);assert.equal(f.jobs.activeCount(),0);assert.equal(f.jobs.list(null,{id:job.id}).items[0].status,'died');assert.equal(child.kills,0);
});


test('native final report preserves UTF-8 across transport chunks',async t=>{
 const f=await fixture(t),job=await f.jobs.launch(f.input,null),child=f.children[0];
 const bytes=Buffer.from(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Synthetic café report'}})+'\n');const split=bytes.indexOf(Buffer.from('é'))+1;
 child.stdout.write(bytes.subarray(0,split));child.stdout.write(bytes.subarray(split));child.emit('close',0);await f.jobs.wait(job.id);
 const result=f.jobs.list(null,{id:job.id}).items[0],artifact=f.engine.workBoard.artifacts(null,{entryId:result.finalArtifactId});assert.match(artifact.items[0].value.artifact.text,/café report/);
});
