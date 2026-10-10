import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const run = (source, extra = {}) => exec(process.execPath, ['--input-type=module', '-e', source], { cwd: new URL('..', import.meta.url), env: { ...process.env, AGENTSPACES_HOST_CONFIG: '', AGENTSPACES_REMOTE_HOST: 'legacy-lab', AGENTSPACES_SSH_ALIAS: 'lab-transport', ...extra } });

test('remote identity and transport configuration reject ambiguous or shell-active labels', async () => {
  const { stdout } = await run(`const h=await import('./app/remote-host.mjs'); console.log(JSON.stringify([h.REMOTE_HOST,h.SSH_ALIAS]));`);
  assert.deepEqual(JSON.parse(stdout), ['legacy-lab', 'lab-transport']);
  for (const value of ['local', '-option', 'two words', 'x;echo', '../host', 'user@host', 'x'.repeat(101)]) {
    await assert.rejects(run(`await import('./app/remote-host.mjs')`, { AGENTSPACES_REMOTE_HOST: value }));
  }
  const defaults = await run(`
    import {mkdtempSync,rmSync} from 'node:fs'; import {tmpdir} from 'node:os'; import {join} from 'node:path';
    const fixtureHome=mkdtempSync(join(tmpdir(),'as-default-host-'));
    try {const h=await import('./app/remote-host.mjs'); const config=h.remoteHostConfiguration({},fixtureHome); console.log(JSON.stringify([config.remoteHost,config.sshAlias]));}
    finally {rmSync(fixtureHome,{recursive:true,force:true});}
  `);
  assert.deepEqual(JSON.parse(defaults.stdout), ['remote', 'remote']);
});

test('legacy identity retains remote path rules and version checks while native commands use separate SSH alias', async () => {
  await run(`
    import assert from 'node:assert/strict';
    import { posix } from 'node:path';
    import { hostPaths,hostOS,normalizeHostPath } from './app/platform.mjs';
    import { terminalLaunch } from './app/native-terminal.mjs';
    import { CodexQueueAdapter } from './app/codex-queue.mjs';
    import { qualifiedNativeVersion } from './app/native-versions.mjs';
    assert.equal(hostPaths('legacy-lab','win32'),posix);
    assert.equal(hostOS('legacy-lab','win32'),'Linux');
    assert.equal(normalizeHostPath('/Work/Project','legacy-lab','win32'),'/Work/Project');
    assert.equal(qualifiedNativeVersion('legacy-lab','codex','0.162.0'),true);
    assert.equal(terminalLaunch({host:'legacy-lab',provider:'codex',cwd:'/Work/Project'}).args[1],'lab-transport');
    const adapter=new CodexQueueAdapter({host:'legacy-lab'});
    assert.equal(adapter.host,'legacy-lab');
    assert.throws(()=>new CodexQueueAdapter({host:'remote'}));
  `);
});

