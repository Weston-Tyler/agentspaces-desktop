// Supported OpenSSH ProxyCommand: raw SSH bytes retain host-key/user authentication.
// Machine-specific addresses live only in the separate owner-private config.
import net from 'node:net';
import {readFileSync,lstatSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
export function readCarrierConfig(path){
 const s=lstatSync(path);
 if(!s.isFile()||s.isSymbolicLink()||s.size>4096||(process.platform!=='win32'&&(s.uid!==process.getuid()||(s.mode&0o077))))throw Error('Owner-private carrier configuration required');
 const c=JSON.parse(readFileSync(path,'utf8'));
 if(Object.keys(c).some(k=>!['relayPort','fallbackHost','fallbackPort'].includes(k))||![c.relayPort,c.fallbackPort].every(n=>Number.isInteger(n)&&n>0&&n<=65535)||typeof c.fallbackHost!=='string'||!c.fallbackHost||/[\s\x00]/.test(c.fallbackHost))throw Error('Invalid carrier configuration');
 return c;
}
export async function connectCarrier(c){
 const dial=(host,port)=>new Promise((yes,no)=>{
  const s=net.connect({host,port});const timer=setTimeout(()=>s.destroy(),3000);
  s.once('connect',()=>{clearTimeout(timer);s.removeListener('error',no);yes(s);});s.once('error',no);s.once('close',()=>{clearTimeout(timer);no(Error('Carrier unavailable'));});
 });
 try{return await dial('127.0.0.1',c.relayPort);}catch{return dial(c.fallbackHost,c.fallbackPort);}
}
export function watchCarrierParent(socket,{parentPid=process.ppid,probe=pid=>process.kill(pid,0),intervalMs=1000}={}){
 // OpenSSH on Windows can leave ProxyCommand pipes open after its own exit.
 // Detach this transport helper when its owner disappears; never signal a native client.
 const timer=setInterval(()=>{try{probe(parentPid);}catch(error){if(error.code==='ESRCH')socket.destroy();}},intervalMs);
 timer.unref();socket.once('close',()=>clearInterval(timer));return timer;
}
export async function runCarrier(path){
 const socket=await connectCarrier(readCarrierConfig(path));
 watchCarrierParent(socket);
 // Selection finishes before reading stdin. Established streams are never replayed.
 socket.on('error',()=>{process.exitCode=1;socket.destroy();});
 socket.on('close',()=>{process.stdin.unpipe(socket);process.stdin.destroy();process.stdout.end();});
 process.stdout.on('error',()=>socket.destroy());process.stdin.on('error',()=>socket.destroy());
 process.stdin.pipe(socket);socket.pipe(process.stdout);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runCarrier(process.argv[2]).catch(()=>{process.stderr.write('Native carrier unavailable\n');process.exitCode=1;});
