import test from 'node:test';
import assert from 'node:assert/strict';
import { cbor, spaceIdLocal } from '@agentspaces/client';
import { projectWorkBoard } from '../app/work-board.mjs';
import { TYPES } from '../app/fabric.mjs';
const groupId = 'synthetic-group', space = 'synthetic-work', now = 1000;
const sid = spaceIdLocal(`${groupId}/${space}`);
const state = (id, type = TYPES.request, value = { requestId: id }, overrides = {}) => ({
  record: { entryId: id, group: groupId, spaceId: sid, issuer: 'synthetic-issuer',
    type, payload: cbor.dumps(value), lease: { expiresAtMillis: 5000 } }, ...overrides });
const view = (states, claims = new Map(), extra = {}) => projectWorkBoard({ groupId, space, now, states: new Map(states), claims, ...extra });

test('board preserves signed entry identity, payload digest and incomplete coverage', () => {
  const result = view([['a', state('a')]]);
  assert.equal(result.items[0].entryId, 'a');
  assert.equal(result.items[0].status, 'available');
  assert.match(result.items[0].hash, /^[a-f0-9]{64}$/);
  assert.equal(result.coverage.synchronized, false);
});
test('board derives claim expiry and monotone completion without treating results as acceptance', () => {
  const claims = new Map([['a', { claim: { entryId: 'a', spaceId: sid, holder: 'worker', expiresAtMillis: 2000 } }]]);
  const records = [['a', state('a')], ['b', state('b', TYPES.request, {}, { completed: true })],
    ['r', state('r', TYPES.result, { requestEntryId: 'a', result: 'reported' })]];
  let result = view(records, claims);
  assert.equal(result.items[0].status, 'claimed');
  assert.equal(result.items[0].holder, 'worker');
  assert.equal(result.items[0].results.length, 1);
  assert.equal(result.items[1].status, 'completed');
  result = view(records, claims, { now: 2500 });
  assert.equal(result.items[0].status, 'available');
  assert.equal(result.items[0].holder, null);
});
test('foreign group/space/claim and malformed payload cannot enter the board', () => {
  const foreign = state('foreign'); foreign.record.spaceId = 'foreign-space';
  const other = state('other'); other.record.group = 'foreign-group';
  const broken = state('broken'); broken.record.payload = Buffer.from([0xff]);
  const claims = new Map([['a', { claim: { entryId: 'a', spaceId: 'elsewhere', holder: 'intruder', expiresAtMillis: 2000 } }]]);
  const result = view([['foreign', foreign], ['other', other], ['broken', broken], ['a', state('a')]], claims);
  assert.deepEqual(result.items.map(x => x.entryId), ['a']);
  assert.equal(result.items[0].status, 'available');
  assert.equal(result.coverage.malformed, 1);
});
test('renewed write lease is honored and completed entries remain completed after expiry', () => {
  const result = view([['a', state('a', TYPES.request, {}, { leaseValue: { expiresAtMillis: 9000 } })],
    ['b', state('b', TYPES.request, {}, { completed: true })], ['c', state('c')]], new Map(), { now: 6000 });
  assert.deepEqual(result.items.map(x => x.status), ['available', 'completed', 'expired']);
});
test('projection is bounded, deterministic and makes no state mutations', () => {
  const records = [['z', state('z')], ['a', state('a')]];
  const before = JSON.stringify(records);
  const result = view(records, new Map(), { limit: 1 });
  assert.deepEqual(result.items.map(x => x.entryId), ['a']);
  assert.equal(result.coverage.truncated, true);
  assert.equal(JSON.stringify(records), before);
  assert.throws(() => view(records, new Map(), { limit: 201 }), /Bounded/);
});
