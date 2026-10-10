import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../app/store.mjs';
import { preflightUpdate } from '../app/update-preflight.mjs';
test('staged candidate boots a private state copy without touching live settings or runtime', async t => {
  const root=mkdtempSync(join(tmpdir(),'as-update-state-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const store=new Store(root);store.save();writeFileSync(join(root,'runtime.json'),'{"sentinel":"live-runtime"}');
  const before=readFileSync(store.path,'utf8');
  const proof=await preflightUpdate({stateRoot:root});
  assert.equal(proof.passed,true);assert.match(proof.candidate,/^[a-f0-9]{64}$/);assert.equal(proof.modelCalls,0);
  assert.equal(readFileSync(store.path,'utf8'),before);assert.equal(readFileSync(join(root,'runtime.json'),'utf8'),'{"sentinel":"live-runtime"}');
});
test('incompatible schema and unrelated state files fail before live service changes', async t => {
  const root=mkdtempSync(join(tmpdir(),'as-update-invalid-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,'settings.json'),'{"schema":999}');
  await assert.rejects(preflightUpdate({stateRoot:root}),/schema/);
  writeFileSync(join(root,'diagnostic.log'),'unrelated');
  await assert.rejects(preflightUpdate({stateRoot:root}),/unrelated files/);
  assert.equal(readFileSync(join(root,'settings.json'),'utf8'),'{"schema":999}');
});
