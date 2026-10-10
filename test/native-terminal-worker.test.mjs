import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';

function worker() {
  const proc = new EventEmitter(); Object.assign(proc, { connected: true, platform: 'linux', env: {}, cwd: () => '/tmp' });
  const sent = [], writes = [], exits = []; let killed = false, data, exit;
  proc.send = message => sent.push(message);
  proc.exit = code => exits.push(code);
  const terminal = { kill: () => { killed = true; }, write: text => writes.push(text), resize() {}, onData: fn => { data = fn; }, onExit: fn => { exit = fn; } };
  const source = readFileSync(new URL('../app/native-terminal-worker.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
  runInNewContext(source, { process: proc, Buffer, pty: { spawn: () => terminal }, isAbsolute: () => true, setTimeout: () => ({ unref() {} }) });
  proc.emit('message', { type: 'start', launch: { file: 'fixture', args: [], cwd: '/tmp' } });
  return { proc, sent, writes, exits, data: text => data(text), exit: () => exit({ exitCode: 0 }), killed: () => killed };
}

test('terminal worker preserves native work on disconnect, signals and legacy close', () => {
  const f = worker();
  f.proc.emit('message', { type: 'close' }); f.proc.emit('SIGTERM');
  f.proc.connected = false; f.proc.emit('disconnect'); f.data('late output');
  assert.equal(f.killed(), false); assert.deepEqual(f.exits, []);
  f.exit(); // Only the native process exiting ends its worker.
});
test('terminal backpressure and malformed input do not kill native work', () => {
  const f = worker(); f.data('x'.repeat(600000));
  f.proc.emit('message', { type: 'input', data: 'x'.repeat(8193) });
  f.proc.emit('message', { type: 'input', data: 'valid input' });
  assert.equal(f.killed(), false); assert.deepEqual(f.exits, []);
  assert.deepEqual(f.writes, ['valid input']);
  assert(f.sent.filter(m => m.type === 'data').reduce((sum, m) => sum + Buffer.byteLength(m.data), 0) <= 256 * 1024);
});
