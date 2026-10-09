const DEFAULT_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const DELIVERY_ID = /^[a-zA-Z0-9-]{8,100}$/;
const STATES = new Set(["complete", "failed", "uncertain"]);
const failure = code => Object.assign(new Error(code), { code });
const plainObject = value => value && typeof value === "object" && !Array.isArray(value);

// Store display text and source references, never a provider response envelope.
function text(value, maximum) {
  if (typeof value !== "string") return "";
  return value.slice(0, maximum + 4096)
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[a-zA-Z0-9_-]{10,}/g, "[redacted]")
    .replace(/\bgh[pousr]_[a-zA-Z0-9]{20,}/g, "[redacted]")
    .replace(/\b(?:api[_ -]?key|access[_ -]?token|session[_ -]?token|client[_ -]?secret|password|authorization|credential)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, "[credential redacted]")
    .replace(/\b[a-f0-9]{64}\b/gi, "[redacted]")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .slice(0, maximum);
}
function time(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000_000) : undefined;
}
function citation(value) {
  if (!plainObject(value)) return null;
  const result = {};
  for (const [key, maximum] of Object.entries({
    id: 100, kind: 40, title: 500, path: 2048, threadId: 200, nativeThreadId: 200,
    sourceId: 300, nodeId: 300, provider: 40, host: 40, version: 200,
  })) if (typeof value[key] === "string") result[key] = text(value[key], maximum);
  for (const key of ["digest", "sha256"]) if (/^[a-f0-9]{64}$/i.test(value[key] ?? "")) result[key] = value[key];
  for (const key of ["capturedAt", "expiresAt"]) if (time(value[key])) result[key] = time(value[key]);
  for (const key of ["fixture", "truncated"]) if (typeof value[key] === "boolean") result[key] = value[key];
  return Object.keys(result).length ? result : null;
}
function coverage(value) {
  if (!plainObject(value)) return {};
  const result = {};
  for (const key of ["partial", "stale", "hasMore"]) if (typeof value[key] === "boolean") result[key] = value[key];
  for (const key of ["selected", "retrieved", "contextChars", "serializedPromptChars"]) if (count(value[key]) !== undefined) result[key] = count(value[key]);
  for (const key of ["omitted", "truncated"]) if (Array.isArray(value[key])) result[key] = value[key].slice(0, 20).filter(item => typeof item === "string").map(item => text(item, 300));
  if (time(value.observedAt)) result.observedAt = time(value.observedAt);
  return result;
}
function answer(value) {
  if (!plainObject(value)) return undefined;
  const result = {
    text: text(value.text ?? value.answer, 12000),
    citations: Array.isArray(value.citations) ? value.citations.slice(0, 20).map(citation).filter(Boolean) : [],
    sourceCoverage: coverage(value.sourceCoverage ?? value.coverage),
  };
  for (const [key, maximum] of Object.entries({ provider: 40, host: 40, nativeThreadId: 200, nativeTurnId: 200, executionKind: 100 })) if (typeof value[key] === "string") result[key] = text(value[key], maximum);
  if (typeof value.fixture === "boolean") result.fixture = value.fixture;
  if (Array.isArray(value.limitations)) result.limitations = value.limitations.slice(0, 10).filter(item => typeof item === "string").map(item => text(item, 300));
  return result;
}
function safeEntry(value) {
  if (!plainObject(value) || !DELIVERY_ID.test(value.deliveryId ?? "") || !STATES.has(value.status) || typeof value.question !== "string" || !value.question.trim() || !time(value.createdAt) || !time(value.updatedAt)) return null;
  const result = {
    deliveryId: value.deliveryId, question: text(value.question, 8000), status: value.status,
    createdAt: time(value.createdAt), updatedAt: time(value.updatedAt),
  };
  if (value.status === "complete") {
    result.result = answer(value.result);
    if (!result.result?.text.trim()) return null;
  }
  else result.error = value.status === "uncertain"
    ? "Native acceptance is uncertain. This question will not be retried automatically."
    : "The question did not complete.";
  return result;
}

export class RecentHistory {
  constructor(store, { clock = Date.now, maxAgeMs = DEFAULT_MAX_AGE, maxEntries = 100 } = {}) {
    if (!store?.data || typeof store.save !== "function" || typeof clock !== "function" || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 100) throw failure("invalid_recent_history_configuration");
    Object.assign(this, { store, clock, maxAgeMs, maxEntries });
    this.prune();
  }
  prune() {
    const previous = this.store.data.recentAskHistory, now = this.clock();
    const input = previous?.schema === 1 && Array.isArray(previous.entries) ? previous.entries : [];
    const seen = new Set(), entries = input.map(safeEntry).filter(entry => {
      if (!entry || seen.has(entry.deliveryId)) return false;
      const at = Date.parse(entry.createdAt);
      if (at > now || now - at >= this.maxAgeMs) return false;
      seen.add(entry.deliveryId); return true;
    }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, this.maxEntries);
    const next = { schema: 1, entries };
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      this.store.data.recentAskHistory = next; this.store.save();
    }
    return entries;
  }
  record(input = {}) {
    if (!plainObject(input) || Object.keys(input).some(key => !["deliveryId", "question", "status", "result", "error"].includes(key))) throw failure("invalid_recent_history_entry");
    const { deliveryId, question, status, result } = input;
    if (!DELIVERY_ID.test(deliveryId ?? "") || typeof question !== "string" || !question.trim() || !STATES.has(status) || status === "complete" && !answer(result)?.text.trim()) throw failure("invalid_recent_history_entry");
    const entries = this.prune(), previous = entries.find(entry => entry.deliveryId === deliveryId);
    const boundedQuestion = text(question, 8000);
    if (previous && previous.question !== boundedQuestion) throw failure("recent_history_delivery_id_conflict");
    if (previous?.status === "complete") return structuredClone(previous);
    const at = new Date(this.clock()).toISOString();
    const next = safeEntry({ deliveryId, question: boundedQuestion, status, result, createdAt: previous?.createdAt ?? at, updatedAt: at });
    if (previous && JSON.stringify({ ...previous, updatedAt: at }) === JSON.stringify(next)) return structuredClone(previous);
    this.store.data.recentAskHistory.entries = [next, ...entries.filter(entry => entry.deliveryId !== deliveryId)]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, this.maxEntries);
    this.store.save(); return structuredClone(next);
  }
  list() {
    return { entries: structuredClone(this.prune()), retention: { maxAgeMs: this.maxAgeMs, maxEntries: this.maxEntries } };
  }
  clear() {
    this.store.data.recentAskHistory = { schema: 1, entries: [] }; this.store.save(); return this.list();
  }
}
