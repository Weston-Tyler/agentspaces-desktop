import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { SSH_ALIAS } from './remote-host.mjs';

const hex = /^[a-f0-9]{64}$/;
// This signer never leaves the owning companion. The narrow liveness response
// contains no credentials, identity, process IDs, grants or workspace content.
export function createBridgeHealth() {
  const key = randomBytes(32);
  const sign = (nonce, state) => createHmac('sha256', key).update(nonce + '\0' + state).digest('hex');
  return {
    respond(nonce, state = 'running') {
      if (!hex.test(nonce ?? '') || !['running', 'stopping'].includes(state)) return null;
      return { nonce, state, proof: sign(nonce, state) };
    },
    verify(response, nonce) {
      return hex.test(nonce ?? '') && response?.nonce === nonce && response?.state === 'running' && hex.test(response?.proof ?? '') &&
        timingSafeEqual(Buffer.from(response.proof, 'hex'), Buffer.from(sign(nonce, 'running'), 'hex'));
    },
  };
}

export function probeRemoteBridge({ remotePort, authority, nonce }, { spawnProcess = spawn, timeoutMs = 8000 } = {}) {
  if (!Number.isInteger(remotePort) || remotePort < 1024 || remotePort > 65535 || !/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(authority ?? '') || Number(authority.split(':')[1]) > 65535 || !hex.test(nonce ?? '')) throw new Error('Invalid bridge probe');
  const script = `import http from 'node:http';const req=http.get({host:'127.0.0.1',port:${remotePort},path:'/api/native/bridge-probe?nonce=${nonce}',headers:{Host:${JSON.stringify(authority)}}},res=>{let text='';res.on('data',d=>{text+=d;if(text.length>4096)req.destroy();});res.on('end',()=>{if(res.statusCode!==200)process.exitCode=1;else process.stdout.write(text);});});req.setTimeout(2500,()=>req.destroy());req.on('error',()=>{process.exitCode=1;});`;
  return new Promise((resolve, reject) => {
    const child = spawnProcess('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', SSH_ALIAS, 'node --input-type=module -'], { windowsHide: true, shell: false, stdio: Array(3).fill(process.platform === 'win32' ? 'overlapped' : 'pipe') });
    let output = '', authRequired = false, settled = false;
    const finish = (code, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code) { child.kill(); reject(Object.assign(new Error(code), { code })); } else resolve(value);
    };
    const timer = setTimeout(() => finish(authRequired ? 'bridge_authentication_required' : 'bridge_probe_timeout'), timeoutMs);
    child.stdout.on('data', data => { output += data; if (output.length > 4096) finish('bridge_probe_invalid'); });
    child.stderr.on('data', data => { if (/additional check|authenticate, visit|permission denied/i.test(String(data))) authRequired = true; });
    child.on('error', () => finish('bridge_probe_unavailable'));
    child.on('close', code => {
      if (code) return finish(authRequired ? 'bridge_authentication_required' : 'bridge_probe_unavailable');
      try { finish(null, JSON.parse(output)); } catch { finish('bridge_probe_invalid'); }
    });
    child.stdin.on('error', () => finish('bridge_probe_unavailable'));
    child.stdin.end(script);
  });
}
