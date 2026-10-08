import {
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
// Local exclusion and side-effect reconciliation only. Work/claims remain upstream.
export class ExecutionGate {
  constructor(root) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }
  key(native) {
    return createHash("sha256")
      .update(
        JSON.stringify([native.provider, native.account, native.threadId]),
      )
      .digest("hex");
  }
  async run(
    native,
    entryId,
    adapter,
    { grant = false, budget = 0, signal } = {},
  ) {
    if (!grant || budget <= 0)
      throw new Error("Explicit execution grant and budget required");
    if (!adapter.fixture)
      throw new Error("Native execution is not qualified in this alpha");
    const key = this.key(native),
      lock = join(this.root, key + ".lock"),
      receipt = join(this.root, key + ".json");
    let fd;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (e) {
      if (e.code === "EEXIST")
        return { status: "busy", queueOwner: "AgentSpaces" };
      throw e;
    }
    try {
      const history = existsSync(receipt)
        ? JSON.parse(readFileSync(receipt, "utf8"))
        : { entries: {} };
      let state = history.entries[entryId] ?? {};
      if (
        Object.values(history.entries).some(
          (s) => s.entryId !== entryId && s.status === "uncertain",
        )
      )
        throw new Error("Previous turn requires reconciliation");
      if (state.entryId) {
        if (state.status === "completed" || state.status === "cancelled")
          return { ...state, duplicate: true };
        if (state.status === "uncertain") {
          const known = await adapter.reconcile(state.nativeTurnId);
          if (!known)
            return { status: "uncertain", nativeTurnId: state.nativeTurnId };
          state = { ...state, ...known };
          history.entries[entryId] = state;
          this.persist(receipt, history);
          return state;
        }
      }
      if (signal?.aborted) return { status: "cancelled" };
      state = {
        entryId,
        nativeTurnId: adapter.allocateTurnId(),
        status: "uncertain",
      };
      history.entries[entryId] = state;
      this.persist(receipt, history);
      // Record the native identifier BEFORE dispatch. Never blindly retry lost acknowledgement.
      const result = await adapter.execute(state.nativeTurnId, {
        signal,
        budget,
      });
      state = { ...state, ...result };
      history.entries[entryId] = state;
      this.persist(receipt, history);
      return state;
    } finally {
      closeSync(fd);
      unlinkSync(lock);
    }
  }
  persist(path, value) {
    const temp = path + ".tmp";
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    renameSync(temp, path);
  }
}