test('real saved workspace restarts with identities, grants, connectors, room members and queued receipts intact', async () => {
  await run(`
    import assert from 'node:assert/strict';
    import {mkdtempSync,rmSync,readFileSync,realpathSync} from 'node:fs';
    import {tmpdir} from 'node:os'; import {join} from 'node:path';
    import {Store} from './app/store.mjs'; import {Engine} from './app/engine.mjs';
    import {SourceBindings} from './app/source-bindings.mjs'; import {startServer} from './app/server.mjs';
    const root=mkdtempSync(join(realpathSync(tmpdir()),'as-host-restart-'));
    const fabric={diagnostics:()=>({status:'disconnected'}),close(){}};
    const denied=()=>{throw Error('No native model or process is permitted in this fixture');};
    let app;
    try {
      const first=new Engine(new Store(root),fabric,{nativeFactory:denied});
      const thread='00000000-0000-4000-8000-000000000001';
      const source={id:'codex@legacy-lab:'+thread,nativeThreadId:thread,host:'legacy-lab',provider:'codex',cwd:'/Work/Project',account:'owner-boundary',scopeId:'retained-scope',fixture:false,status:'current',title:'Synthetic saved source',sourceVersion:'1'};
      first.workspace.index={schema:1,fixture:false,profile:{id:'retained-scope',active:true,account:'owner-boundary',hosts:['local','legacy-lab'],providers:['codex','claude'],policy:'local-retrieval',indexFiles:true,roots:{'legacy-lab':['/Work']},exclusions:{'legacy-lab':['/Private']}},nodes:[],edges:[],sessions:[source]};
      first.workspace.restore([source]); first.workspace.save();
      first.store.data.desktopPreferences={connectAll:true,hosts:['local','legacy-lab']};
      first.store.data.grants['codex@legacy-lab:revoked-source']={enrolled:false,content:false,share:false,retrieve:false};
      const bindings=new SourceBindings(first,{root,address:'http://127.0.0.1:43127',resolveMetadata:denied});
      const device=bindings.issueDevice({host:'legacy-lab',provider:'codex'});
      const registered=await bindings.register(device.token,{nativeThreadId:thread});
      first.discussions.create({title:'Retained room',sessionIds:[source.id]});
      first.store.data.codexDiscussionNativeReceipts={old:{clientId:'old',nativeThreadId:thread,host:'legacy-lab',queuedSubmissionId:'native-queue-id',status:'queued'}};
      first.store.data.codexDiscussionProofs={old:{nativeThreadId:thread,host:'legacy-lab',cwd:'/Work/Project'}};
      first.store.save();
      const keys=['grants','connectors','nativeRegistrationDevices','nativeSourceBindings','discussions','codexDiscussionNativeReceipts','codexDiscussionProofs'];
      const before=Object.fromEntries(keys.map(key=>[key,structuredClone(first.store.data[key])]));
      const engine=new Engine(new Store(root),fabric,{nativeFactory:denied});
      assert.equal(engine.catalog[0].id,source.id);assert.equal(engine.catalog[0].project,source.project);
      const restored=new SourceBindings(engine,{root,address:'http://127.0.0.1:43127',resolveMetadata:denied});
      const rebound=await restored.register(device.token,{nativeThreadId:thread});
      assert.equal(rebound.cached,true);assert.equal(rebound.token,registered.token);assert.equal(rebound.configPath,registered.configPath);
      const scans=[];engine.workspace.scan=async(profile)=>{scans.push(profile.hosts);};
      engine.workspace.summary=()=>({hasMore:false,profile:engine.workspace.index.profile});
      app=await startServer({root,port:0,engine,desktopDiscovery:true,codexAdapterFactory:denied,sourceMetadataResolver:denied});
      const runtime=JSON.parse(readFileSync(join(root,'runtime.json'),'utf8'));
      const state=await fetch(app.address+'/api/state',{headers:{Authorization:'Bearer '+runtime.admin}}).then(r=>r.json());
      assert.equal(state.remoteHost,'legacy-lab');assert(scans.length>0);assert(scans.every(hosts=>hosts.join(',')==='local,legacy-lab'));
      for(const key of keys)assert.deepEqual(engine.store.data[key],before[key],key+' must not be rewritten');
      assert.equal(engine.discussions.view(engine.store.data.discussions[0]).available,true);
      assert.equal(engine.modelCalls,0);
    }finally{await app?.close();rmSync(root,{recursive:true,force:true});}
  `);
});

test('wrong startup identity fails before restoring or changing saved work', async () => {
  await run(`
    import assert from 'node:assert/strict';
    import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
    import {Store} from './app/store.mjs';import {Engine} from './app/engine.mjs';
    const root=mkdtempSync(join(tmpdir(),'as-host-mismatch-'));
    try {const store=new Store(root);store.data.desktopPreferences={connectAll:true,hosts:['local','different-identity']};store.save();
      const before=readFileSync(store.path,'utf8');
      assert.throws(()=>new Engine(store,{}),/Saved remote host identity differs/);
      assert.equal(readFileSync(store.path,'utf8'),before);
    }finally{rmSync(root,{recursive:true,force:true});}
  `);
});

