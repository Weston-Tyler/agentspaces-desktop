import { loadOrCreateIdentity } from "@agentspaces/client/node";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../app/store.mjs';
import { Engine } from '../app/engine.mjs';
import { WorkBoard } from '../app/work-board-service.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'as-work-events-'));
  let now = Date.now();
  const engine = new Engine(new Store(root), { diagnostics: () => ({}), close() {} }, {
    clock: () => now, nativeFactory: () => { throw Error('No native execution'); },
  });
  engine.workspace.index = { profile: { id: 'scope', account: 'synthetic-account', active: true, policy: 'local-retrieval' } };
  engine.discussions.participant = binding => {
    if (binding.revoked) throw Error('revoked');
    return { id: binding.sessionId, scopeId: binding.scopeId ?? 'scope', account: 'synthetic-account' };
  };
  t.after(() => { engine.workBoard.close?.(); rmSync(root, { recursive: true, force: true }); });
  return { engine, board: engine.workBoard, root, advance: ms => { now += ms; } };
}
const create = { action: 'create', deliveryId: 'create-events-0001', title: 'Synthetic item', brief: 'Fixture brief', repository: 'https://example.invalid/repo', base: 'a'.repeat(40), allowedFiles: 'src/one.js' };
const claim = entryId => ({ action: 'claim', entryId, leaseMinutes: 1, deliveryId: 'claim-events-0001' });
const complete = entryId => ({ action: 'complete', entryId, deliveryId: 'complete-events-0001', summary: 'Fixture passed', branch: 'test/fixture', head: 'b'.repeat(40), evidence: 'Synthetic evidence only' });
const kinds = board => board.view(null).activity.events.map(event => event.kind);

test('upstream work events follow durable writes, claims and completion without native work', async t => {
  const f = fixture(t), actor = { sessionId: 'fixture-agent' };
  const item = await f.board.mutate(create, actor);
  assert.deepEqual(kinds(f.board), ['WRITTEN']);
  await f.board.mutate(claim(item.entryId), actor);
  assert.deepEqual(kinds(f.board), ['WRITTEN', 'TAKEN']);
  await assert.rejects(f.board.mutate(complete(item.entryId), { sessionId: 'other-agent' }), /live claim/);
  assert.deepEqual(kinds(f.board), ['WRITTEN', 'TAKEN']);
  await f.board.mutate(complete(item.entryId), actor);
  assert.deepEqual(kinds(f.board), ['WRITTEN', 'TAKEN', 'COMPLETED', 'WRITTEN']);
  const activity = f.board.view(null).activity;
  assert.equal(activity.source, 'upstream Space.watch');
  assert.equal(activity.persisted, false);
  assert.equal(activity.completeHistory, false);
  assert.equal(activity.events.at(-1).recordType, 'result');
  assert.equal(activity.events.at(-1).workEntryId, item.entryId);
  assert.equal(f.engine.modelCalls, 0);
});

test('claim expiry reappears once per observed claim epoch, write expiry stays read-only', async t => {
  const f = fixture(t), item = await f.board.mutate(create, null);
  await f.board.mutate(claim(item.entryId), null);
  const saved = readFileSync(f.board.path);
  f.advance(61000);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(f.board.activity.view().events.at(-1).kind, 'REAPPEARED', 'upstream timer observes the expiry without a read or write');
  assert.equal(f.board.view(null).items[0].status, 'available');
  assert.equal(kinds(f.board).filter(kind => kind === 'REAPPEARED').length, 1);
  assert.deepEqual(readFileSync(f.board.path), saved, 'expiry observation must not rewrite durable work');
  await f.board.mutate({ ...claim(item.entryId), deliveryId: 'claim-events-0002' }, null);
  f.advance(61000);
  assert.equal(kinds(f.board).filter(kind => kind === 'REAPPEARED').length, 2);
  f.advance(30 * 86400000);
  assert.equal(f.board.view(null).items[0].status, 'expired');
  assert.equal(kinds(f.board).filter(kind => kind === 'EXPIRED').length, 1);
  assert.equal(f.engine.modelCalls, 0);
});

