import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
const root = resolve('node_modules/@agentspaces/client');
if (!existsSync(join(root, 'tsconfig.json')))
  throw new Error('Pinned AgentSpaces source dependency is missing.');
// Compile the dependency's runtime only. Its test/demo projects use its own
// development lockfile and are qualified separately, not against Desktop's types.
const config = join(root, `.desktop-build-${randomUUID()}.json`);
try {
  writeFileSync(config, JSON.stringify({extends:'./tsconfig.json',include:['src/**/*.ts']}), {flag:'wx'});
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', config], {stdio:'inherit'});
} finally {
  if (existsSync(config)) unlinkSync(config);
}
