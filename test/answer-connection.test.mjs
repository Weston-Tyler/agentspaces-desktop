import test from 'node:test';
import assert from 'node:assert/strict';
import { findNativeAnswerService } from '../ui/answer-connection.js';

test('a fresh install can answer locally without attempting SSH', async () => {
  const calls = [];
  const answer = await findNativeAnswerService({ api: async (path, {host}) => { calls.push(host); assert.equal(path, 'ask/providers'); return [{provider:'codex',available:true}]; } });
  assert.deepEqual(answer, {provider:'codex',host:'local'}); assert.deepEqual(calls,['local']);
});
test('missing local sign-in never falls back to an unconfigured remote', async () => {
  const calls=[];
  await assert.rejects(findNativeAnswerService({preferredHost:'remote',api:async (_, {host}) => {calls.push(host);return [];} }), /Set up and sign in/);
  assert.deepEqual(calls,['local']);
});
test('an explicitly selected remote can answer after local is unavailable', async () => {
  const calls=[];
  const answer=await findNativeAnswerService({hosts:['local','remote'],api:async (_, {host})=>{calls.push(host);if(host==='local')throw new Error('Unavailable');return [{provider:'codex',available:true}];}});
  assert.equal(answer.host,'remote');assert.deepEqual(calls,['local','remote']);
});
test('remote-only selection does not probe a deselected local account', async () => {
  const calls=[];await findNativeAnswerService({hosts:['remote'],api:async (_, {host})=>{calls.push(host);return [{provider:'codex',available:true}];}});
  assert.deepEqual(calls,['remote']);
});
test('cancellation between host checks stops discovery without fallback', async () => {
  const calls=[];let cancelled=false;
  await assert.rejects(findNativeAnswerService({hosts:['local','remote'],ensureActive:()=>{if(cancelled)throw new Error('Cancelled');},api:async (_, {host})=>{calls.push(host);cancelled=true;return [];}}),/Cancelled/);
  assert.deepEqual(calls,['local']);
});