test('copied participant CLI and serialized guide accept a configured identity without local repo imports', async () => {
  await run(`
    import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync,readFileSync,copyFileSync,rmSync,realpathSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';import {participantGuide} from './app/participant-guide.mjs';
    const root=mkdtempSync(join(realpathSync(tmpdir()),'as-host-cli-'));try {
      const path=join(root,'cli.mjs');copyFileSync('./app/participant-cli.mjs',path);
      const {runParticipantCli}=await import(pathToFileURL(path));
      const source='00000000-0000-4000-8000-000000000001',config=join(root,'participant.json');
      writeFileSync(config,JSON.stringify({schema:1,address:'http://127.0.0.1:43127',authority:'127.0.0.1:43127',token:'a'.repeat(64),sessionId:'codex@legacy-lab:'+source,nativeThreadId:source,host:'legacy-lab',provider:'codex'}),{mode:0o600});
      const result=await runParticipantCli(['--config',config,'--source',source,'message'],{input:JSON.stringify({host:'legacy-lab',nativeThreadId:source,text:'Synthetic',nativeTurnId:'turn-1',deliveryId:'synthetic-message-1'}),requestImpl:async request=>{assert.equal(request.body.host,'legacy-lab');return {statusCode:200,body:{ok:true}};}});assert.equal(result.result.ok,true);
      const detachedGuide=Function('return ('+participantGuide.toString()+')')();
      assert(detachedGuide({cliPath:'/fictional/cli.mjs',configPath:'/fictional/participant.json',sessionId:'codex@legacy-lab:'+source,nativeThreadId:source,provider:'codex',host:'legacy-lab',account:'synthetic',project:'synthetic'}).includes('legacy-lab'));
    }finally{rmSync(root,{recursive:true,force:true});}
  `);
});

test('owner-private host configuration survives a fresh process and refuses linked or insecure files', async () => {
  await run(`
    import assert from 'node:assert/strict'; import {mkdtempSync,writeFileSync,chmodSync,symlinkSync,rmSync,realpathSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
    import {remoteHostConfiguration} from './app/remote-host.mjs';
    const root=mkdtempSync(join(realpathSync(tmpdir()),'as-host-config-'));try {
      const path=join(root,'host-config.json');writeFileSync(path,JSON.stringify({schema:1,remoteHost:'legacy-lab',sshAlias:'lab-transport'}),{mode:0o600});
      assert.deepEqual(remoteHostConfiguration({AGENTSPACES_HOST_CONFIG:path}),{remoteHost:'legacy-lab',sshAlias:'lab-transport'});
      assert.deepEqual(remoteHostConfiguration({AGENTSPACES_HOST_CONFIG:path,AGENTSPACES_SSH_ALIAS:'alternate-transport'}),{remoteHost:'legacy-lab',sshAlias:'alternate-transport'});
      assert.throws(()=>remoteHostConfiguration({AGENTSPACES_HOST_CONFIG:'relative.json'}));
      if(process.platform!=='win32'){
        chmodSync(path,0o644);assert.throws(()=>remoteHostConfiguration({AGENTSPACES_HOST_CONFIG:path}),/owner-private/);chmodSync(path,0o600);
        const linked=join(root,'linked.json');symlinkSync(path,linked);assert.throws(()=>remoteHostConfiguration({AGENTSPACES_HOST_CONFIG:linked}),/linked/);
      }
      for(const remoteHost of [0,false,'']){writeFileSync(path,JSON.stringify({schema:1,remoteHost}));assert.throws(()=>remoteHostConfiguration({AGENTSPACES_HOST_CONFIG:path}),/Invalid remote host/);}
      writeFileSync(path,JSON.stringify({schema:1,remoteHost:'legacy-lab',unexpected:true}));assert.throws(()=>remoteHostConfiguration({AGENTSPACES_HOST_CONFIG:path}),/schema/);
    }finally{rmSync(root,{recursive:true,force:true});}
  `);
});

