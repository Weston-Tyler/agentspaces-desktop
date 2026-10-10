import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('continuation inspection uses the configured remote identity without a live native route', t=>{
 const root=mkdtempSync(join(tmpdir(),'as-continuation-host-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const config=join(root,'host.json');writeFileSync(config,JSON.stringify({schema:1,remoteHost:'synthetic-lab-host',sshAlias:'synthetic-ssh-alias'}),{mode:0o600});
 const module=new URL('../app/codex-discussions.mjs',import.meta.url).href;
 const script=`import {CodexDiscussionHub} from ${JSON.stringify(module)};
 const source={id:'synthetic',provider:'codex',host:'synthetic-lab-host',nativeThreadId:'11111111-2222-4333-8444-555555555555',cwd:'/synthetic'};
 const engine={store:{data:{desktopPreferences:{allowNativeFullAccess:true}}},session:()=>source,permissions:()=>({enrolled:true,content:true,share:true,retrieve:true})};
 const calls=[];const hub=new CodexDiscussionHub(engine,{adapterFactory:({host})=>{if(host!==source.host)throw Error('Wrong host');return {open:async()=>{},close(){},request:async(method)=>{calls.push(method);if(method==='thread/read')return {thread:{id:source.nativeThreadId,cwd:source.cwd,canAcceptDirectInput:true,status:{type:'idle'}}};if(method==='thread/queue/list')return {data:[]};throw Error('Unexpected native command');}};}});
 const result=await hub.inspectContinuation(source.id);await hub.close();console.log(JSON.stringify({result,calls}));`;
 const output=execFileSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000,env:{...process.env,AGENTSPACES_HOST_CONFIG:config,AGENTSPACES_REMOTE_HOST:'synthetic-lab-host',AGENTSPACES_SSH_ALIAS:'synthetic-ssh-alias'}});
 const observed=JSON.parse(output);assert.equal(observed.result.state,'idle');assert.deepEqual(observed.calls,['thread/read','thread/queue/list']);
});
