import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ManagedNativeRuntime, readManagedSelection } from '../app/native-managed-entry.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
function fixture(){
 const base=mkdtempSync(join(realpathSync(tmpdir()),'managed-native-'));mkdirSync(join(base,'claude'));mkdirSync(join(base,'managed'));
 const configPath=join(base,'claude','device.json');writeFileSync(configPath,'{}',{mode:0o600});
 const source={'native-bootstrap-mcp.mjs':'// bootstrap','native-session-hook.mjs':'// hook','native-bootstrap-channel.mjs':'// channel'};
 const digest=hash(Object.values(source).join('')),runtime='runtime-'+digest;mkdirSync(join(base,runtime));
 for(const [name,body] of Object.entries(source))writeFileSync(join(base,runtime,name),body,{mode:0o600});
 const pointer={schema:1,protocol:1,runtime,sources:Object.fromEntries(Object.entries(source).map(([n,s])=>[n,hash(s)]))};
 const pointerPath=join(base,'managed','current.json');writeFileSync(pointerPath,JSON.stringify(pointer),{mode:0o600});
 return {base,configPath,pointerPath,pointer,runtime};
}
test('managed selection verifies private in-root source hashes before loading helper code',()=>{
 const f=fixture(),selected=readManagedSelection(f.configPath);assert.equal(selected.runtimePath,join(f.base,f.runtime));
 writeFileSync(join(f.base,f.runtime,'native-session-hook.mjs'),'tampered');assert.throws(()=>readManagedSelection(f.configPath),/managed_runtime/);
});
test('unsupported pointers, traversal and public device files fail closed',()=>{
 for(const change of [{runtime:'../foreign'},{protocol:2},{sources:{}}]){const f=fixture();writeFileSync(f.pointerPath,JSON.stringify({...f.pointer,...change}),{mode:0o600});assert.throws(()=>readManagedSelection(f.configPath),/managed_runtime/);}
 if(process.platform!=='win32'){const f=fixture();chmodSync(f.configPath,0o644);assert.throws(()=>readManagedSelection(f.configPath),/managed_runtime/);}
});
test('active calls finish on their original helper while later calls use a verified updated helper',async()=>{
 let key='old',release;const hold=new Promise(resolve=>release=resolve),closed=[];
 const runtime=new ManagedNativeRuntime({configPath:'/fictional/device.json',readSelection:()=>({key}),build:async selection=>({callTool:async request=>{if(request.wait)await hold;return selection.key;},listTools:()=>[],channel:{close:()=>closed.push(selection.key)}})});
 const pending=runtime.callTool({wait:true});await new Promise(resolve=>setImmediate(resolve));key='new';assert.equal(await runtime.callTool({}), 'new');assert.deepEqual(closed,[]);
 release();assert.equal(await pending,'old');assert.deepEqual(closed,['old']);await runtime.close();assert.deepEqual(closed,['old','new']);
});
test('a failed new selection is not served through an old helper or retried as an uncertain write',async()=>{
 let failed=false,calls=0;const r=new ManagedNativeRuntime({configPath:'/fictional/device.json',readSelection:()=>{if(failed)throw Error('managed_runtime_invalid');return {key:'old'};},build:async()=>({callTool:async()=>++calls,listTools:()=>[]})});
 assert.equal(await r.callTool({}),1);failed=true;await assert.rejects(r.callTool({}),/managed_runtime_invalid/);assert.equal(calls,1);await r.close();
});

test('an already connected MCP client sees a new verified implementation through the same process',async t=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
 const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
 const {symlinkSync,realpathSync,renameSync,rmSync}=await import('node:fs');
 const f=fixture();t.after(()=>rmSync(f.base,{recursive:true,force:true}));
 symlinkSync(realpathSync(new URL('../node_modules',import.meta.url)),join(f.base,'node_modules'),process.platform==='win32'?'junction':'dir');
 const entry=join(f.base,'managed','native-bootstrap-mcp.mjs');writeFileSync(entry,readFileSync(new URL('../app/native-managed-entry.mjs',import.meta.url),'utf8'),{mode:0o600});
 const select=version=>{
  const sources={'native-bootstrap-mcp.mjs':`export async function createNativeBootstrap(){return {listTools:()=>[{name:'fixture',description:'Synthetic read-only tool',inputSchema:{type:'object'}}],callTool:async()=>({content:[{type:'text',text:'${version}'}]})};}`,'native-session-hook.mjs':'// synthetic hook','native-bootstrap-channel.mjs':'// synthetic channel'};
  const runtime='runtime-'+hash(Object.values(sources).join(''));mkdirSync(join(f.base,runtime));
  for(const [name,text] of Object.entries(sources))writeFileSync(join(f.base,runtime,name),text,{mode:0o600});
  const pointer={schema:1,protocol:1,runtime,sources:Object.fromEntries(Object.entries(sources).map(([n,text])=>[n,hash(text)]))};
  writeFileSync(f.pointerPath+'.next',JSON.stringify(pointer),{mode:0o600});renameSync(f.pointerPath+'.next',f.pointerPath);
 };
 select('old');const transport=new StdioClientTransport({command:process.execPath,args:[entry,'--config',f.configPath],stderr:'pipe'});
 const client=new Client({name:'fixture-client',version:'1.0.0'});await client.connect(transport);t.after(()=>client.close());
 const pid=transport.pid;assert(Number.isInteger(pid));assert.equal((await client.callTool({name:'fixture',arguments:{}})).content[0].text,'old');
 select('new');assert.equal((await client.callTool({name:'fixture',arguments:{}})).content[0].text,'new');assert.equal(transport.pid,pid);
});
