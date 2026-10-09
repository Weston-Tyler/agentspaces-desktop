// Metadata selection only. Conversation admission, durable posting and native
// delivery remain owned by the existing discussion and routing surfaces.
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_LOOKUPS = 200;
const DAY_MS = 86400000;
const fail = code => Object.assign(new Error(code), { code });
const canonical = source => source && !source.fixture && ["codex", "claude"].includes(source.provider)
  && ["local", "remote"].includes(source.host) && UUID.test(source.nativeThreadId ?? "")
  && source.id === source.provider + "@" + source.host + ":" + source.nativeThreadId;

function validate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !["all", "sessionIds", "nativeThreadIds", "query", "activeWithinDays", "limit"].includes(key))
    || input.all !== undefined && typeof input.all !== "boolean"
    || input.sessionIds !== undefined && (!Array.isArray(input.sessionIds) || !input.sessionIds.length || input.sessionIds.length > MAX_LOOKUPS
      || input.sessionIds.some(id => typeof id !== "string" || !id || id.length > 300))
    || input.nativeThreadIds !== undefined && (!Array.isArray(input.nativeThreadIds) || !input.nativeThreadIds.length || input.nativeThreadIds.length > MAX_LOOKUPS
      || input.nativeThreadIds.some(id => typeof id !== "string" || !UUID.test(id)))
    || input.query !== undefined && (typeof input.query !== "string" || input.query.length > 500)
    || input.activeWithinDays !== undefined && (!Number.isInteger(input.activeWithinDays) || input.activeWithinDays < 1 || input.activeWithinDays > 3650)
    || input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_LOOKUPS)) throw fail("bounded_agent_selection_required");
  return { sessionIds: new Set(input.sessionIds ?? []), nativeThreadIds: new Set((input.nativeThreadIds ?? []).map(id => id.toLowerCase())),
    terms: queryTerms(input.query ?? ""), activeWithinDays: input.activeWithinDays, limit: input.limit ?? MAX_LOOKUPS };
}

function queryTerms(query) {
  const terms = [], pattern = /"(?:[^"\\]|\\.)*"|[^\s"]+/g;
  for (const match of query.matchAll(pattern)) {
    const raw = match[0];
    if (raw.startsWith('"')) {
      try { terms.push(JSON.parse(raw).toLowerCase()); }
      catch { throw fail("bounded_agent_selection_required"); }
    } else terms.push(raw.toLowerCase());
  }
  // A broken quote must not broaden an intended exact phrase into recipients.
  if (query.replace(pattern, "").trim()) throw fail("bounded_agent_selection_required");
  return terms.filter(term => term.trim());
}

