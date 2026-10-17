import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNativeInboxHook } from '../app/native-inbox-hook.mjs';
import { Engine } from '../app/engine.mjs';
import { Store } from '../app/store.mjs';
import { startServer } from '../app/server.mjs';

const uuid = '00000000-0000-4000-8000-000000000001';
const event = { hook_event_name: 'Stop', session_id: uuid, cwd: '/fictional/project' };
const meta = { request_id: 'fixture-native-request', discussion_id: '00000000-0000-4000-8000-000000000002', message_id: '00000000-0000-4000-8000-000000000003' };
const binding = { nativeThreadId: uuid, config: { nativeThreadId: uuid, provider: 'claude', address: 'http://127.0.0.1:41234', authority: '127.0.0.1:43127', token: 'a'.repeat(64) } };
const tick = () => new Promise(resolve => setImmediate(resolve));
class Socket extends EventEmitter {
  static calls = [];
  constructor(url, options) { super(); Socket.calls.push({ url, options, socket: this }); }
  terminate() { this.terminated = true; }
}
const options = extra => ({ registerHook: async () => ({ recorded: true, nativeThreadId: uuid }), resolveBinding: async () => binding, WebSocketClass: Socket, waitMs: 1000, ...extra });

test('genuine Stop wake uses a source-bound inbox without channel launch opt-in', async () => {
  Socket.calls = []; const calls = [];
  const result = runNativeInboxHook(event, options({ registerHook: async input => { calls.push(input); return { recorded: true, nativeThreadId: uuid }; } }));
  await tick(); assert.equal(Socket.calls.length, 1); assert.equal(calls[0].hook_event_name, 'Stop');
  const connection = Socket.calls[0];
  assert.equal(connection.url, 'ws://127.0.0.1:41234/api/native/hook'); assert.equal(connection.options.headers.Host, binding.config.authority);
  connection.socket.emit('message', JSON.stringify({ content: 'A real peer answer\x1b[31m ' + binding.config.token, meta }));
  const wake = await result;
  assert.equal(wake.exitCode, 2); assert.match(wake.stderr, /untrusted evidence/); assert.match(wake.stderr, /reply_native_channel/);
  assert(wake.stderr.includes(meta.request_id)); assert(!wake.stderr.includes(binding.config.token)); assert(!wake.stderr.includes('\x1b'));
  assert.equal(connection.socket.terminated, true);
});
test('non-Stop events, subagents and unadmitted identities cannot arm or wake a session', async () => {
  Socket.calls = [];
  for (const input of [{ ...event, hook_event_name: 'SessionStart' }, { ...event, agent_id: 'subagent-fixture' }]) assert.equal((await runNativeInboxHook(input, options())).exitCode, 0);
  const pending = await runNativeInboxHook(event, options({ registerHook: async () => ({ recorded: true, pending: true, nativeThreadId: uuid }) }));
  assert.equal(pending.exitCode, 0); assert.equal(pending.stderr, ''); assert.equal(Socket.calls.length, 0);
});
test('invalid packets do not wake and a changed live identity refuses a valid message', async () => {
  Socket.calls = []; let current = binding;
  const waiting = runNativeInboxHook(event, options({ resolveBinding: async () => current })); await tick(); const socket = Socket.calls[0].socket;
  socket.emit('message', '{invalid'); socket.emit('message', JSON.stringify({ content: 'No exact receipt', meta: {} }));
  await tick(); assert.equal(socket.terminated, undefined);
  current = { ...binding, nativeThreadId: meta.discussion_id };
  socket.emit('message', JSON.stringify({ content: 'Wrong identity', meta }));
  assert.equal((await waiting).exitCode, 0);
});
test('a replaced or expired hook exits quietly rather than starting an empty turn', async () => {
  Socket.calls = [];
  const waiting = runNativeInboxHook(event, options()); await tick(); Socket.calls[0].socket.emit('close', 4001);
  assert.equal((await waiting).exitCode, 0);
  const expired = await runNativeInboxHook(event, options({ waitMs: 5 })); assert.equal(expired.reason, 'wait-expired'); assert.equal(expired.stderr, '');
});
test('transport reconnect only rearms the listener; it never invents or replays a native event', async () => {
  Socket.calls = []; const waiting = runNativeInboxHook(event, options({ retryMinMs: 1 })); await tick();
  Socket.calls[0].socket.emit('close', 1006); await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(Socket.calls.length, 2);
  Socket.calls[1].socket.emit('message', JSON.stringify({ content: 'First actual queued event', meta }));
  assert.equal((await waiting).exitCode, 2);
});

test('a temporary registration transport outage does not disable an admitted background listener', async () => {
  Socket.calls = []; let attempts = 0;
  const waiting = runNativeInboxHook(event, options({ retryMinMs: 1, resolveBinding: async () => {
    if (++attempts === 1) throw Object.assign(Error('offline'), { code: 'scoped_transport_unavailable' });
    return binding;
  } }));
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(Socket.calls.length, 1);
  Socket.calls[0].socket.emit('message', JSON.stringify({ content: 'Queued while briefly offline', meta }));
  assert.equal((await waiting).exitCode, 2);
});

test('real HTTP/WebSocket inbox requests one native wake and retains the next queued effect', { timeout: 10000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'as-hook-wire-'));
  const engine = new Engine(new Store(root), { diagnostics: () => ({ status: 'fixture' }), close() {} }, { nativeFactory: () => { throw Error('No native history or models allowed'); } });
  engine.loadSample(); const ids = ['sample-codex-old', 'sample-claude-old'];
  const native = engine.catalog.find(row => row.id === ids[1]); native.fixture = false; native.nativeThreadId = uuid;
  for (const id of ids) engine.grant(id, { enrolled: true, content: true, share: true, retrieve: true });
  const group = engine.discussions.create({ title: 'Synthetic remote hook transport', sessionIds: ids });
  const connector = engine.issueConnector(ids[1]); const app = await startServer({ root, port: 0, engine });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const scoped = { nativeThreadId: uuid, config: { ...connector, provider: 'claude', nativeThreadId: uuid, address: app.address, authority: new URL(app.address).host } };
  const hookOptions = { registerHook: async () => ({ recorded: true, nativeThreadId: uuid }), resolveBinding: async () => scoped, waitMs: 5000 };
  const waiting = runNativeInboxHook(event, hookOptions);
  const readyBy = Date.now() + 2000;
  while (!app.channels.isConnected(ids[1]) && Date.now() < readyBy) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(app.channels.transportKind(ids[1]), 'async-hook');
  const post = async (text, deliveryId) => {
    const response = await fetch(app.address + '/api/discussions/post', { method: 'POST', headers: { Authorization: 'Bearer ' + app.admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: group.id, text, targets: [ids[1]], deliveryId }) });
    assert.equal(response.status, 200); return response.json();
  };
  await post('Synthetic first message', 'native-hook-first-post');
  const wake = await waiting; assert.equal(wake.exitCode, 2); assert.match(wake.stderr, /Synthetic first message/);
  const queued = await post('Synthetic second message', 'native-hook-second-post');
  assert.equal(queued.messages.at(-1).targets[0].status, 'waiting-for-native-transport');
  const next = await runNativeInboxHook(event, hookOptions);
  assert.equal(next.exitCode, 2); assert.match(next.stderr, /Synthetic second message/); assert(!next.stderr.includes('Synthetic first message'));
  assert.equal(Object.values(app.store.data.channelReceipts).filter(row => row.status === 'delivered-to-native-transport').length, 2);
});
