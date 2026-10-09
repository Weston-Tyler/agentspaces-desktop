import { checkCodexProtocol } from './codex-protocol.mjs';

export const NATIVE_VERSION_PINS = Object.freeze({
  local: { codex: '0.162.0-alpha.2', claude: '2.1.113' },
  remote: { codex: '0.162.0', claude: '2.1.283' },
});
const qualifiedVersions = {
  local: { codex: ['0.162.0-alpha.2', '0.162.0'], claude: ['2.1.113'] },
  remote: { codex: ['0.161.0', '0.162.0'], claude: ['2.1.283'] },
};
export const observedVersion = output => /\b\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\b/.exec(String(output ?? ''))?.[0] ?? null;
export const qualifiedNativeVersion = (host, provider, output) => qualifiedVersions[host]?.[provider]?.includes(observedVersion(output)) === true;
export const nativeAdapterCompatible = tool => tool?.adapterCompatible ?? tool?.versionMatches ?? false;

export async function nativeCompatibility(host, provider, output, { protocolCheck = checkCodexProtocol } = {}) {
  const version = observedVersion(output), versionMatches = qualifiedNativeVersion(host, provider, output);
  if (provider !== 'codex' || !version) return { adapterCompatible: versionMatches, versionMatches, protocolCompatible: false, compatibilityStatus: versionMatches ? 'reviewed-version' : 'unsupported-version' };
  const verdict = await protocolCheck(host, { version });
  const adapterCompatible = verdict.compatible || (verdict.status === 'protocol-probe-unavailable' && versionMatches);
  return { adapterCompatible, versionMatches, protocolCompatible: verdict.compatible, compatibilityStatus: adapterCompatible ? verdict.compatible ? 'protocol-compatible' : 'reviewed-version' : verdict.status, protocol: verdict };
}
