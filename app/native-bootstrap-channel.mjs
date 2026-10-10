import WebSocket from 'ws';
// Source identity is resolved by the native lifecycle adapter on every connection
// and delivery. This module never starts or resumes a native process.
export class NativeBootstrapChannel {
 constructor({resolveBinding,notify,WebSocketClass=WebSocket,retryMinMs=1000,retryMaxMs=30000}={}){Object.assign(this,{resolveBinding,notify,WebSocketClass,retryMinMs,retryMaxMs});this.status='not_started';this.attempts=0;this.closed=false;this.pinned=null;}
 health(){return {status:this.status,transportConnected:this.status==='connected',nativeAcceptance:'not-attested',activeSessionReloaded:false,channelName:'agentspaces-desktop',nativeLaunchArgs:['--dangerously-load-development-channels','server:agentspaces-desktop']};}
 async ensure(){
  if(this.closed)return this.health();
  if(this.pending)return this.pending;
  this.pending=this.connect().finally(()=>{this.pending=null;});return this.pending;
 }
 retry(){if(this.closed||this.timer)return;this.timer=setTimeout(()=>{this.timer=null;void this.ensure();},Math.min(this.retryMaxMs,this.retryMinMs*2**Math.min(this.attempts++,8)));this.timer.unref?.();}
 async connect(){
  try{
   const binding=await this.resolveBinding();
   if(this.closed)return this.health();
   if(!binding.channelOptIn){this.invalidate('native-opt-in-required');return this.health();}
   if(this.pinned&&this.pinned!==binding.nativeThreadId){this.invalidate('native-source-changed');return this.health();}
   this.pinned=binding.nativeThreadId;
   if(this.socket&&['connecting','connected'].includes(this.status))return this.health();
   const {config}=binding;this.status='connecting';
   const socket=this.socket=new this.WebSocketClass(config.address.replace('http:','ws:')+'/api/native/channel',{headers:{Host:config.authority,Authorization:'Bearer '+config.token},handshakeTimeout:12000,maxPayload:65536,perMessageDeflate:false});
   let lost=false;
   const reconnect=()=>{if(lost||this.closed||this.socket!==socket)return;lost=true;this.status='reconnecting';socket.terminate();this.retry();};
   socket.on('open',()=>{if(!this.closed&&!lost&&this.socket===socket){this.status='connected';this.attempts=0;}});
   socket.on('error',reconnect);socket.on('close',reconnect);
   socket.on('message',async bytes=>{
    if(this.closed||lost||this.socket!==socket)return;
    try{
     const event=JSON.parse(bytes.toString()),p=event.params??event;
     if(typeof p.content!=='string'||p.content.length>8000||!p.meta||typeof p.meta!=='object'||Array.isArray(p.meta)||Object.keys(p.meta).some(k=>!/^[A-Za-z0-9_]+$/.test(k)||typeof p.meta[k]!=='string'))return;
     let current;try{current=await this.resolveBinding();}catch{this.invalidate('source-registration-unavailable');this.retry();return;}
     if(current.nativeThreadId!==this.pinned||!current.channelOptIn){this.invalidate('native-source-unavailable');return;}
     if(this.closed||lost||this.socket!==socket)return;
     await this.notify({method:'notifications/claude/channel',params:{content:p.content,meta:p.meta}});
    }catch{ /* No delivery replay: native notification acceptance is uncertain. */ }
   });
  }catch(error){this.invalidate(['native_lifecycle_binding_missing','native_lifecycle_binding_stale_or_missing','native_lifecycle_binding_ambiguous'].includes(error.code)?error.code:'source-registration-unavailable');this.retry();}
  return this.health();
 }
 invalidate(status){this.status=status;const socket=this.socket;this.socket=null;socket?.terminate();}
 close(){this.closed=true;this.status='closed';clearTimeout(this.timer);this.timer=null;this.socket?.terminate();}
}
