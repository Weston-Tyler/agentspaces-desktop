// Probe only hosts selected by the owner. An absent SSH configuration must not
// delay a fresh local installation or receive an implicit connection attempt.
export async function findNativeAnswerService({ api, hosts = ['local'], preferredHost, ensureActive = () => {} }) {
  const selected = new Set(Array.isArray(hosts) ? hosts : ['local']);
  const ordered = ['local', 'remote'].filter(host => selected.has(host));
  if (ordered.includes(preferredHost)) ordered.unshift(...ordered.splice(ordered.indexOf(preferredHost), 1));
  for (const host of ordered) {
    ensureActive();
    let providers;
    try { providers = await api('ask/providers', { host }); } catch { continue; }
    ensureActive();
    if (providers.some(provider => provider.provider === 'codex' && provider.available === true)) return { provider: 'codex', host };
  }
  throw new Error('Set up and sign in to Codex under Native chat to answer questions. Claude Code can participate in group chats; the Ask screen currently uses Codex.');
}
