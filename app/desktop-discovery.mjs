// Startup hydration only. WorkspaceMap remains the owning discovery/cache path;
// this helper never reads transcripts, starts a model, or installs native tools.
const boots = new WeakMap();

export function ensureDesktopDiscovery(engine, { retry = false } = {}) {
  const index = engine.workspace.index, profile = index?.profile;
  if (profile && !index.fixture) {
    if (profile.active === false) {
      const state = { ready: false, status: "revoked", scopeId: profile.id, fixtureCacheIgnored: false, retryRequired: false, promise: Promise.resolve(null) };
      boots.set(engine, state);
      return state;
    }
    if (profile.active === true) {
      engine.mode = "workspace-connected";
      // WorkspaceMap's constructor restores cached source metadata immediately.
      // This does not claim a native login, active channel, fresh scan or model.
      const state = { ready: true, status: "cached-native-metadata", scopeId: profile.id, fixtureCacheIgnored: false, retryRequired: false, promise: Promise.resolve(null) };
      boots.set(engine, state);
      return state;
    }
  }
  const previous = boots.get(engine);
  if (previous?.status === "discovering") return previous;
  if (previous?.status === "unavailable" && !retry) return previous;
  const fixtureCacheIgnored = Boolean(index?.fixture);
  if (fixtureCacheIgnored) {
    // Fixture records cannot be used as startup evidence of real connectivity.
    // Their source files remain intact; replace only this derived in-memory view.
    engine.workspace.index = null;
    engine.catalog = engine.catalog.filter(session => !session.fixture);
  }
  engine.mode = "native-discovery";
  const state = { ready: false, status: "discovering", scopeId: null, fixtureCacheIgnored, retryRequired: false, promise: null };
  boots.set(engine, state);
  state.promise = Promise.resolve().then(async () => {
    if (engine.workspace.running) throw new Error("Workspace discovery already running");
    await engine.workspace.scan({
      hosts: ["local"], providers: ["codex", "claude"],
      account: "personal-local", policy: "metadata", indexFiles: false,
      roots: {}, exclusions: {},
    }, { catalogOnly: true });
    const current = engine.workspace.index;
    if (!current?.profile?.active || current.fixture) throw new Error("Native metadata discovery not ready");
    state.ready = true; state.status = "native-metadata-ready";
    state.scopeId = current.profile.id; engine.mode = "workspace-connected";
    return { ready: true, scopeId: state.scopeId };
  }).catch(() => {
    // Never retain native diagnostics, credential values or private metadata.
    // A failed pass is retried only by explicit action; there is no retry timer.
    state.ready = false;
    state.status = engine.workspace.index?.profile?.active === false && !engine.workspace.index?.fixture ? "revoked" : "unavailable";
    state.retryRequired = state.status === "unavailable";
    return { ready: false, status: state.status, retryRequired: state.retryRequired };
  });
  return state;
}
