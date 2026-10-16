import { assertReplicaRetained } from '../app/replica-compatibility.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Identity, Peer, cbor, wire } from '@agentspaces/client';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/wire-v2-snapshot.json',import.meta.url)));
const bytes=Buffer.from(fixture.snapshot,'base64');
const saved=()=>cbor.loads(bytes);
test('wire-v3 rejects a real signed v2 frame rather than interpreting it as v3',()=>{
 assert.equal(fixture.generatedBy,'ab091a4fd9b325679ceca9dfa3d3042ff572696b');
 assert.equal(wire.WIRE_VERSION,3);
 assert.equal(wire.decodeFrame(Buffer.from(fixture.wireV2Frame,'base64')),null);
});
test('v2 signed snapshot retains active renewed claims, completions, revoked history and receipts',t=>{
 assert.equal(createHash('sha256').update(bytes).digest('hex'),fixture.snapshotSha256);
 const before=saved(),peer=new Peer(Identity.generate(),fixture.group,()=>fixture.clock);t.after(()=>peer.close());
 peer.restoreSnapshot(before.replica);
 assert.equal(peer.states.size,3);
 assert.equal(peer.claims.size,Object.keys(before.replica.claims).length);
 assert.equal(peer.states.get(fixture.ids.completed).completed,true);
 assert.equal(peer.states.get(fixture.ids.active).completed,false);
 assert.ok(peer.states.get(fixture.ids.active).leaseValue.expiresAtMillis>peer.states.get(fixture.ids.active).record.lease.expiresAtMillis);
 assert.equal(peer.claims.get(fixture.ids.active).claim.holder,fixture.workerAgent);
 assert.ok(peer.claims.get(fixture.ids.active).claim.expiresAtMillis>fixture.clock);
 assert.equal(peer.revocations.refuses(fixture.retiredAgent,null,null),true);
 assert.ok(peer.states.has(fixture.ids.history),'pre-revocation history remains readable');
 const after=peer.exportSnapshot();
 assert.deepEqual(assertReplicaRetained(before.replica,after),{entries:3,claims:2,revocations:1});
 // Signed material and retry receipts must survive without resigning or inferred work.
 for(const dto of before.replica.states)assert.deepEqual(after.states.find(x=>x.record.entryId===dto.record.entryId),dto);
 assert.deepEqual(cbor.dumps(after.claims),cbor.dumps(before.replica.claims));
 assert.deepEqual(cbor.dumps(after.revocations),cbor.dumps(before.replica.revocations));
 const roundTrip=cbor.loads(cbor.dumps({...before,replica:after}));
 assert.deepEqual(roundTrip.receipts,before.receipts);
});
test('snapshot migration does not accept forged records or claims',t=>{
 const before=saved(),peer=new Peer(Identity.generate(),fixture.group,()=>fixture.clock);t.after(()=>peer.close());
 before.replica.states.find(dto=>dto.record.entryId===fixture.ids.active).record.payload=cbor.dumps({title:'tampered'});
 before.replica.claims[fixture.ids.active].claim.holder='forged/worker';
 peer.restoreSnapshot(before.replica);
 assert.equal(peer.states.has(fixture.ids.active),false);
 assert.equal(peer.claims.has(fixture.ids.active),false);
});
