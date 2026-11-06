import {
  Identity, cbor, deriveId, parseDurationMillis, parseInstantMillis,
} from '@agentspaces/client';

const text = (value, max = 2000) => typeof value === 'string' ? value.slice(0, max) : '';
const strings = value => Array.isArray(value)
  ? value.filter(v => typeof v === 'string').slice(0, 100).map(v => v.slice(0, 500)) : [];
const scalarMap = value => Object.fromEntries(
  Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
    .slice(0, 100)
    .filter(([, v]) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean')
    .map(([k, v]) => [k.slice(0, 500), typeof v === 'string' ? v.slice(0, 2000) : v]),
);

// A signed capability advertisement is not a native thread binding or permission grant.
// Read the signed bytes again, rather than trusting mutable cache projections.
export function discoverFabricCards(peer, { now = Date.now(), query = '', limit = 100 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error('Discovery limit must be from 1 to 200');
  if (typeof query !== 'string' || query.length > 500)
    throw new Error('Invalid discovery query');
  const cards = [], models = [];
  let rejected = 0, scanned = 0, verified = 0, signedBytes = 0;
  let recordBudgetReached = false, byteBudgetReached = false;
  for (const cached of peer?.ads?.values() ?? []) {
    if (scanned >= 256) { recordBudgetReached = true; break; }
    scanned++;
    if (!['AgentCard', 'ModelCard'].includes(cached?.type)) continue;
    try {
      const { adBytes, publicKey, signature, adType } = cached.stored;
      if (adType !== cached.type || !(adBytes instanceof Uint8Array) || adBytes.length > 262144
          || !(publicKey instanceof Uint8Array) || publicKey.length !== 32
          || !(signature instanceof Uint8Array) || signature.length !== 64)
        throw new Error('signature');
      // Bound total cryptographic and decoding work, even when the output limit
      // is tiny or the cache contains many irrelevant or invalid records.
      if (signedBytes + adBytes.length > 1048576) { byteBudgetReached = true; break; }
      signedBytes += adBytes.length;
      if (!Identity.verify(publicKey, adBytes, signature)) throw new Error('signature');
      verified++;
      const ad = cbor.loads(Buffer.from(adBytes));
      const issuedAt = parseInstantMillis(ad.issued);
      const ttl = parseDurationMillis(ad.ttl), expiresAt = issuedAt + ttl;
      const peerId = deriveId(publicKey);
      if (ad.group !== peer.group || ad.issuer !== peerId || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || ttl <= 0
          || issuedAt > now || expiresAt <= now || peer.revocations.peerRevoked(peerId))
        throw new Error('eligibility');
      if (adType === 'ModelCard') {
        const prefix = `aspace://${peer.group}/model/`;
        if (typeof ad.id !== 'string' || !ad.id.startsWith(prefix) || ad.id.length > 500 ||
            typeof ad.name !== 'string' || !ad.name.trim() || ad.name.length > 500) throw new Error('model card');
        const model = { id: ad.id, peerId, name: ad.name, version: text(ad.version, 100),
          tasks: strings(ad.tasks).slice(0, 16), modality: text(ad.modality, 100),
          engine: text(ad.engine, 100), licence: text(ad.licence, 100),
          issuedAt, expiresAt, signatureVerified: true, invocationAuthorized: false };
        if (!query || [model.name, model.version, model.engine, ...model.tasks].join(' ').toLowerCase().includes(query.toLowerCase())) models.push(model);
        continue;
      }
      if (typeof ad.agent !== 'string' || !ad.agent.startsWith(`${peerId}/`) ||
          ad.id !== `aspace://${peer.group}/agent/${ad.agent}` ||
          peer.revocations.refuses(ad.agent, ad.agentPublicKey, null)) throw new Error('agent card');
      const card = {
        id: ad.id, peerId, agentId: ad.agent, description: text(ad.description),
        goals: strings(ad.goals), consumes: strings(ad.consumes), produces: strings(ad.produces),
        costHints: scalarMap(ad.costHints), spaceBindings: scalarMap(ad.spaceBindings),
        issuedAt, expiresAt, signatureVerified: true,
        reachable: !!peer.connected() && peer.reachable.has(peerId),
        nativeIdentity: null, wakeAvailable: false,
      };
      const searchable = `${card.description} ${card.goals.join(' ')} ${card.consumes.join(' ')} ${card.produces.join(' ')}`;
      if (query && !searchable.toLowerCase().includes(query.toLowerCase())) continue;
      cards.push(card);
    } catch { rejected++; }
  }
  cards.sort((a, b) => a.id.localeCompare(b.id));
  models.sort((a, b) => a.id.localeCompare(b.id));
  const truncated = recordBudgetReached || byteBudgetReached || cards.length > limit || models.length > limit;
  return {
    cards: cards.slice(0, limit), models: models.slice(0, limit), truncated, rejected,
    publishesLocalMetadata: false,
    coverage: {
      complete: false, source: 'verified cached AgentCards and ModelCards', connected: !!peer?.connected(),
      scanned, verified, signedBytes, truncated, recordBudgetReached, byteBudgetReached,
      maxExaminedRecords: 256, maxSignedBytes: 1048576,
      nativeIdentityMapping: false,
      reason: 'Group advertisements are capability discovery; they do not establish native thread identity, wake access or fleet-wide reachability.',
    },
  };
}
