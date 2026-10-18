import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Engine} from '../app/engine.mjs';
import {Store} from '../app/store.mjs';
import {startServer} from '../app/server.mjs';
import {createNativeBootstrap} from '../app/native-bootstrap-mcp.mjs';
async function fixture(t){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'as-resume-http-'));
 const engine=new Engine(new Store(root),{diagnostics:()=>({}),close(){}},{nativeFactory:()=>{throw Error('No native or model calls');}});
 engine.workspace.index={schema:1,fixture:false,profile:{id:'scope',active:true,account:'fictional',hosts:['local'],providers:['codex','claude'],policy:'local-retrieval',indexFiles:true,roots:{},exclusions:{}},nodes:[{id:'host:local',kind:'host',host:'local'}],edges:[],sessions:[],coverage:[],errors:[]};
 for(let n=1;n<=2;n++){const source={id:'codex@local:00000000-0000-4000-8000-00000000000'+n,nativeThreadId:'00000000-0000-4000-8000-00000000000'+n,host:'local',provider:'codex',cwd:join(root,'project'),account:'fictional',scopeId:'scope',fixture:false,title:'Native thread '+n,sourceVersion:'fixture-1',topics:[]};engine.workspace.restore([source]);engine.workspace.index.sessions.push(source);}
 const app=await startServer({root,port:0,engine});t.after(async()=>{await app.close();rmSync(root,{recursive:true,force:true});});
 const ids=engine.catalog.map(s=>s.id),tokens=ids.map(id=>engine.issueConnector(id).token);
 const call=async(path,body={},token=tokens[0])=>{const r=await fetch(app.address+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};return {root,app,engine,ids,tokens,call};
}
const body={summary:'I diagnose sensor fusion regressions',focus:'Kalman tracking',skills:['sensor fusion','Kalman'],canHelpWith:['Tracking latency'],deliveryId:'resume-http-update'};
test('real HTTP exposes source-bound resumes and automatic collaboration without granting registration devices access',async t=>{
 const f=await fixture(t),updated=await f.call('/api/agent/resume/update',body);assert.equal(updated.status,200,JSON.stringify(updated.body));
 const relevant=await f.call('/api/agent/relevant',{query:'Kalman tracking'},f.tokens[1]);assert.equal(relevant.status,200);assert.equal(relevant.body.items[0].sessionId,f.ids[0]);
 const context=await f.call('/api/agent/collaboration',{query:'Kalman tracking'},f.tokens[1]);assert.equal(context.status,200);assert.equal(context.body.peers[0].sessionId,f.ids[0]);assert.match(context.body.additionalContext,/untrusted data/);assert.equal(context.body.queryPersisted,false);
 assert.equal((await f.call('/api/agent/resume/update',{...body,deliveryId:'resume-spoof-0001',sessionId:f.ids[1]})).status,400);
 const device=await f.call('/api/native/registration/device',{host:'local',provider:'codex'},f.app.admin);
 assert.equal((await f.call('/api/agent/collaboration',{},device.body.token)).status,403);
 f.engine.grant(f.ids[0],{share:false});assert.equal((await f.call('/api/agent/relevant',{query:'Kalman tracking'},f.tokens[1])).body.items.length,0);
 assert.equal(f.engine.modelCalls,0);
});
test('source-neutral MCP publishes resumes and discovers a peer with exact native request metadata',async t=>{
 const f=await fixture(t);await f.call('/api/agent/resume/update',body);
 const issued=await f.call('/api/native/registration/device',{host:'local',provider:'codex'},f.app.admin);
 const path=join(f.root,'device.json');writeFileSync(path,JSON.stringify({schemaVersion:1,...issued.body,address:f.app.address,authority:new URL(f.app.address).host}),{mode:0o600});
 const bootstrap=await createNativeBootstrap({configPath:path});t.after(()=>bootstrap.server.close());
 const call=async(name,args={})=>JSON.parse((await bootstrap.callTool({params:{name,arguments:args,_meta:{threadId:f.engine.session(f.ids[1]).nativeThreadId}}})).content[0].text);
 const register=await call('register_native_source');assert(register.collaboration.additionalContext.includes('update_thread_resume'));
 const found=await call('discover_relevant_agents',{query:'sensor fusion'});assert.equal(found.items[0].sessionId,f.ids[0]);
 const existingDiscovery=await call('discover_permitted_work',{query:'Kalman'});assert.equal(existingDiscovery[0].id,f.ids[0]);assert.equal(existingDiscovery[0].resume.freshness,'fresh');
 const written=await call('update_thread_resume',{summary:'I build sensor integration tests',skills:['sensor fusion'],deliveryId:'mcp-resume-update'});assert.equal(written.sourceId,f.ids[1]);
 const read=await call('read_thread_resume',{sessionId:f.ids[1]});assert.equal(read.items[0].summary,'I build sensor integration tests');
});
