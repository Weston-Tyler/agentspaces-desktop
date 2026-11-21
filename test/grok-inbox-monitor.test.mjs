import assert from 'node:assert/strict';
import test from 'node:test';
import { newReplyReferences } from '../app/grok-inbox-monitor.mjs';

test('Grok monitor emits each fresh reply reference once, with no room text', () => {
  const at = '2026-01-01T01:00:00.000Z';
  const id = '00000000-0000-4000-8000-000000000001';
  const messageId = '00000000-0000-4000-8000-000000000002';
  const replyTo = '00000000-0000-4000-8000-000000000003';
  const sha256 = 'a'.repeat(64);
  const reply = { at, id, messageId, sha256, replyTo, preview:'Untrusted room text' };
  const armedAt = Date.parse(at);
  const seen = new Set();
  const items = [{ ...reply, at:'2025-12-31T00:00:00Z' }, { ...reply, replyTo:null }, reply, reply];
  assert.deepEqual(newReplyReferences(items, armedAt, seen), [{ id, messageId, sha256 }]);
  assert.deepEqual(newReplyReferences(items, armedAt, seen), []);
});

test('Grok monitor includes a fresh addressed opening message while excluding routine room posts', () => {
  const at = '2026-01-01T01:00:00.000Z';
  const item = {
    at, id:'00000000-0000-4000-8000-000000000001',
    messageId:'00000000-0000-4000-8000-000000000002',sha256:'b'.repeat(64),replyTo:null,addressed:true,
  };
  const seen = new Set();
  assert.equal(newReplyReferences([{...item,addressed:false}], Date.parse(at), seen).length,0);
  assert.equal(newReplyReferences([item], Date.parse(at), seen).length,1);
  assert.deepEqual(newReplyReferences([item], Date.parse(at), seen),[]);
});