test('restart is a silent current-state baseline; duplicate receipts never replay activity', async t => {
  const f = fixture(t), item = await f.board.mutate(create, null);
  await f.board.mutate(claim(item.entryId), null);
  const restored = new WorkBoard(f.engine); t.after(() => restored.close());
  assert.deepEqual(kinds(restored), []);
  assert.deepEqual(kinds(restored), [], 'restored claims must not appear as fresh TAKEN events');
  await restored.mutate(claim(item.entryId), null);
  assert.deepEqual(kinds(restored), []);
  f.advance(61000);
  assert.deepEqual(kinds(restored), ['REAPPEARED']);
  const afterExpiry = new WorkBoard(f.engine); t.after(() => afterExpiry.close());
  assert.deepEqual(kinds(afterExpiry), [], 'past expiry is baseline, not fresh activity');
  assert.equal(f.engine.modelCalls, 0);
});

test('event observation respects workspace grants and shutdown releases payloads and listeners', async t => {
  const f = fixture(t); await f.board.mutate(create, null);
  const observer = f.board.activity;
  assert.throws(() => f.board.view({ sessionId: 'agent', revoked: true }), /revoked/);
  assert.throws(() => f.board.view({ sessionId: 'agent', scopeId: 'other' }), /scope denied/);
  for (let i = 0; i < 20; i++) f.board.view(null);
  assert.equal(f.board.activity, observer, 'reads reuse one observer instead of allocating timers');
  f.board.close();
  assert.equal(observer.peer.states.size, 0);
  assert.equal(observer.peer.claims.size, 0);
  assert.equal(observer.subscriptions.length, 0);
  assert.equal(observer.view().events.length, 0);
  assert.throws(() => f.board.view(null), /closed/);
});

test('activity ring is bounded and reports discarded observations', async t => {
  const f = fixture(t);
  for (let i = 0; i < 105; i++) await f.board.mutate({ ...create, deliveryId: `create-events-${String(i).padStart(4, '0')}` }, null);
  const activity = f.board.view(null).activity;
  assert.equal(activity.events.length, 100);
  assert.equal(activity.totalObserved, 105);
  assert.equal(activity.truncated, true);
  assert.equal(activity.events[0].sequence, 6);
});

test('upstream original-write lease sweep cannot misreport a verified renewed lease as expired', async t => {
  const { Identity, Peer, spaceIdLocal } = await import('@agentspaces/client');
  const { WorkBoardActivity } = await import('../app/work-board-activity.mjs');
  const { TYPES } = await import('../app/fabric.mjs');
  const f = fixture(t), identity = loadOrCreateIdentity(join(f.root, 'event-peer'));
  const peer = new Peer(identity, spaceIdLocal('synthetic-event-group'), f.engine.clock);
  const observer = new WorkBoardActivity(identity, peer.group, 'work', f.engine.clock, peer.exportSnapshot());
  t.after(() => observer.close());
  const entryId = peer.writeEntry('work', TYPES.request, { title: 'Renewed fixture' }, 'fixture', 1000);
  observer.observe(peer.exportSnapshot());
  f.advance(500);
  peer.renewEntry('work', entryId, 10000);
  observer.observe(peer.exportSnapshot());
  f.advance(600);
  observer.observe(peer.exportSnapshot());
  assert.deepEqual(observer.view().events.map(event => event.kind), ['WRITTEN']);
});

test('observer failure cannot roll back a saved operation or hide its duplicate receipt', async t => {
  const f = fixture(t); await f.board.mutate(create, null);
  let observations = 0; const observe = f.board.activity.observe.bind(f.board.activity);
  f.board.activity.observe = snapshot => { if (++observations === 2) throw new Error('Synthetic observer failure'); observe(snapshot); };
  const second = { ...create, deliveryId: 'create-observer-failure-0001' };
  const saved = await f.board.mutate(second, null);
  assert.equal(saved.status, 'available');
  assert.equal(observations, 2, 'failure was injected after persistence, not during initial reload');
  assert.equal(f.board.view(null).items.length, 2);
  assert.equal(f.board.view(null).activity.available, false);
  assert.equal(f.board.view(null).activity.error.code, 'upstream_observation_failed');
  assert.equal((await f.board.mutate(second, null)).duplicate, true);
  const restored = new WorkBoard(f.engine); t.after(() => restored.close());
  assert.equal(restored.view(null).items.length, 2);
  assert.deepEqual(kinds(restored), []);
  assert.equal((await restored.mutate(second, null)).duplicate, true);
  assert.equal(f.engine.modelCalls, 0);
});
