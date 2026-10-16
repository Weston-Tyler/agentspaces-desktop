import { Engine } from '../app/engine.mjs';
import { cbor } from '@agentspaces/client';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../app/store.mjs';
import { preflightUpdate } from '../app/update-preflight.mjs';
test('staged candidate boots a private state copy without touching live settings or runtime', async t => {
  const root=mkdtempSync(join(tmpdir(),'as-update-state-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const store=new Store(root);
  store.data.askReceipts={historical:{dispatchCounted:true,status:'completed'}};
  store.save();writeFileSync(join(root,'runtime.json'),'{"sentinel":"live-runtime"}');
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

test('private-copy preflight verifies work claims and receipts and refuses silently dropped claims',async t=>{
 const root=mkdtempSync(join(tmpdir(),'as-update-claims-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const engine=new Engine(new Store(root),{diagnostics:()=>({})});t.after(()=>engine.workBoard.close());
 engine.store.save();
 engine.workspace.index={profile:{id:'fixture-scope',account:'fixture',active:true,policy:'local-retrieval'}};
 const item=await engine.workBoard.mutate({action:'create',deliveryId:'preflight-create-001',title:'Fixture',brief:'Synthetic migration',repository:'https://example.invalid/repo',base:'a'.repeat(40),allowedFiles:'src/'},null);
 await engine.workBoard.mutate({action:'claim',entryId:item.entryId,deliveryId:'preflight-claim-001'},null);
 const before=readFileSync(engine.workBoard.path),proof=await preflightUpdate({stateRoot:root});
 assert.deepEqual(proof.workReplica,{present:true,entries:1,claims:1,revocations:0,receipts:2});
 assert.deepEqual(readFileSync(engine.workBoard.path),before);
 const corrupt=cbor.loads(before);corrupt.replica.claims[item.entryId].claim.holder='forged/worker';
 writeFileSync(engine.workBoard.path,cbor.dumps(corrupt));
 await assert.rejects(preflightUpdate({stateRoot:root}),/preflight_replica_claim_not_retained/);
 assert.deepEqual(readFileSync(engine.workBoard.path),cbor.dumps(corrupt));
});
