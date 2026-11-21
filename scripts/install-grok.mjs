import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { assertUnlinkedParents } from '../app/native-connections.mjs';
import { privateFile } from '../app/native-session-hook.mjs';
import { GROK_QUALIFIED_VERSIONS } from '../app/grok-source.mjs';
import { readManagedSelection } from '../app/native-managed-entry.mjs';

const run = promisify(execFile);
const hash = text => createHash('sha256').update(text).digest('hex');

async function writePrivate(file, bytes) {
  const temp = file + '.' + randomUUID() + '.tmp';
  await writeFile(temp, bytes, { flag:'wx', mode:0o600 });
  await rename(temp, file);
}

async function publishRecovery(configPath, record) {
  const existing = readManagedSelection(configPath);
  const pointer = await privateFile(existing.pointerPath);
  const base = dirname(dirname(existing.pointerPath));
  if (join(base,pointer.runtime) !== existing.runtimePath) throw new Error('Managed helper changed, retry recovery.');
  const names = ['native-bootstrap-mcp.mjs','native-session-hook.mjs','native-bootstrap-channel.mjs',
    ...(pointer.sources['native-inbox-hook.mjs'] ? ['native-inbox-hook.mjs'] : [])];
  const sources = await Promise.all(names.map(name => readFile(join(existing.runtimePath,name),'utf8')));
  if (sources.some((content,index) => hash(content) !== pointer.sources[names[index]]))
    throw new Error('Managed helper changed, retry recovery.');
  const bootstrap = await readFile(record.entry,'utf8');
  if (hash(bootstrap) !== record.sha256) throw new Error('Grok helper integrity check failed.');
  sources[0] = bootstrap + '\n// Recovery generation ' + randomUUID() + '\n';
  const runtime = 'runtime-' + hash(sources.join(''));
  const directory = join(base,runtime);
  await mkdir(directory,{mode:0o700});
  for (const [idx,name] of names.entries()) await writeFile(join(directory,name),sources[idx],{flag:'wx',mode:0o600});
  if (readManagedSelection(configPath).key !== existing.key) throw new Error('Managed helper changed, retry recovery.');
  await writePrivate(join(dirname(configPath),'recovery.json'),JSON.stringify(record));
  await writePrivate(existing.pointerPath, JSON.stringify({
    ...pointer, runtime, sources:Object.fromEntries(names.map((name,idx)=>[name,hash(sources[idx])])),
  }));
}

async function install() {
  if (process.platform !== 'linux' || !process.env.AGENTSPACES_STATE)
    throw new Error('Set AGENTSPACES_STATE to the local companion state directory on Linux.');
  const home = homedir();
  const args = process.argv.slice(2);
  const recoverIndex = args.indexOf('--recover-mcp-pid');
  let recoverMcpPid;
  if (recoverIndex !== -1) {
    recoverMcpPid = Number(args[recoverIndex + 1]);
    if (!Number.isSafeInteger(recoverMcpPid) || recoverMcpPid < 2) throw new Error('Exact MCP process ID required for recovery.');
    args.splice(recoverIndex,2);
  }
  if (args.length > 1 || args[0]?.startsWith('-')) throw new Error('Expected optional Grok launcher and --recover-mcp-pid PID.');
  const launcher = args[0] ?? join(home, '.local', 'bin', 'grok');
  const nativeExecutable = await realpath(launcher);
  const { stdout } = await run(nativeExecutable, ['--version'], { timeout:5000 });
  const nativeVersion = stdout.trim().split(/\s+/)[1];
  if (!GROK_QUALIFIED_VERSIONS.includes(nativeVersion))
    throw new Error('This setup is qualified for Grok Build ' + GROK_QUALIFIED_VERSIONS.join(', ') + '.');
  const folder = join(home, '.agentspaces-desktop-native', 'automatic', 'grok');
  const configPath = join(folder, 'device.json');
  assertUnlinkedParents(folder);
  const grokHome = process.env.GROK_HOME ?? join(home, '.grok');
  assertUnlinkedParents(grokHome);
  const grokConfig = join(grokHome, 'config.toml');
  const existing = await lstat(grokConfig).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error('Grok settings must be a regular file.');
  await mkdir(folder, { recursive:true, mode:0o700 });
  if (existing) await writeFile(join(folder, 'grok-settings-' + randomUUID() + '.backup'), await readFile(grokConfig), { flag:'wx', mode:0o600 });
  const runtime = await privateFile(resolve(process.env.AGENTSPACES_STATE, 'runtime.json'));
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(runtime.address) || !/^[a-f0-9]{64}$/.test(runtime.admin))
    throw new Error('The companion must be listening on its private local address.');
  const response = await fetch(runtime.address + '/api/native/grok/setup', {
    method:'POST', headers:{ Authorization:'Bearer ' + runtime.admin, 'Content-Type':'application/json' },
    body:JSON.stringify({ nativeExecutable, nativeVersion, configPath, recoverMcpPid }),
    signal:AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('The companion refused the Grok device setup.');
  const { entry, nodeExecutable, managedRecovery, ...device } = await response.json();
  await writePrivate(configPath,JSON.stringify(device));
  try {
    await run(nativeExecutable, ['mcp','add','--scope','user','agentspaces-desktop','--',nodeExecutable,entry,'--config',configPath], { timeout:10000 });
  } catch {
    throw new Error('Grok refused the MCP settings update. The prior settings backup is private.');
  }
  if (managedRecovery) {
    await publishRecovery(configPath,managedRecovery);
    console.log('Grok connector installed and exact running MCP recovery published.');
  } else {
    console.log('Grok Build connector installed. In an open chat, use /mcps and press r to refresh.');
  }
}

try {
  await install();
} catch (error) {
  const message = error.constructor === Error && !error.code ? error.message : 'Local Grok connector setup failed.';
  console.error(message);
  process.exitCode = 1;
}