function activityMillis(value) {
  if (typeof value === "number" || typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) {
    const epoch = Number(value);
    // Native timestamps use seconds (Codex) or milliseconds (Claude). Small
    // revision counters are not timestamp evidence.
    if (!Number.isFinite(epoch) || epoch < 100000000 || epoch > 100000000000000) return null;
    return epoch < 100000000000 ? epoch * 1000 : epoch;
  }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function matchesFilters(source, request, now, omitted) {
  if (request.activeWithinDays !== undefined) {
    const activity = activityMillis(source.updatedAt) ?? activityMillis(source.sourceVersion);
    if (activity === null) { omitted.unknownActivity++; return false; }
    if (activity > now) { omitted.futureActivity++; return false; }
    if (activity < now - request.activeWithinDays * DAY_MS) { omitted.outsideActivityWindow++; return false; }
  }
  const metadata = [source.title, source.id, source.nativeThreadId, source.cwd, ...(Array.isArray(source.topics) ? source.topics : [])]
    .filter(value => typeof value === "string").join(" ").toLowerCase();
  if (!request.terms.every(term => metadata.includes(term))) { omitted.queryMismatch++; return false; }
  return true;
}

/**
 * Select known native peers using current source identity and grants. Explicit
 * IDs form a union; topic and recency filters intersect that union. With no IDs,
 * the candidate set is the caller's permitted catalog. This function never
 * admits a participant, reads native content, posts or wakes a model.
 */
export function selectAgents(engine, binding, input = {}) {
  const request = validate(input), caller = engine.discussions.participant(binding);
  if (!canonical(caller)) throw fail("eligible_native_participant_required");
  return selectSources(engine, request, caller, caller.id);
}

/**
 * Owner-only dispatch uses its actual owner attribution, not a fabricated native
 * participant. The authenticated owner route supplies the current room/scope
 * boundary; these helpers themselves neither authenticate nor post messages.
 */
export function selectAgentsForOwner(engine, input = {}, boundary) {
  const request = validate(input);
  if (!boundary || typeof boundary !== "object" || Array.isArray(boundary)
    || Object.keys(boundary).some(key => !["account", "scopeId", "project"].includes(key))
    || typeof boundary.account !== "string" || !boundary.account || boundary.account.length > 200
    || boundary.scopeId !== undefined && boundary.scopeId !== null && (typeof boundary.scopeId !== "string" || !boundary.scopeId || boundary.scopeId.length > 300)
    || boundary.project !== undefined && boundary.project !== null && (typeof boundary.project !== "string" || !boundary.project || boundary.project.length > 300)
    || !boundary.scopeId && !boundary.project) throw fail("current_owner_selection_boundary_required");
  if (boundary.scopeId) {
    const profile = engine.workspace?.index?.profile;
    if (!profile?.active || profile.id !== boundary.scopeId || profile.account !== boundary.account) throw fail("current_owner_selection_boundary_required");
  } else {
    try { if (engine.project(boundary.project).account !== boundary.account) throw fail("boundary_mismatch"); }
    catch { throw fail("current_owner_selection_boundary_required"); }
  }
  return selectSources(engine, request, boundary);
}

const sameBoundary = (source, boundary) => source.account === boundary.account
  && !!(source.scopeId && source.scopeId === boundary.scopeId || boundary.project && source.project === boundary.project);

function selectSources(engine, request, boundary, callerId = null) {
  const now = engine.clock();
  if (!Number.isFinite(now)) throw fail("agent_selection_clock_unavailable");
  const omitted = { caller: 0, nonNative: 0, outsideBoundary: 0, duplicates: 0, unavailable: 0,
    notSelected: 0, ambiguousNativeThreadIds: 0, unknownActivity: 0, outsideActivityWindow: 0, futureActivity: 0,
    queryMismatch: 0, lookupLimit: 0, resultLimit: 0 };
  const distinct = new Map();
  for (const source of engine.catalog) {
    if (!canonical(source)) { omitted.nonNative++; continue; }
    if (source.id === callerId) { omitted.caller++; continue; }
    if (!sameBoundary(source, boundary)) {
      omitted.outsideBoundary++; continue;
    }
    if (distinct.has(source.id)) { omitted.duplicates++; continue; }
    distinct.set(source.id, source);
  }
  const identities = new Map();
  for (const source of distinct.values()) {
    const nativeId = source.nativeThreadId.toLowerCase(), ids = identities.get(nativeId) ?? [];
    ids.push(source.id); identities.set(nativeId, ids);
  }
  const ambiguous = new Set([...request.nativeThreadIds].filter(id => (identities.get(id)?.length ?? 0) > 1));
  omitted.ambiguousNativeThreadIds = ambiguous.size;
  const explicit = request.sessionIds.size > 0 || request.nativeThreadIds.size > 0;
  const catalogCandidates = [...distinct.values()].filter(source => {
    const included = !explicit || request.sessionIds.has(source.id)
      || request.nativeThreadIds.has(source.nativeThreadId.toLowerCase()) && !ambiguous.has(source.nativeThreadId.toLowerCase());
    if (!included) omitted.notSelected++;
    return included;
  });
  // Search the cached metadata before the current-identity/grant lookup bound,
  // so a topical peer after the catalog's first page remains discoverable. The
  // checked current source must still satisfy the same filters before returning.
  const candidates = catalogCandidates.filter(source => matchesFilters(source, request, now, omitted));
  omitted.lookupLimit = Math.max(0, candidates.length - MAX_LOOKUPS);
  const matches = [];
  for (const source of candidates.slice(0, MAX_LOOKUPS)) {
    let current;
    try {
      current = engine.session(source.id);
      if (!canonical(current) || current.id !== source.id || current.nativeThreadId !== source.nativeThreadId
        || !sameBoundary(current, boundary)) throw fail("source_identity_changed");
      const grant = engine.permissions(current);
      if (!grant.enrolled || !grant.share || !grant.retrieve) throw fail("current_source_grants_required");
    } catch { omitted.unavailable++; continue; }
    if (!matchesFilters(current, request, now, omitted)) continue;
    matches.push(structuredClone(current));
  }
  // Preserve native catalog order so repeated resolution of the same snapshot
  // does not select a different subset when bounded downstream rooms fill up.
  const matchedCount = matches.length;
  omitted.resultLimit = Math.max(0, matchedCount - request.limit);
  return { matches: matches.slice(0, request.limit), matchedCount, omitted,
    coverage: { catalogRows: engine.catalog.length, catalogCandidateCount: catalogCandidates.length, candidateCount: candidates.length, lookedUp: Math.min(candidates.length, MAX_LOOKUPS),
      lookupLimit: MAX_LOOKUPS, resultLimit: request.limit, lookupTruncated: omitted.lookupLimit > 0, resultTruncated: omitted.resultLimit > 0,
      catalogCompleteness: "not-established", metadataOnly: true, snapshotStale: !!engine.workspace?.index?.stale,
      asOf: new Date(now).toISOString(), modelCalls: 0 } };
}

/** Extract explicit recipient directives; stable room aliases remain untouched. */
export function parseAgentSelectors(originalText) {
  if (typeof originalText !== "string" || originalText.length > 8000) throw fail("bounded_agent_selector_text_required");
  const criteria = {}, directives = [], topics = [], nativeThreadIds = [];
  const pattern = /(^|[^\w@])(@all\b|@recent\(\s*\d+\s*d\s*\)|@topic\(\s*"(?:[^"\\\r\n]|\\.)*"\s*\)|@thread\(\s*[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\s*\))/gi;
  const stripped = originalText.replace(pattern, (whole, prefix, raw) => {
    if (/^@all$/i.test(raw)) { criteria.all = true; directives.push({ kind: "all", raw }); }
    else if (/^@recent/i.test(raw)) {
      const value = Number(raw.match(/\d+/)[0]);
      if (value < 1 || value > 3650) throw fail("bounded_agent_selector_text_required");
      criteria.activeWithinDays = Math.min(criteria.activeWithinDays ?? value, value);
      directives.push({ kind: "recent", raw, value });
    } else if (/^@topic/i.test(raw)) {
      let value;
      try { value = JSON.parse(raw.slice(raw.indexOf("(") + 1, -1).trim()); }
      catch { throw fail("bounded_agent_selector_text_required"); }
      if (!value.trim() || value.length > 500) throw fail("bounded_agent_selector_text_required");
      topics.push(value.trim()); directives.push({ kind: "topic", raw, value: value.trim() });
    } else {
      const value = raw.slice(raw.indexOf("(") + 1, -1).trim().toLowerCase();
      nativeThreadIds.push(value); directives.push({ kind: "thread", raw, value });
    }
    return prefix;
  });
  if (/(^|[^\w@])@(recent|topic|thread)\b/i.test(stripped)) throw fail("bounded_agent_selector_text_required");
  if (topics.length) criteria.query = [...new Set(topics)].map(topic => JSON.stringify(topic)).join(" ");
  if (nativeThreadIds.length) criteria.nativeThreadIds = [...new Set(nativeThreadIds)];
  if (criteria.query?.length > 500 || criteria.nativeThreadIds?.length > MAX_LOOKUPS) throw fail("bounded_agent_selector_text_required");
  return { originalText, text: stripped.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").trim(), criteria, directives };
}
