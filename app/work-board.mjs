import { cbor, spaceIdLocal } from '@agentspaces/client';
import { createHash } from 'node:crypto';
import { TYPES } from './fabric.mjs';

// A derived view of the owning fabric, never a second work registry.
// Callers supply only states admitted by the upstream verifier.
export function projectWorkBoard({ groupId, space, states, claims, now = Date.now(), limit = 100 }) {
  if (typeof groupId !== 'string' || !groupId || typeof space !== 'string' || !space ||
      !Number.isFinite(now) || !Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error('Bounded work-board projection parameters required');
  const spaceId = spaceIdLocal(`${groupId}/${space}`);
  const rows = [], results = new Map();
  let malformed = 0;
  for (const [entryId, state] of states) {
    const record = state.record;
    if (!record || (record.group !== undefined && record.group !== groupId) || record.spaceId !== spaceId ||
        ![TYPES.request, TYPES.result].includes(record.type)) continue;
    try {
      if (record.entryId !== entryId || typeof record.issuer !== 'string') throw new Error('Invalid identity');
      const bytes = Buffer.from(record.payload);
      if (bytes.length > 65536) throw new Error('Payload too large');
      const value = cbor.loads(bytes);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid payload');
      const expiresAt = Number(state.leaseValue?.expiresAtMillis ?? record.lease?.expiresAtMillis);
      if (!Number.isFinite(expiresAt)) throw new Error('Invalid lease');
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (record.type === TYPES.result) {
        // A result remains a reported observation; it does not prove completion.
        if (typeof value.requestEntryId === 'string' && expiresAt > now && !state.completed) {
          const list = results.get(value.requestEntryId) ?? [];
          list.push({ entryId, issuer: record.issuer, hash, value });
          results.set(value.requestEntryId, list);
        }
        continue;
      }
      const candidate = claims.get(entryId)?.claim;
      const claim = candidate?.entryId === entryId && candidate.spaceId === spaceId &&
        typeof candidate.holder === 'string' && Number.isFinite(Number(candidate.expiresAtMillis)) ? candidate : null;
      const liveClaim = claim && Number(claim.expiresAtMillis) > now;
      rows.push({ entryId, issuer: record.issuer, hash, value, expiresAt,
        status: state.completed ? 'completed' : expiresAt <= now ? 'expired' : liveClaim ? 'claimed' : 'available',
        holder: liveClaim && !state.completed ? claim.holder : null,
        claimExpiresAt: liveClaim ? Number(claim.expiresAtMillis) : null,
        completionHolder: state.completed ? claim?.holder ?? null : null });
    } catch { malformed++; }
  }
  rows.sort((a, b) => a.entryId.localeCompare(b.entryId));
  const items = rows.slice(0, limit).map(row => ({ ...row,
    resultCount: (results.get(row.entryId) ?? []).length,
    resultsTruncated: (results.get(row.entryId) ?? []).length > 20,
    results: (results.get(row.entryId) ?? []).sort((a, b) => (Number(a.value.sequence) || 0) - (Number(b.value.sequence) || 0) || a.entryId.localeCompare(b.entryId)).slice(-20) }));
  return { groupId, space, observedAt: new Date(now).toISOString(), items,
    coverage: { source: 'upstream verified local replica', synchronized: false,
      totalObserved: rows.length, truncated: rows.length > limit, malformed },
    authority: 'AgentSpaces work/claim/lease/result contracts' };
}
