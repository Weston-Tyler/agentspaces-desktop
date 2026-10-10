const fields = ["input", "output", "cachedInput", "tool", "subagent"];
export function recordUsage(store, record) {
  if (
    !record ||
    typeof record.provider !== "string" ||
    typeof record.account !== "string" ||
    typeof record.threadId !== "string" ||
    typeof record.turnId !== "string"
  )
    throw new Error(
      "Usage requires provider, account, thread and native turn identifiers.",
    );
  if (!["turn", "session-cumulative"].includes(record.scope))
    throw new Error("Usage scope is required.");
  if (
    record.scope === "session-cumulative" &&
    (!Array.isArray(record.coveredTurnIds) ||
      record.coveredTurnIds.some((id) => typeof id !== "string"))
  )
    throw new Error(
      "Cumulative usage requires explicit covered native turn identifiers",
    );
  const metrics = {};
  for (const f of fields) {
    const n = record[f] ?? 0;
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid usage");
    metrics[f] = n;
  }
  const key = JSON.stringify([
    record.provider,
    record.account,
    record.threadId,
    record.scope,
    record.scope === "turn" ? record.turnId : "session",
  ]);
  const previous = store.data.usage[key];
  if (
    previous?.coveredTurnIds &&
    previous.coveredTurnIds.some((id) => !record.coveredTurnIds?.includes(id))
  )
    throw new Error("Cumulative coverage cannot regress");
  if (previous)
    for (const f of fields)
      if (metrics[f] < previous[f])
        throw new Error("Regressing usage requires explicit reconciliation");
  store.data.usage[key] = { ...record, ...metrics, reportedFields: fields.filter(field => Object.hasOwn(record, field) && record[field] !== undefined && record[field] !== null) };
  store.save();
  return {
    duplicate: !!previous && fields.every((f) => previous[f] === metrics[f]),
  };
}
export function usageSummary(store) {
  const groups = new Map();
  for (const r of Object.values(store.data.usage)) {
    const k = JSON.stringify([r.provider, r.account, r.threadId]);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const totals = Object.fromEntries(fields.map((f) => [f, 0]));
  for (const rows of groups.values()) {
    const cumulative = rows.find((r) => r.scope === "session-cumulative");
    const uncovered = rows.filter(
      (r) =>
        r.scope === "turn" && !cumulative?.coveredTurnIds.includes(r.turnId),
    );
    for (const f of fields)
      totals[f] +=
        (cumulative?.[f] ?? 0) + uncovered.reduce((s, r) => s + r[f], 0);
  }
  return {
    ...totals,
    records: Object.keys(store.data.usage).length,
    scope:
      "Recorded provider metrics; cumulative replaces only explicitly covered turn identifiers. Cached/tool/subagent metrics are reported separately, not added to input/output. Not provider billing.",
  };
}
