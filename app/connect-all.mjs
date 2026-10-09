// Explicit owner action. WorkspaceMap owns every scan, continuation and cache;
// this bounded workflow neither schedules model work nor creates a work queue.
const operations = new WeakMap();
const safeState = status => ({ status, stage: status, batchesCompleted: 0, partial: false, hasMore: false, promise: Promise.resolve(null) });

export function connectAllOwnedWork(engine, { hosts, maxBatches = 32 } = {}) {
  hosts ??= engine.workspace.index?.profile?.active === true && !engine.workspace.index.fixture
    ? engine.workspace.index.profile.hosts ?? ["local"] : ["local"];
  if (!Array.isArray(hosts) || !hosts.length || hosts.some(host => !["local", "remote"].includes(host))) throw new Error("Choose supported native hosts");
  hosts = [...new Set(hosts)];
  if (!Number.isInteger(maxBatches) || maxBatches < 2 || maxBatches > 32) throw new Error("Invalid inventory batch bound");
  const running = operations.get(engine);
  if (running?.status === "connecting") return running;
  const index = engine.workspace.index;
  if (index?.profile?.active === false && !index.fixture) return safeState("revoked");
  if (engine.workspace.running) return safeState("busy");
  engine.workspace.cancelled = false;
  const existing = index?.profile?.active && !index.fixture ? index.profile : null;
  const profile = {
    ...(existing ?? {}), hosts, providers: ["codex", "claude"],
    account: existing?.account ?? "personal-local", policy: "local-retrieval", indexFiles: true,
    roots: existing?.roots ?? {}, exclusions: existing?.exclusions ?? {}, active: true,
  };
  if (existing) {
    // Preserve the active derived view and all explicit per-session denials.
    index.profile = profile; engine.workspace.save(); engine.mode = "workspace-connected";
  } else if (index?.fixture) {
    engine.workspace.index = null;
    engine.catalog = engine.catalog.filter(session => !session.fixture);
  }
  engine.store.data.desktopPreferences = { ...(engine.store.data.desktopPreferences ?? {}), connectAll: true, hosts, policy: "local-retrieval", indexFiles: true };
  engine.store.save();
  const state = { status: "connecting", stage: "native-metadata", batchesCompleted: 0, partial: false, hasMore: false, cachedScopeAvailable: Boolean(existing), promise: null };
  operations.set(engine, state);
  const check = () => {
    if (engine.workspace.index?.profile?.active === false && !engine.workspace.index.fixture) throw new Error("Scope revoked");
    if (engine.workspace.cancelled) throw new Error("Inventory cancelled");
    if (engine.workspace.running) throw new Error("Another workspace scan is running");
  };
  state.promise = Promise.resolve().then(async () => {
    check();
    await engine.workspace.scan(profile, { catalogOnly: true }); state.batchesCompleted++;
    check(); state.stage = "workspace-inventory";
    await engine.workspace.scan(engine.workspace.index?.profile ?? profile); state.batchesCompleted++;
    check();
    let summary = engine.workspace.summary();
    while (summary.hasMore && state.batchesCompleted < maxBatches) {
      const before = JSON.stringify([engine.workspace.index?.cursors, engine.workspace.index?.filesystemCursors, engine.workspace.index?.sessions?.length, engine.workspace.index?.nodes?.length]);
      state.stage = "workspace-continuation";
      await engine.workspace.scan(engine.workspace.index?.profile ?? profile, { continuePages: true }); state.batchesCompleted++;
      check(); summary = engine.workspace.summary();
      const after = JSON.stringify([engine.workspace.index?.cursors, engine.workspace.index?.filesystemCursors, engine.workspace.index?.sessions?.length, engine.workspace.index?.nodes?.length]);
      if (summary.hasMore && before === after) break;
    }
    state.hasMore = Boolean(summary.hasMore); state.partial = state.hasMore;
    state.status = state.partial ? "partial" : "ready"; state.stage = "idle";
    engine.mode = "workspace-connected";
    return { status: state.status, partial: state.partial, hasMore: state.hasMore, batchesCompleted: state.batchesCompleted };
  }).catch(() => {
    state.status = engine.workspace.index?.profile?.active === false && !engine.workspace.index?.fixture ? "revoked" : engine.workspace.cancelled ? "cancelled" : "unavailable";
    state.stage = "idle"; state.partial = true;
    // No exception text, transcript/title, path, provider credential or timer retry.
    return { status: state.status, partial: true, batchesCompleted: state.batchesCompleted };
  });
  return state;
}
