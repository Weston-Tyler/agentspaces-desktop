import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifiedNativeVersion, nativeCompatibility, nativeAdapterCompatible, observedVersion } from '../app/native-versions.mjs';

test('exact version comparison keeps reviewed releases separate from unknown prereleases', () => {
  assert.equal(qualifiedNativeVersion('remote', 'codex', 'codex-cli 0.162.0'), true);
  assert.equal(qualifiedNativeVersion('remote', 'codex', 'codex-cli 0.162.0-unreviewed'), false);
  assert.equal(qualifiedNativeVersion('remote', 'codex', 'codex-cli 0.161.0'), true);
  assert.equal(observedVersion('codex/0.161.0 (Linux)'), '0.161.0');
});

test('a compatible native update is admitted by contract without relabeling its version as reviewed', async () => {
  const value = await nativeCompatibility('remote', 'codex', 'codex-cli 0.999.0', { protocolCheck: async () => ({ compatible: true, status: 'protocol-compatible', contractHash: 'synthetic' }) });
  assert.equal(value.versionMatches, false); assert.equal(value.protocolCompatible, true); assert.equal(nativeAdapterCompatible(value), true);
});

test('breaking contracts refuse even a familiar version while an unavailable check only falls back to reviewed versions', async () => {
  const incompatible = await nativeCompatibility('remote', 'codex', 'codex-cli 0.162.0', { protocolCheck: async () => ({ compatible: false, status: 'protocol-incompatible' }) });
  assert.equal(incompatible.versionMatches, true); assert.equal(nativeAdapterCompatible(incompatible), false);
  const options = { protocolCheck: async () => ({ compatible: false, status: 'protocol-probe-unavailable' }) };
  assert.equal(nativeAdapterCompatible(await nativeCompatibility('remote', 'codex', '0.162.0', options)), true);
  assert.equal(nativeAdapterCompatible(await nativeCompatibility('remote', 'codex', '0.999.0', options)), false);
});
