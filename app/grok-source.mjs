import { readFile, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { inspectProcess, nativeUuid, privateFile } from './native-session-hook.mjs';

export const GROK_QUALIFIED_VERSION = '1.0.88';
export const GROK_QUALIFIED_VERSIONS = Object.freeze([GROK_QUALIFIED_VERSION,'1.0.92']);

const sessionFrom = env => {
  const matches = env.split('\0').filter(value => value.startsWith('GROK_SESSION_ID='));
  const id = matches.length === 1 ? matches[0].slice('GROK_SESSION_ID='.length) : null;
  return nativeUuid.test(id ?? '') ? id : null;
};

export async function authorizeGrokRecovery(pid, device, home = homedir()) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid < 2) return null;
  const base = join(home, '.agentspaces-desktop-native', 'automatic');
  const legacyConfig = join(base, 'claude', 'device.json');
  try {
    const processState = await inspectProcess(pid);
    const [command, env] = await Promise.all([
      readFile('/proc/' + pid + '/cmdline', 'utf8'),
      readFile('/proc/' + pid + '/environ', 'utf8'),
    ]);
    const [, entry, flag, configPath] = command.split('\0').slice(0, -1);
    if (flag !== '--config' || configPath !== legacyConfig || !entry ||
        dirname(dirname(entry)) !== base || basename(entry) !== 'native-bootstrap-mcp.mjs' ||
        await realpath(entry) !== entry) return null;
    const manifest = await privateFile(join(base, 'managed', 'current.json'));
    if (manifest.schema !== 1 || manifest.protocol !== 1) return null;
    const folder = basename(dirname(entry));
    const allowedHash = folder === 'managed' ? manifest.entryHash :
      /^runtime-[0-9a-f]{64}$/.test(folder) ? manifest.aliases?.[folder]?.[basename(entry)] : null;
    if (!allowedHash || createHash('sha256').update(await readFile(entry)).digest('hex') !== allowedHash) return null;
    const nativeThreadId = sessionFrom(env);
    const recovery = { pid, startedAt:processState.startedAt, entry, configPath, nativeThreadId };
    return await observeGrokSource({ pid, nativeThreadId, device:{...device,recovery} }) ? recovery : null;
  } catch {
    return null;
  }
}

// Grok Build injects GROK_SESSION_ID into its stdio MCP child. Observe the
// installed entry and its live native parent locally before binding that ID.
export async function observeGrokSource({ pid, nativeThreadId, device }) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid < 2 || !nativeUuid.test(nativeThreadId)) return null;
  const proc = '/proc/' + pid;
  try {
    const child = await inspectProcess(pid);
    if (child.exe !== device.nodeExecutable) return null;
    const parent = await inspectProcess(child.parentPid);
    const nativeRuntime = [ {executable:device.nativeExecutable, version:device.nativeVersion},
      ...(device.nativeRuntimes ?? []) ].find(runtime => runtime.executable === parent.exe);
    if (!nativeRuntime) return null;
    const [cmd, env, cwd] = await Promise.all([
      readFile(proc + '/cmdline', 'utf8'),
      readFile(proc + '/environ', 'utf8'),
      readlink(proc + '/cwd'),
    ]);
    const args = cmd.split('\0').slice(0, -1);
    const recovery = device.recovery;
    const allowed = [device.entry, ...(device.entries ?? [])].includes(args[1]) && args[3] === device.configPath ||
      recovery?.pid === pid && recovery.startedAt === child.startedAt && recovery.nativeThreadId === nativeThreadId &&
      recovery.entry === args[1] && recovery.configPath === args[3];
    if (args.length !== 4 || args[2] !== '--config' || !allowed || sessionFrom(env) !== nativeThreadId) return null;
    if (!isAbsolute(cwd) || cwd.endsWith(' (deleted)') || await realpath(cwd) !== cwd) return null;
    const [currentChild, currentParent] = await Promise.all([inspectProcess(pid), inspectProcess(parent.pid)]);
    if (currentChild.startedAt !== child.startedAt || currentChild.parentPid !== parent.pid ||
        currentParent.startedAt !== parent.startedAt || currentChild.exe !== child.exe || currentParent.exe !== parent.exe) return null;
    return {
      nativeThreadId, cwd, provider: 'grok', host: device.host, nativeObserved: true,
      title: 'Grok Build session', sourceVersion: nativeRuntime.version, status: 'unknown',
    };
  } catch {
    return null;
  }
}
