import { cbor, bytes } from '@agentspaces/client';
// Fail the private-copy update preflight if authenticated material would disappear
// or change. Do not repair, resign or overwrite the owner's saved replica.
export function assertReplicaRetained(before,after) {
 const equal=(a,b)=>bytes.equals(cbor.dumps(a),cbor.dumps(b));
 const states=new Map(after.states.map(dto=>[dto.record.entryId,dto]));
 if(before.group!==after.group||states.size!==before.states.length||before.states.some(dto=>!states.has(dto.record.entryId)||!equal(dto,states.get(dto.record.entryId))))throw Error('preflight_replica_state_not_retained');
 if(!equal(before.claims??{},after.claims??{}))throw Error('preflight_replica_claim_not_retained');
 if(!equal(before.revocations??{},after.revocations??{}))throw Error('preflight_replica_revocation_not_retained');
 return {entries:states.size,claims:Object.keys(after.claims??{}).length,revocations:Object.values(after.revocations??{}).reduce((n,rows)=>n+rows.length,0)};
}
