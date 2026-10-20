import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
const root = resolve('node_modules/@agentspaces/client');
if (!existsSync(join(root, 'tsconfig.json')))
  throw new Error('Pinned AgentSpaces source dependency is missing.');
// Compile the dependency's runtime only. Its test/demo projects use its own
// development lockfile and are qualified separately, not against Desktop's types.
const config = join(root, `.desktop-build-${randomUUID()}.json`);
try {
  // Upstream's workspace config still names baseUrl (removed in TypeScript 7).
  // Its paths are already relative. Build a runtime-only config beside it without
  // changing the pinned source or compiling its demos/workspace packages.
  const { compilerOptions } = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
  delete compilerOptions.baseUrl;
  writeFileSync(config, JSON.stringify({compilerOptions,include:['src/**/*.ts']}), {flag:'wx'});
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', config], {stdio:'inherit'});
} finally {
  if (existsSync(config)) unlinkSync(config);
}
