import { readdirSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';

// Discover executable locations only; never inspect provider authentication or
// conversation files. A packaged/background process lacks IDE-injected PATH.
export function addNativeToolPaths({ home = homedir(), platform = process.platform, environment = process.env } = {}) {
  if (platform !== 'win32') return [];
  const directories = [], root = join(home, 'AppData', 'Local', 'OpenAI', 'Codex', 'bin');
  try {
    const candidates = readdirSync(root).map(name => join(root,name,'codex.exe')).filter(existsSync).sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs);
    if(candidates[0]) directories.push(dirname(candidates[0]));
  } catch {}
  for (const path of [join(home,'.local','bin'),join(home,'AppData','Roaming','npm')]) if(existsSync(path)) directories.push(path);
  if(directories.length) environment.PATH = [...directories, environment.PATH ?? environment.Path ?? ''].join(delimiter);
  return directories;
}
