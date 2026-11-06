// Opt-in fixture: starts an isolated Codex server and a synthetic loopback model.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { once, EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { answerCodexSide } from '../app/codex-side-chat.mjs';
const root=await mkdtemp(join(tmpdir(),'agentspaces-native-side-')), codexHome=join(root,'codex');
await mkdir(codexHome);
const requests=[], model=new EventEmitter();
let parentResponse;
const server=createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 if(!req.url.endsWith('/responses')){res.writeHead(404);res.end();return;}
 const input=JSON.parse(raw), child=raw.includes('Synthetic side question');
 requests.push({child,tools:(input.tools??[]).map(t=>t.name??t.type)});
 model.emit('request',child);
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const msg={type:'message',id:'msg_fixture',role:'assistant',status:'completed',content:[{type:'output_text',text:'Synthetic side answer',annotations:[]}]};
 const response={id:'resp_fixture',object:'response',created_at:1,status:'completed',model:'synthetic',output:[msg],usage:{input_tokens:5,output_tokens:3,total_tokens:8,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
 const emit=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n');
 emit('response.created',{response:{...response,status:'in_progress',output:[]}});
 if(!child){parentResponse=res;return;}
 emit('response.output_item.added',{output_index:0,item:{...msg,content:[],status:'in_progress'}});
 emit('response.output_text.delta',{output_index:0,content_index:0,item_id:msg.id,delta:msg.content[0].text});
 emit('response.output_item.done',{output_index:0,item:msg});
 emit('response.completed',{response});
 res.end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
await writeFile(join(codexHome,'config.toml'),`model = "synthetic"\nmodel_provider = "synthetic"\n[model_providers.synthetic]\nname = "Synthetic fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n[mcp_servers.fixture]\ncommand = "/nonexistent-fixture-command"\nstartup_timeout_sec = 1\n`);
const proc=spawn('codex',['app-server','--listen','stdio://'],{cwd:root,env:{...process.env,CODEX_HOME:codexHome,OPENAI_API_KEY:'',CODEX_API_KEY:''},stdio:['pipe','pipe','ignore']});
const events=new EventEmitter(), replies=new Map();let seq=0;
createInterface({input:proc.stdout}).on('line',line=>{
 const value=JSON.parse(line);
 if(value.id!==undefined&&replies.has(value.id)&&!value.method)replies.get(value.id)(value);
 if(value.method&&value.id===undefined)events.emit('notification',value);
});
const request=(method,params,timeoutMs=8000)=>new Promise((resolve,reject)=>{
 const id=++seq, timeout=setTimeout(()=>{replies.delete(id);reject(Error(method+' timed out'));},timeoutMs);
 replies.set(id,data=>{clearTimeout(timeout);replies.delete(id);if(data.error)reject(Error(method+': '+data.error.message));else resolve(data.result);});
 proc.stdin.write(JSON.stringify({method,id,params})+'\n');
});
const rpc={events,request};
try{
 await request('initialize',{clientInfo:{name:'as_side_fixture',version:'0.1.0'},capabilities:{experimentalApi:true}});
 proc.stdin.write('{"method":"initialized","params":{}}\n');
 const parent=(await request('thread/start',{cwd:root,sandbox:'read-only',approvalPolicy:'never'})).thread;
 await request('thread/inject_items',{threadId:parent.id,items:[{type:'message',role:'user',content:[{type:'input_text',text:'Synthetic fixture evidence'}]}]});
 const parentStarted=once(model,'request');
 await request('turn/start',{threadId:parent.id,input:[{type:'text',text:'Synthetic parent work'}]});
 assert.deepEqual(await parentStarted,[false]);
 const before=(await request('thread/read',{threadId:parent.id,includeTurns:false})).thread;
 assert.equal(before.status.type,'active');
 const result=await answerCodexSide(rpc,{parentId:parent.id,cwd:root,question:'Synthetic side question',timeoutMs:10000,beforeStart(){},fence(){}});
 const after=(await request('thread/read',{threadId:parent.id,includeTurns:false})).thread;
 assert.equal(result.text,'Synthetic side answer');
 assert.equal(after.status.type,'active');
 assert.equal(requests.filter(r=>r.child).length,1);
 assert.ok(requests.find(r=>r.child).tools.every(name=>['request_user_input','multi_agent_v1'].includes(name)));
 console.log(JSON.stringify({syntheticSideAnswer:true,originalParentStillActive:true,sideToolNames:requests.find(r=>r.child).tools,externalModelCalls:0}));
} finally {
 const closed = proc.exitCode === null ? once(proc,'exit') : Promise.resolve();
 parentResponse?.destroy();server.closeAllConnections();server.close();proc.stdin.end();proc.kill();
 await closed.catch(()=>{});await rm(root,{recursive:true,force:true});
}
