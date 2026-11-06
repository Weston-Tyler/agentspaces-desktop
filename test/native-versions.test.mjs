import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifiedNativeVersion, nativeCompatibility, nativeAdapterCompatible, nativeReadAdapterCompatible, observedVersion, codexDaemonCapabilities } from '../app/native-versions.mjs';

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

test('Claude metadata uses its read SDK interface independently of native execution release qualification',async()=>{
 const verdict=await nativeCompatibility('remote','claude','Claude Code 2.999.0');const tool={provider:'claude',installed:true,...verdict};
 assert.equal(tool.versionMatches,false);assert.equal(nativeAdapterCompatible(tool),false);assert.equal(nativeReadAdapterCompatible(tool),true);
 assert.equal(nativeReadAdapterCompatible({...tool,installed:false}),false);assert.equal(nativeReadAdapterCompatible({...tool,readAdapterCompatible:false}),false);
 const broken={provider:'codex',installed:true,...await nativeCompatibility('remote','codex','0.999.0',{protocolCheck:async()=>({compatible:false,status:'protocol-incompatible'})})};
 assert.equal(nativeReadAdapterCompatible(broken),false);assert.equal(nativeAdapterCompatible(broken),false);
});


test('reviewed running daemon survives a CLI upgrade without qualifying unknown mismatches', () => {
  const tool = {version:'codex-cli 0.167.0',adapterCompatible:true,protocol:{steering:{compatible:true},sideChat:{compatible:true}}};
  assert.deepEqual(codexDaemonCapabilities('remote',tool,'agent/0.166.0'),{
    version:'0.166.0',cliVersion:'0.167.0',source:'reviewed-daemon-version',queue:true,steering:true,sideChat:true,
  });
  for(const daemon of ['agent/0.165.9','agent/0.166.0-unknown',undefined]){
    const caps=codexDaemonCapabilities('remote',tool,daemon);
    assert.equal(caps.queue,false);assert.equal(caps.steering,false);assert.equal(caps.sideChat,false);
  }
  assert.equal(codexDaemonCapabilities('remote',tool,'agent/0.167.0').source,'matching-cli');
  assert.equal(codexDaemonCapabilities('remote',{version:'0.166.0',compatibilityStatus:'protocol-incompatible'},'agent/0.166.0').queue,false);
});
