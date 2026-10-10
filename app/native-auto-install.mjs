import { REMOTE_HOST, SSH_ALIAS } from "./remote-host.mjs";
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, lstatSync, realpathSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const marker = 'agentspaces-automatic-native-v1';
const digest = value => createHash('sha256').update(value).digest('hex');

function noLinks(path) {
  for (let p = resolve(path); ; p = dirname(p)) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error('Automatic setup refuses linked paths');
    if (dirname(p) === p) break;
  }
}
function savePrivate(path, text) {
  noLinks(path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + '.' + randomUUID() + '.tmp'; writeFileSync(temp, text, { flag: 'wx', mode: 0o600 }); renameSync(temp, path);
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}
function privateBackup(path) {
  if (existsSync(path)) savePrivate(path + '.agentspaces-' + randomUUID() + '.backup', readFileSync(path));
}
function executable(name) {
  const output = process.platform === 'win32'
    ? execFileSync('where.exe', [name], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    : execFileSync('sh', ['-c', 'command -v "$1"', 'agentspaces', name], { encoding: 'utf8', timeout: 5000 });
  const candidates = output.trim().split(/\r?\n/);
  const path = candidates.find(candidate => /\.exe$/i.test(candidate)) ?? candidates.find(candidate => /\.cmd$/i.test(candidate)) ?? candidates[0];
  if (!path || !existsSync(path)) throw new Error('Native executable unavailable');
  return realpathSync(path);
}
function cli(binary, args, { acceptedFailure = false, timeout = 15000, cwd } = {}) {
  // Token values never appear in arguments. Native diagnostics stay private.
  return new Promise((yes, no) => execFile(binary, args, { encoding: 'utf8', timeout, cwd, windowsHide: true, maxBuffer: 1048576 }, (error, stdout) => {
    if (!error) yes(stdout); else if (acceptedFailure) yes(null); else no(new Error('Native registration command unavailable'));
  }));
}
export function mergeClaudeHooks(settings, command, { previousCommand } = {}) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || settings.hooks && (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) throw new Error('Existing native hook settings are invalid');
  const result = structuredClone(settings); result.hooks ??= {};
  for (const event of ['SessionStart', 'UserPromptSubmit', 'SessionEnd']) {
    let existing = result.hooks[event] ?? [];
    if (!Array.isArray(existing)) throw new Error('Existing native hook settings are invalid');
    if (previousCommand && previousCommand !== command) existing = existing.map(group => ({ ...group, hooks: group.hooks?.filter(hook => hook.command !== previousCommand) })).filter(group => !Array.isArray(group.hooks) || group.hooks.length);
    result.hooks[event] = existing;
    if (!existing.some(group => group.hooks?.some(hook => hook.type === 'command' && hook.command === command))) result.hooks[event] = [...existing, { hooks: [{ type: 'command', command, timeout: 15 }] }];
  }
  return result;
}
export async function installOnCurrentHost({ config, sources, versions, home = homedir(), nodeBinary = process.env.AGENTSPACES_NODE_BINARY ?? (process.versions.electron ? executable('node') : process.execPath), runCLI = cli, resolveExecutable = executable, installDependencies = true } = {}) {
  if (config?.schemaVersion !== 1 || !['codex', 'claude'].includes(config.provider) || !/^[a-f0-9]{64}$/.test(config.token ?? '') || !sources?.bootstrap || !sources?.hook || !sources?.channel) throw new Error('Invalid automatic installation payload');
  if (!versions || ['mcp', 'zod', 'claude','ws'].some(key => {
    const value = versions[key];
    return typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value) || value.includes('-') && value.slice(value.indexOf('-') + 1).split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'));
  })) throw new Error('Exact managed dependency versions payload required');
  const base = join(home, '.agentspaces-desktop-native', 'automatic'); noLinks(base);
  const settingsPath = join(home, '.claude', 'settings.json'); let settings = {};
  if (config.provider === 'claude') {
    noLinks(settingsPath);
    if (existsSync(settingsPath)) { try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { throw new Error('Existing native settings are invalid'); } }
    mergeClaudeHooks(settings, 'preflight-only');
  }
  if (existsSync(base) && (!existsSync(join(base, 'OWNER')) || readFileSync(join(base, 'OWNER'), 'utf8') !== marker)) throw new Error('Unmanaged automatic runtime');
  mkdirSync(base, { recursive: true, mode: 0o700 }); savePrivate(join(base, 'OWNER'), marker);
  if (process.platform === 'win32') {
    const sid = execFileSync('powershell.exe', ['-NoProfile', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8', windowsHide: true }).trim();
    if (!/^S-\d+(?:-\d+)+$/.test(sid)) throw new Error('Private native runtime owner unavailable');
    execFileSync('icacls.exe', [base, '/inheritance:r', '/grant:r', '*' + sid + ':(OI)(CI)F'], { windowsHide: true, stdio: 'pipe' });
  } else chmodSync(base, 0o700);
  const runtime = join(base, 'runtime-' + digest(sources.bootstrap + sources.hook + sources.channel)); noLinks(runtime); mkdirSync(runtime, { recursive: true, mode: 0o700 });
  savePrivate(join(runtime, 'native-bootstrap-mcp.mjs'), sources.bootstrap); savePrivate(join(runtime, 'native-session-hook.mjs'), sources.hook);savePrivate(join(runtime,'native-bootstrap-channel.mjs'),sources.channel);
  const manifest = { private: true, type: 'module', dependencies: { '@modelcontextprotocol/sdk': versions.mcp, zod: versions.zod, '@anthropic-ai/claude-agent-sdk': versions.claude,ws:versions.ws } };
  savePrivate(join(base, 'package.json'), JSON.stringify(manifest));
  const dependenciesPresent = () => Object.entries(manifest.dependencies).every(([name, version]) => {
    const path = join(base, 'node_modules', name, 'package.json'); noLinks(path);
    try { return JSON.parse(readFileSync(path, 'utf8')).version === version; } catch { return false; }
  });
  if (installDependencies && !dependenciesPresent()) {
    const npm = executable('npm');
    if (/\.(cmd|bat)$/i.test(npm)) {
      const npmJS = join(dirname(npm), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      await runCLI(nodeBinary, [npmJS, 'install', '--prefix', base, '--ignore-scripts', '--no-audit', '--no-fund'], { timeout: 55000 });
    } else await runCLI(npm, ['install', '--prefix', base, '--ignore-scripts', '--no-audit', '--no-fund'], { timeout: 55000 });
  }
  if (installDependencies) {
    if (!dependenciesPresent()) throw new Error('Automatic native runtime dependencies are not ready');
    await runCLI(nodeBinary, ['--input-type=module', '-e', "await import('@modelcontextprotocol/sdk/server/index.js');await import('@modelcontextprotocol/sdk/server/stdio.js');await import('zod');await import('@anthropic-ai/claude-agent-sdk');await import('ws');"], { cwd: base, timeout: 10000 });
  }
  const binary = resolveExecutable(config.provider), folder = join(base, config.provider), configPath = join(folder, 'device.json');
  const device = { ...config, ...(config.provider === 'claude' ? { nativeExecutable: binary } : {}) };
  savePrivate(configPath, JSON.stringify(device));
  const bootstrap = join(runtime, 'native-bootstrap-mcp.mjs'), name = 'agentspaces-desktop';
  const nativePath = config.provider === 'codex' ? join(home, '.codex', 'config.toml') : join(home, '.claude.json');
  noLinks(nativePath);
  let existing;
  if (config.provider === 'codex') {
    const response = await runCLI(binary, ['mcp', 'get', name, '--json'], { acceptedFailure: true });
    if (response) { try { existing = JSON.parse(response); } catch { throw new Error('Native MCP registration could not be inspected'); } }
  } else if (existsSync(nativePath)) {
    try { existing = JSON.parse(readFileSync(nativePath, 'utf8')).mcpServers?.[name]; } catch { throw new Error('Native MCP registration could not be inspected'); }
  }
  const transport = existing?.transport ?? existing;
  const oldBootstrap = transport?.args?.find(arg => typeof arg === 'string' && arg.endsWith('native-bootstrap-mcp.mjs'));
  if (oldBootstrap) noLinks(oldBootstrap);
  const oldRuntime = oldBootstrap && dirname(oldBootstrap);
  const oldChannel=oldRuntime&&join(oldRuntime,'native-bootstrap-channel.mjs');if(oldChannel)noLinks(oldChannel);
  const ownedOldRuntime = oldRuntime && dirname(oldRuntime) === base && /runtime-[a-f0-9]{64}$/.test(oldRuntime) && existsSync(oldBootstrap) && existsSync(join(oldRuntime, 'native-session-hook.mjs')) && oldRuntime.endsWith(digest(readFileSync(oldBootstrap, 'utf8') + readFileSync(join(oldRuntime, 'native-session-hook.mjs'), 'utf8') + (existsSync(oldChannel)?readFileSync(oldChannel,'utf8'):'')));
  if (existing && ((!transport?.args?.includes(bootstrap) && !ownedOldRuntime) || !transport?.args?.includes(configPath) || transport?.command !== nodeBinary)) throw new Error('Existing MCP name is not this managed installation');
  if (!existing || oldBootstrap !== bootstrap) {
    privateBackup(nativePath);
    const args = config.provider === 'codex' ? ['mcp', 'add', name, '--', nodeBinary, bootstrap, '--config', configPath] : ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', name, '--', nodeBinary, bootstrap, '--config', configPath];
    const before = existsSync(nativePath) ? readFileSync(nativePath) : null;
    try {
      if (existing && config.provider === 'claude') await runCLI(binary, ['mcp', 'remove', '--scope', 'user', name]);
      await runCLI(binary, args);
    } catch (error) { if (before) savePrivate(nativePath, before); throw error; }
  }
  if (config.provider === 'claude') {
    const quote = value => process.platform === 'win32' ? '"' + value.replaceAll('"', '') + '"' : "'" + value.replaceAll("'", "'\\''") + "'";
    const command = [nodeBinary, join(runtime, 'native-session-hook.mjs'), '--config', configPath].map(quote).join(' ');
    const previousCommand = ownedOldRuntime ? [nodeBinary, join(oldRuntime, 'native-session-hook.mjs'), '--config', configPath].map(quote).join(' ') : undefined;
    const merged = mergeClaudeHooks(settings, command, { previousCommand });
    if (JSON.stringify(merged) !== JSON.stringify(settings)) { privateBackup(settingsPath); savePrivate(settingsPath, JSON.stringify(merged, null, 2)); }
  }
  return { host: config.host, provider: config.provider, status: 'native-config-installed', configPath, bootstrapPath: bootstrap, activeSessionReloaded: false, inboundChannelConnected: false };
}

export function remoteInstallScript(payload) {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8').replace('import { REMOTE_HOST, SSH_ALIAS } from "./remote-host.mjs";', 'const REMOTE_HOST=' + JSON.stringify(REMOTE_HOST) + ',SSH_ALIAS=' + JSON.stringify(SSH_ALIAS) + ';');
  return source + '\nconst result=await installOnCurrentHost(' + JSON.stringify(payload) + ');console.log(JSON.stringify(result));';
}
async function remoteInstall(payload) {
  const script = remoteInstallScript(payload);
  return new Promise((yes, no) => {
    const child = spawn('ssh', [SSH_ALIAS, 'node --input-type=module -'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); let output = '', settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); if (error) { child.kill(); no(error); } else yes(result); };
    const timer = setTimeout(() => finish(new Error('Automatic remote setup timed out')), 60000);
    child.stderr.on('data', () => {}); child.stdout.on('data', data => { output += data; if (output.length > 16384) finish(new Error('Automatic remote setup response too large')); });
    child.on('error', () => finish(new Error('Automatic remote setup unavailable')));
    child.on('close', code => { try { if (code !== 0) throw new Error(); finish(null, JSON.parse(output)); } catch { finish(new Error('Automatic remote setup unavailable')); } });
    child.stdin.on('error', () => finish(new Error('Automatic remote setup unavailable'))); child.stdin.end(script);
  });
}
export class NativeAutoInstaller {
  constructor(engine, { sourceBindings, participantConnections, address, installLocal = installOnCurrentHost, installRemote = remoteInstall, refreshNative = async () => ({ status: 'new-session-load-required' }) } = {}) {
    Object.assign(this, { engine, sourceBindings, participantConnections, address, installLocal, installRemote, refreshNative }); this.pending = new Map();
    engine.store.data.nativeAutomaticInstallations ??= {};
  }
  async install({ host, provider }) {
    const key = host + ':' + provider;
    if (this.pending.has(key)) return this.pending.get(key);
    const run = this.run({ host, provider }).finally(() => this.pending.delete(key)); this.pending.set(key, run); return run;
  }
  summary() {
    return Object.entries(this.engine.store.data.nativeAutomaticInstallations).map(([key, value]) => ({ host: key.split(':')[0], provider: key.split(':')[1], status: value.status, nativeRefresh: value.nativeRefresh ?? 'not-requested', activeSessionReloaded: false, inboundChannelConnected: false }));
  }
  async setup() {
    const profile = this.sourceBindings.profile(), results = [];
    for (const host of profile.hosts) {
      if (!['local', REMOTE_HOST].includes(host)) continue;
      try { await this.engine.probe(host); } catch { results.push({ host, status: 'native-host-unavailable' }); continue; }
      for (const provider of profile.providers) {
        if (!this.engine.tools.some(tool => tool.host === host && tool.provider === provider && tool.installed)) { results.push({ host, provider, status: 'native-app-not-installed' }); continue; }
        try { const value = await this.install({ host, provider }); results.push({ host, provider, status: value.status, nativeRefresh: value.nativeRefresh, activeSessionReloaded: false, inboundChannelConnected: false }); }
        catch { results.push({ host, provider, status: 'native-setup-unavailable', activeSessionReloaded: false, inboundChannelConnected: false }); }
      }
    }
    return { results, modelCalls: 0 };
  }
  async run({ host, provider }) {
    const { dependencyVersions } = await import('./dependency-versions.mjs');
    const versions = dependencyVersions();
    const key = host + ':' + provider, records = this.engine.store.data.nativeAutomaticInstallations, old = records[key];
    let device, tunnel;
    if (old?.device) { this.sourceBindings.device(old.device.token); device = old.device; }
    else { const issued = this.sourceBindings.issueDevice({ host, provider }); device = { schemaVersion: 1, ...issued, address: this.address, authority: new URL(this.address).host }; }
    device = { ...device, address: this.address, authority: new URL(this.address).host };
    if (host === REMOTE_HOST) { tunnel = await this.participantConnections.tunnel(); device = { ...device, address: 'http://127.0.0.1:' + tunnel.remotePort }; }
    const sources = { bootstrap: readFileSync(new URL('./native-bootstrap-mcp.mjs', import.meta.url), 'utf8'), hook: readFileSync(new URL('./native-session-hook.mjs', import.meta.url), 'utf8'),channel:readFileSync(new URL('./native-bootstrap-channel.mjs',import.meta.url),'utf8') };
    try {
      const result = await (host === REMOTE_HOST ? this.installRemote : this.installLocal)({ config: device, sources, versions });
      this.sourceBindings.device(device.token); // Recheck after installation; never undo a revocation.
      const refresh = provider === 'codex' ? await this.refreshNative(host) : { status: 'new-session-load-required' };
      result.nativeRefresh = refresh.status;
      records[key] = { device, status: result.status, nativeRefresh: result.nativeRefresh, activeSessionReloaded: false, inboundChannelConnected: false, at: new Date().toISOString(), configPath: result.configPath, bootstrapPath: result.bootstrapPath }; this.engine.store.save();
      if (host === REMOTE_HOST) this.participantConnections.retain(tunnel);
      return result;
    } catch {
      if (!old?.device) delete this.engine.store.data.nativeRegistrationDevices[digest(device.token)]; this.engine.store.save();
      throw new Error('Automatic native configuration unavailable; native sessions preserved');
    }
  }
}