test('SSH transports use configured alias while exposing only retained identity in receipts and tunnel records', async () => {
  await run(`
    import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
    import {CodexQueueAdapter} from './app/codex-queue.mjs';import {CodexReadAdapter} from './app/native.mjs';import {ClaudeReadAdapter} from './app/claude-adapter.mjs';import {ParticipantConnections} from './app/participant-connection.mjs';import {remoteInstallScript} from './app/native-auto-install.mjs';
    const stopped=Error('Synthetic spawn stopped');let calls=0;const spawn=(command,args)=>{calls++;assert.equal(command,'ssh');assert.equal(args[0],'lab-transport');throw stopped;};
    await assert.rejects(new CodexQueueAdapter({host:'legacy-lab',spawnProcess:spawn}).open());
    await assert.rejects(new CodexReadAdapter({host:'legacy-lab',spawnProcess:spawn}).open());
    await assert.rejects(new ClaudeReadAdapter({host:'legacy-lab',spawnProcess:spawn}).discover({path:'/Work',metadataGrant:true}));
    assert.equal(calls,3);
    const data={participantBridge:{host:'legacy-lab',remotePort:45000,authority:'127.0.0.1:43127'},connectors:{synthetic:{sessionId:'codex@legacy-lab:source'}}};const before=structuredClone(data);
    const bridge=new ParticipantConnections({store:{data,save(){}}},{root:process.cwd(),address:'http://127.0.0.1:43127',tunnelFactory:async args=>{assert.equal(args.host,'legacy-lab');assert.equal(args.remotePort,45000);return {child:new EventEmitter(),close(){}};}});
    await bridge.restorePromise;assert.equal(bridge.health().status,'connected');assert.deepEqual(data,before);bridge.close();
    const script=remoteInstallScript({config:{host:'legacy-lab'},sources:{},versions:{}});
    const imports=[...script.matchAll(/^import\\s.*?from\\s+['"]([^'"]+)['"]/gm)].map(match=>match[1]);
    assert(imports.every(name=>name.startsWith('node:')));assert(script.includes('const REMOTE_HOST="legacy-lab",SSH_ALIAS="lab-transport";'));
  `);
});

test('Ask probes a selected legacy identity and never substitutes an unconfigured canonical remote', async () => {
  const { findNativeAnswerService } = await import('../ui/answer-connection.js');
  const calls = [];
  const result = await findNativeAnswerService({ hosts: ['legacy-lab'], api: async (_route, body) => { calls.push(body.host); return [{ provider: 'codex', available: true }]; } });
  assert.equal(result.host, 'legacy-lab'); assert.deepEqual(calls, ['legacy-lab']);
});
test('normal installed launches can retain private configuration outside the repository', async () => {
  await run(`
    import assert from 'node:assert/strict';import{mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
    import{remoteHostConfiguration}from'./app/remote-host.mjs';
    const home=mkdtempSync(join(realpathSync(tmpdir()),'as-private-host-'));
    try{
      assert.deepEqual(remoteHostConfiguration({},home),{remoteHost:'remote',sshAlias:'remote'});
      mkdirSync(join(home,'.agentspaces-desktop'));writeFileSync(join(home,'.agentspaces-desktop','host.json'),JSON.stringify({schema:1,remoteHost:'fictional-host',sshAlias:'fictional-route'}),{mode:0o600});
      assert.deepEqual(remoteHostConfiguration({},home),{remoteHost:'fictional-host',sshAlias:'fictional-route'});
      assert.deepEqual(remoteHostConfiguration({AGENTSPACES_REMOTE_HOST:'test-host',AGENTSPACES_SSH_ALIAS:'test-route'},home),{remoteHost:'test-host',sshAlias:'test-route'});
    }finally{rmSync(home,{recursive:true,force:true});}
  `);
});
