import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Identity, Peer, cbor, cryptoPort, bytes, nobleCrypto } from '@agentspaces/client';
import { loadOrCreateIdentity, agentKeys } from '../app/agentspaces-node.mjs';
import { FabricAdapter } from '../app/fabric.mjs';
import { assertReplicaRetained } from '../app/replica-compatibility.mjs';

test('0.4 Node adapter registers TCP and selects the owning OpenSSL crypto port', () => {
  const fabric = new FabricAdapter(), peer = new Peer(Identity.generate(), 'synthetic-group');
  try {
    assert.equal(fabric.diagnostics().bindingVersion, '0.4.0');
    assert.equal(cryptoPort().name, 'node');
    assert.ok(peer.dialableSchemes().includes('tcp'));
    assert.ok(!peer.dialableSchemes().includes('dtls'));
    assert.ok(!peer.dialableSchemes().includes('quic'));
    const seed = new Uint8Array(32).fill(7), message = cbor.dumps({ fixture: true });
    assert.deepEqual(cryptoPort().ed25519PublicKey(seed), nobleCrypto.ed25519PublicKey(seed));
    assert.deepEqual(cryptoPort().ed25519Sign(seed, message), nobleCrypto.ed25519Sign(seed, message));
  } finally { peer.close(); }
});

test('legacy PKCS8/public key files retain peer and subordinate identities byte for byte', t => {
  const root = mkdtempSync(join(tmpdir(), 'as-040-keys-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The pre-0.4/Java layout uses an OpenSSL PKCS8 key and raw public key.
  // Generate synthetic fixtures here: no real identity is stored in the repo.
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateBytes = privateKey.export({ type: 'pkcs8', format: 'der' });
  const publicBytes = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  writeFileSync(join(root, 'peer.key'), privateBytes, {mode: 0o600});
  writeFileSync(join(root, 'peer.pub'), publicBytes);
  const identity = loadOrCreateIdentity(root);
  assert.deepEqual(Buffer.from(identity.publicRaw), publicBytes);
  const subordinate = join(root, 'agents', identity.peerId, 'fixture-agent');
  mkdirSync(subordinate, { recursive: true });
  writeFileSync(join(subordinate, 'agent.key'), privateBytes, {mode: 0o600});
  writeFileSync(join(subordinate, 'agent.pub'), publicBytes);
  const before = [join(root,'peer.key'), join(root,'peer.pub'), join(subordinate,'agent.key'), join(subordinate,'agent.pub')]
    .map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]);
  const agent = agentKeys(join(root, 'agents'), identity.peerId, 'fixture-agent');
  assert.equal(agent.peerId, identity.peerId);
  assert.equal(loadOrCreateIdentity(root).peerId, identity.peerId);
  for (const [path, hash] of before) assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), hash);
  writeFileSync(join(root, 'peer.pub'), Buffer.alloc(32));
  assert.throws(() => loadOrCreateIdentity(root), /corrupt keystore/);
  assert.deepEqual(readFileSync(join(root, 'peer.pub')), Buffer.alloc(32), 'never repair or replace a corrupt identity');
});

test('portable CBOR byte equality retains authenticated state and rejects changed material', () => {
  const before = {group:'synthetic', states:[{record:{entryId:'one',payload:cbor.dumps({fixture:true})}}],claims:{one:{fixture:true}},revocations:{peers:[]}};
  const after = cbor.loads(cbor.dumps(before));
  assert.ok(cbor.dumps(before) instanceof Uint8Array);
  assert.equal(bytes.equals(cbor.dumps(before), cbor.dumps(after)), true);
  assert.deepEqual(assertReplicaRetained(before, after), { entries:1, claims:1, revocations:0 });
  after.states[0].record.payload = cbor.dumps({fixture:false});
  assert.throws(() => assertReplicaRetained(before, after), /state_not_retained/);
});

test('unsupported direct UDP transports fail before detaching an existing connection', async () => {
  const fabric = new FabricAdapter(); let closed = false;
  fabric.peer = {connected:()=>true, close(){closed=true;}}; fabric.status='connected';
  for (const scheme of ['dtls','quic','udp']) await assert.rejects(
    fabric.connect({host:'127.0.0.1',port:7500,groupId:'fixture',scheme}), /Java gateway/);
  assert.equal(closed,false);
  assert.equal(fabric.status,'connected');
  assert.equal(fabric.diagnostics().transport.gatewayConnected,null);
});
