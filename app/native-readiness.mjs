// A derived view of current grants and live transports, never a second registry.
export function nativeWakeReadiness(engine,channels,sessionId){
 const source=engine.session(sessionId),grant=engine.permissions(source);
 const readAccessGranted=!!(grant.enrolled&&grant.retrieve&&grant.share);
 const registered=Object.values(engine.store.data.nativeSourceBindings??{}).some(row=>row.identity?.sessionId===sessionId);
 const common={sourceId:sessionId,provider:source.provider,readAccessGranted,registered,nativeAcceptance:'not-attested',activeSessionReloaded:false};
 if(!readAccessGranted)return {...common,status:'source-grant-unavailable',transportConnected:false,reason:'Current source enrollment, sharing or retrieval permission is unavailable'};
 if(source.provider==='claude'){
  const connected=channels.isConnected(sessionId);
  return {...common,status:connected?'native-channel-connected':'native-opt-in-or-connection-required',transportConnected:connected,channelName:'agentspaces-desktop',reason:connected?'Live source-bound channel transport connected; native event acceptance remains separate':'Read tools and room membership do not enable inbound messages. This native Claude session needs channel opt-in and a live source-bound connection.',nativeLaunchArgs:['--dangerously-load-development-channels','server:agentspaces-desktop'],nextStep:'Call ensure_native_connection in the target thread. If it reports native-opt-in-required, use these arguments at the next owner-controlled native launch and accept native consent. Do not start a second controller, resume a busy thread or bypass organization policy.'};
 }
 return {...common,status:source.provider==='codex'&&source.host==='remote'?'native-route-available':'native-wake-route-unavailable',transportConnected:false,reason:'Native eligibility is checked on addressed delivery; metadata registration alone is not a wake receipt'};
}
export function ensureNativeConnection(engine,channels,binding,input={}){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw Error('This-source connection setup takes no identity or permission arguments');
 const caller=engine.discussions.participant(binding);
 return {sourceId:caller.id,readiness:nativeWakeReadiness(engine,channels,caller.id),ownerGrantsChanged:false,nativeProcessStarted:false,activeSessionReloaded:false};
}
