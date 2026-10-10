import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflightUpdate } from '../app/update-preflight.mjs';
if (!process.env.AGENTSPACES_STATE) { console.error('Set AGENTSPACES_STATE to the existing private state directory.'); process.exitCode=1; }
else {
  try { console.log(JSON.stringify(await preflightUpdate({stateRoot:resolve(process.env.AGENTSPACES_STATE),candidateRoot:resolve(dirname(fileURLToPath(import.meta.url)),'..')}))); }
  catch (error) { console.error('Update preflight failed; running service was not stopped:',error.code ?? error.message);process.exitCode=1; }
}
