// Recover only a demonstrably stale companion record. Never kill a process,
// replace a live listener, or treat PID liveness alone as process identity.
import {readFileSync,statSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createConnection} from 'node:net';
const exec=promisify(execFile);

export async function processStartedAt(pid){
 if(!Number.isInteger(pid)||pid<1)return null;
 try{
  const command=process.platform==='win32'?'powershell.exe':'ps';
  const args=process.platform==='win32'?['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`]:['-p',String(pid),'-o','lstart='];
  const {stdout}=await exec(command,args,{timeout:5000,maxBuffer:4096,windowsHide:true,env:{...process.env,LC_ALL:'C'}});
  const at=Date.parse(stdout.trim());return Number.isFinite(at)?at:null;
 }catch{return null;}
}
function alive(pid){
 try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}
}
function closed(port){
 return new Promise(resolve=>{
  let settled=false;const socket=createConnection({host:'127.0.0.1',port});
  const finish=value=>{if(settled)return;settled=true;socket.destroy();resolve(value);};
  socket.setTimeout(1500,()=>finish(false));socket.once('connect',()=>finish(false));socket.once('error',error=>finish(error.code==='ECONNREFUSED'));
 });
}
export async function resolveSavedCompanion(path,{explicit=false,fetchImpl=fetch,processAlive=alive,startedAt=processStartedAt,portClosed=closed}={}){
 let runtime,written;
 try{runtime=JSON.parse(readFileSync(path,'utf8'));written=statSync(path).mtimeMs;}catch{throw Error('Invalid saved companion runtime');}
 if(!runtime||!/^http:\/\/127\.0\.0\.1:\d+$/.test(runtime.address??'')||!Number.isInteger(runtime.pid)||runtime.pid<1||typeof runtime.admin!=='string'||!runtime.admin||typeof runtime.instance!=='string'||!runtime.instance)throw Error('Invalid saved companion runtime');
 const port=Number(new URL(runtime.address).port);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid saved companion runtime');
 try{
  const response=await fetchImpl(runtime.address+'/api/health',{headers:{Authorization:'Bearer '+runtime.admin},signal:AbortSignal.timeout(3000)}),health=await response.json();
  if(!response.ok||health.instance!==runtime.instance||health.pid!==runtime.pid)throw Error('Companion identity mismatch');
  return {status:'attached',address:runtime.address};
 }catch{
  if(explicit)throw Error('Explicit companion runtime is unavailable; no fallback was started');
 }
 if(!await portClosed(port))throw Error('Saved companion port is occupied or unavailable; preserve the existing owner');
 if(!processAlive(runtime.pid))return {status:'stale',reason:'process-absent'};
 const born=await startedAt(runtime.pid);
 // ps has one-second resolution. Require a conservative gap, including for
 // legacy records with no stored process-birth field. Unknown means preserve.
 if(Number.isFinite(born)&&born>written+2000)return {status:'stale',reason:'pid-reused'};
 throw Error('Saved companion process may still be running; no replacement was started');
}
