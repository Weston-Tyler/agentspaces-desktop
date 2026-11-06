import { REMOTE_HOST } from "./remote-host.mjs";
import { checkCodexProtocol } from './codex-protocol.mjs';

export const NATIVE_VERSION_PINS = Object.freeze({
  local: { codex: '0.162.0-alpha.2', claude: '2.1.113' },
  [REMOTE_HOST]: { codex: '0.162.0', claude: '2.1.283' },
});
const qualifiedVersions = {
  local: { codex: ['0.162.0-alpha.2', '0.162.0'], claude: ['2.1.113'] },
  [REMOTE_HOST]: { codex: ['0.161.0', '0.162.0'], claude: ['2.1.283'] },
};
export const observedVersion = output => /\b\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\b/.exec(String(output ?? ''))?.[0] ?? null;
export const qualifiedNativeVersion = (host, provider, output) => qualifiedVersions[host]?.[provider]?.includes(observedVersion(output)) === true;
export const nativeAdapterCompatible = tool => tool?.adapterCompatible ?? tool?.versionMatches ?? false;

// Generated read/queue contract and isolated side-turn proof from the actual
// 0.166.0 runtime. A CLI upgrade may replace the binary on disk while its
// daemon keeps serving loaded work. Never infer features for unknown versions.
const reviewedDaemonContracts = {
  '0.166.0': { queue:true, steering:true, sideChat:true },
};
export function codexDaemonCapabilities(host, tool, userAgent) {
  const version = observedVersion(userAgent), cliVersion = observedVersion(tool?.version);
  if (version && cliVersion === version && tool?.compatibilityStatus === 'protocol-incompatible')
    return { version, cliVersion, source:'unqualified', queue:false, steering:false, sideChat:false };
  const reviewed = reviewedDaemonContracts[version];
  if (reviewed) return { version, cliVersion, source:'reviewed-daemon-version', ...reviewed };
  if (version && cliVersion === version && nativeAdapterCompatible(tool)) return {
    version, cliVersion, source:'matching-cli', queue:true,
    steering:tool.protocol?.steering?.compatible===true, sideChat:tool.protocol?.sideChat?.compatible===true,
  };
  return { version, cliVersion, source:'unqualified', queue:!!version && qualifiedNativeVersion(host,'codex',version),
    steering:false, sideChat:false };
}


export const nativeReadAdapterCompatible = tool => tool?.installed === false ? false : tool?.readAdapterCompatible ?? nativeAdapterCompatible(tool);

export async function nativeCompatibility(host, provider, output, { protocolCheck = checkCodexProtocol } = {}) {
  const version = observedVersion(output), versionMatches = qualifiedNativeVersion(host, provider, output);
  if (provider !== 'codex' || !version) return { ...(provider==='claude'?{readAdapterCompatible:true,readCompatibilityStatus:'pinned-sdk-interface-per-call-validation'}:{}), adapterCompatible: versionMatches, versionMatches, protocolCompatible: false, compatibilityStatus: versionMatches ? 'reviewed-version' : 'unsupported-version' };
  const verdict = await protocolCheck(host, { version });
  const adapterCompatible = verdict.compatible || (verdict.status === 'protocol-probe-unavailable' && versionMatches);
  return { adapterCompatible, versionMatches, protocolCompatible: verdict.compatible, compatibilityStatus: adapterCompatible ? verdict.compatible ? 'protocol-compatible' : 'reviewed-version' : verdict.status, protocol: verdict };
}
