import test from 'node:test';
import assert from 'node:assert/strict';
import { OwnerApprovalAuth, consumeOwnerProof } from '../app/owner-approval-auth.mjs';
const password='a synthetic owner password only for tests';
function fixture(){let now=1000;const store={data:{},save(){}};return {store,auth:new OwnerApprovalAuth(store,{clock:()=>now}),advance:n=>now+=n};}
test('owner password is opt-in, hashed, rate limited and retained after restart',async()=>{
 const f=fixture();await assert.rejects(f.auth.verify(password,{}),/not configured/);
 await f.auth.configure(password);assert.ok(!JSON.stringify(f.store.data).includes(password));
 await assert.rejects(f.auth.configure('replacement synthetic password'),/current password/);
 for(let n=0;n<5;n++)await assert.rejects(f.auth.verify('wrong',{}),/password/);
 await assert.rejects(f.auth.verify(password,{}),/temporarily locked/);f.advance(61000);
 const restored=new OwnerApprovalAuth(f.store,{clock:()=>62000});assert.ok(await restored.verify(password,{entryId:'one'}));
});
test('proof is single use, bound to exact payload, expiring and cannot be forged',async()=>{
 const f=fixture();await f.auth.configure(password);const input={entryId:'one',requestHash:'hash'};
 assert.throws(()=>consumeOwnerProof({verified:true},input,1000),/proof/);
 let proof=await f.auth.verify(password,input);assert.throws(()=>consumeOwnerProof(proof,{...input,entryId:'two'},1000),/proof/);
 proof=await f.auth.verify(password,input);assert.equal(consumeOwnerProof(proof,input,1000).method,'owner-password');assert.throws(()=>consumeOwnerProof(proof,input,1000),/proof/);
 proof=await f.auth.verify(password,input);assert.throws(()=>consumeOwnerProof(proof,input,62000),/proof/);
});
