import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const derive=promisify(scrypt), proofs=new WeakMap();
const fingerprint=input=>createHash('sha256').update(JSON.stringify(input)).digest('hex');
export function consumeOwnerProof(proof,input,now) {
 const receipt=proof&&proofs.get(proof);if(proof)proofs.delete(proof);
 if(!receipt||receipt.expiresAt<=now||receipt.fingerprint!==fingerprint(input))throw Error('Verified owner proof required');
 return {method:'owner-password',credentialId:receipt.credentialId,verifiedAt:receipt.at};
}
export class OwnerApprovalAuth {
 constructor(store,{clock=Date.now}={}){Object.assign(this,{store,clock});this.busy=false;}
 status(){return {configured:!!this.store.data.ownerApprovalCredential,method:'owner-password'};}
 async configure(password,currentPassword) {
  if(this.busy)throw Error('Owner authentication busy');
  if(typeof password!=='string'||password.length<16||password.length>1024)throw Error('Use an owner password of 16–1024 characters');
  if(this.status().configured){if(!currentPassword)throw Error('The current password is required');await this.verify(currentPassword,{operation:'rotate'});}
  if(this.busy)throw Error('Owner authentication busy');this.busy=true;
  try {
   const salt=randomBytes(32).toString('hex'),hash=Buffer.from(await derive(password,salt,64)).toString('hex');
   this.store.data.ownerApprovalCredential={id:randomBytes(16).toString('hex'),salt,hash,createdAt:this.clock()};
   this.store.data.ownerApprovalFailures={count:0,lockedUntil:0};this.store.save();
  } finally {this.busy=false;}
  return this.status();
 }
 async verify(password,input) {
  const saved=this.store.data.ownerApprovalCredential;if(!saved)throw Error('Owner approval password not configured');
  if(this.busy)throw Error('Owner authentication busy');
  const failures=this.store.data.ownerApprovalFailures??{count:0,lockedUntil:0};
  if(failures.lockedUntil>this.clock())throw Error('Owner authentication temporarily locked');
  if(typeof password!=='string'||password.length>1024)throw Error('Invalid owner password');
  this.busy=true;
  try {
   const actual=Buffer.from(await derive(password,saved.salt,64)),expected=Buffer.from(saved.hash,'hex');
   if(actual.length!==expected.length||!timingSafeEqual(actual,expected)) {
    const count=failures.lockedUntil&&failures.lockedUntil<=this.clock()?1:failures.count+1;
    this.store.data.ownerApprovalFailures={count,lockedUntil:count>=5?this.clock()+60000:0};this.store.save();throw Error('Invalid owner password');
   }
   this.store.data.ownerApprovalFailures={count:0,lockedUntil:0};this.store.save();
   const proof=Object.freeze({}),at=this.clock();proofs.set(proof,{fingerprint:fingerprint(input),credentialId:saved.id,at,expiresAt:at+60000});return proof;
  } finally {this.busy=false;}
 }
}
