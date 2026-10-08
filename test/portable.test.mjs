import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostPaths, normalizeHostPath } from "../app/platform.mjs";
import { Store } from "../app/store.mjs";
import { Discussions } from "../app/discussions.mjs";
test("local native path rules use the actual host OS", () => {
  const root = mkdtempSync(join(tmpdir(), "as-portable-"));
  assert.equal(hostPaths("local").isAbsolute(root), true);
  const p = normalizeHostPath(join(root, "MiXeD"), "local");
  assert.equal(
    p.endsWith(process.platform === "win32" ? "mixed" : "MiXeD"),
    true,
  );
});
test("portable discussion persistence retains IDs and does not dispatch native wake", () => {
  const root = mkdtempSync(join(tmpdir(), "as-portable-chat-"));
  const sources = [
    {
      id: "c1",
      nativeThreadId: "uuid1",
      provider: "codex",
      host: "local",
      title: "Codex work",
      project: "p",
      account: "a",
    },
    {
      id: "a1",
      nativeThreadId: "uuid2",
      provider: "claude",
      host: "remote",
      title: "Claude work",
      project: "p",
      account: "a",
    },
  ];
  const engine = {
    store: new Store(root),
    clock: Date.now,
    session: (id) => {
      const s = sources.find((s) => s.id === id);
      if (!s) throw new Error("unknown");
      return s;
    },
    permissions: () => ({
      enrolled: true,
      content: true,
      share: true,
      retrieve: true,
    }),
  };
  const d = new Discussions(engine),
    g = d.create({ title: "Portable group", sessionIds: ["c1", "a1"] });
  const posted = d.post({
    id: g.id,
    text: "@codex1 @claude1 discuss",
    deliveryId: "portable-delivery-1",
  });
  assert.equal(posted.messages.length, 1);
  assert(
    posted.messages[0].targets.every((t) =>
      t.status.includes("no wake dispatched"),
    ),
  );
  d.contribute(
    {
      id: g.id,
      text: "Cooperative contribution",
      nativeTurnId: "reported",
      deliveryId: "portable-contribution-1",
    },
    { sessionId: "a1" },
  );
  engine.store = new Store(root);
  const restored = new Discussions(engine);
  assert.equal(restored.list()[0].messages.length, 2);
  assert.equal(restored.list()[0].messages[1].source.nativeThreadId, "uuid2");
});
