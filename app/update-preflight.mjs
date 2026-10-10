import { createHash } from 'node:crypto';
import { existsSync, readdirSync, lstatSync, readFileSync, mkdtempSync, cpSync, rmSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { assertSavedHostIdentity } from './remote-host.mjs';
import { assertStateDirectoryNames, protectStateDirectory } from './state-security.mjs';
import { Store } from './store.mjs';
import { Engine } from './engine.mjs';
import { FabricAdapter } from './fabric.mjs';
import { startServer } from './server.mjs';

function files(root, prefix = '') {
  const result = [];
  for (const name of readdirSync(join(root,prefix)).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name, path = join(root,relative), stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw Error('preflight_linked_state_or_source');
    if (stat.isDirectory()) result.push(...files(root,relative));
    else if (stat.isFile()) result.push(relative);
    else throw Error('preflight_special_file');
  }
  return result;
}
const digest = data => createHash('sha256').update(data).digest('hex');
export function candidateFingerprint(root) {
  const selected = ['app','ui','scripts'].flatMap(dir => files(join(root,dir)).map(file => `${dir}/${file}`));
  selected.push('package.json','package-lock.json');
  return digest(JSON.stringify(selected.sort().map(path => [path,digest(readFileSync(join(root,path)))])));
}
// Inspect a private copy: never start discovery, installers, native clients or models.
export async function preflightUpdate({ stateRoot, candidateRoot = fileURLToPath(new URL('..',import.meta.url)) }) {
  assertStateDirectoryNames(stateRoot);
  const settings = JSON.parse(readFileSync(join(stateRoot,'settings.json'),'utf8'));
  const index = existsSync(join(stateRoot,'workspace-index.json')) ? JSON.parse(readFileSync(join(stateRoot,'workspace-index.json'),'utf8')) : undefined;
  assertSavedHostIdentity(settings,index);
  const before = candidateFingerprint(candidateRoot);
  const scratch = mkdtempSync(join(tmpdir(),'agentspaces-update-')); chmodSync(scratch,0o700);
  let app;
  try {
    protectStateDirectory(scratch);
    // Reject linked private files before copying; their external targets are never read.
    files(stateRoot);
    for (const name of readdirSync(stateRoot)) {
      if (/^(runtime\.json|stdout\.log|stderr\.log|.*\.tmp)$/.test(name)) continue;
      cpSync(join(stateRoot,name),join(scratch,name),{recursive:true});
    }
    const store = new Store(scratch), engine = new Engine(store,new FabricAdapter({stateRoot:scratch}), {
      nativeFactory: () => { throw Error('preflight_native_execution_forbidden'); },
      answerFactory: () => { throw Error('preflight_model_execution_forbidden'); },
    });
    app = await startServer({root:scratch,port:0,engine,desktopDiscovery:false,backgroundNative:false,
      codexAdapterFactory: () => {throw Error('preflight_native_execution_forbidden');},
      participantTunnelFactory: () => {throw Error('preflight_tunnel_forbidden');},
    });
    const response = await fetch(app.address+'/api/health',{headers:{Authorization:`Bearer ${app.admin}`},signal:AbortSignal.timeout(5000)});
    if (!response.ok || (await response.json()).instance !== app.instance) throw Error('preflight_health_failed');
    if (candidateFingerprint(candidateRoot) !== before) throw Error('candidate_changed_during_preflight');
    if(engine.modelCalls !== 0) throw Error('preflight_unexpected_model_execution');
    return {passed:true,candidate:before,settingsSchema:settings.schema,privateCopyStartup:true,discovery:false,modelCalls:0,nativeCancellationRequested:false};
  } finally { if(app) await app.close(); rmSync(scratch,{recursive:true,force:true}); }
}
