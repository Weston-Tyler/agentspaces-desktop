import { homedir } from 'node:os';
import { readFileSync, lstatSync, existsSync } from "node:fs";
import { isAbsolute, dirname, join } from "node:path";
// Identity is part of durable source IDs, grants and native delivery receipts.
// Configure it before startup; changing an existing identity is not a migration.
export function remoteHostConfiguration(env = process.env, home = homedir()) {
  let saved = {};
  const defaultPath = join(home, '.agentspaces-desktop', 'host.json');
  const configuredPath = env.AGENTSPACES_HOST_CONFIG || (existsSync(defaultPath) ? defaultPath : undefined);
  if (configuredPath) {
    const path = configuredPath;
    if (!isAbsolute(path)) throw new Error('Remote host config requires an absolute private file');
    for (let part = path; ; part = dirname(part)) {
      const stat = lstatSync(part);
      if (stat.isSymbolicLink()) throw new Error('Remote host config refuses linked paths');
      if (part === path && (!stat.isFile() || stat.size > 4096 || process.platform !== 'win32' && ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()))) throw new Error('Remote host config requires an owner-private file');
      if (dirname(part) === part) break;
    }
    saved = JSON.parse(readFileSync(path, 'utf8'));
    if (!saved || saved.schema !== 1 || Object.keys(saved).some(key => !['schema', 'remoteHost', 'sshAlias'].includes(key))) throw new Error('Invalid remote host configuration schema');
  }
  const remoteHost = env.AGENTSPACES_REMOTE_HOST || (saved.remoteHost ?? 'remote');
  const sshAlias = env.AGENTSPACES_SSH_ALIAS || (saved.sshAlias ?? remoteHost);
  const valid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value) && value !== 'local';
  if (!valid(remoteHost) || !valid(sshAlias)) throw new Error('Invalid remote host configuration; use a non-local host label or SSH config alias');
  return Object.freeze({ remoteHost, sshAlias });
}
const configured = remoteHostConfiguration();
export const REMOTE_HOST = configured.remoteHost;
export const SSH_ALIAS = configured.sshAlias;

export function assertSavedHostIdentity(settings, index) {
  const hosts = [...(settings.desktopPreferences?.hosts ?? []), ...(index?.fixture ? [] : index?.profile?.hosts ?? [])];
  const retained = [
    ...Object.values(settings.nativeRegistrationDevices ?? {}),
    ...Object.values(settings.nativeSourceBindings ?? {}).map(binding => binding.identity),
    ...Object.values(settings.codexDiscussionNativeReceipts ?? {}),
    ...Object.values(settings.codexDiscussionProofs ?? {}),
    ...(settings.discussions ?? []).flatMap(room => room.members ?? []),
    ...(index?.fixture ? [] : index?.sessions ?? []),
    settings.participantBridge,
  ];
  for (const record of retained) if (record && !record.fixture && record.host !== undefined) hosts.push(record.host);
  if (hosts.some(host => host !== 'local' && host !== REMOTE_HOST)) throw new Error('Saved remote host identity differs from startup configuration. Set AGENTSPACES_REMOTE_HOST or AGENTSPACES_HOST_CONFIG to retain the existing identity; no state migration was performed.');
}
