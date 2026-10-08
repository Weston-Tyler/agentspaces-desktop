import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../app/store.mjs";
import { Engine } from "../app/engine.mjs";
import { FabricAdapter } from "../app/fabric.mjs";
import { SNAPSHOT_TYPE } from "../app/discussions.mjs";
import { hostOS, hostPaths, normalizeHostPath } from "../app/platform.mjs";
function setup() {
  const root = mkdtempSync(join(tmpdir(), "as-discussion-")),
    engine = new Engine(
      new Store(root),
      new FabricAdapter({ stateRoot: root }),
    );
  engine.loadSample();
  const ids = ["sample-codex-old", "sample-claude-new"];
  const group = engine.discussions.create({
    title: "Shared review",
    sessionIds: ids,
  });
  return { engine, root, ids, id: group.id };
}
const post = (id, extra = {}) => ({
  id,
  text: "Compare @codex1 and @claude1",
  deliveryId: "delivery-0001",
  ...extra,
});
test("metadata references create a group without transcript reads or enrollment", () => {
  const { engine, id } = setup();
  const g = engine.discussions.view(engine.discussions.group(id));
  assert.deepEqual(
    g.members.map((m) => m.alias),
    ["codex1", "claude1"],
  );
  assert.equal(g.version, 0);
  assert.equal(engine.cache.size, 0);
  assert.equal(engine.modelCalls, 0);
  assert.deepEqual(engine.permissions(engine.session("sample-codex-old")), {});
});
test("mentions and selected replies deduplicate; synthetic dialogue has a hard bound", () => {
  const { engine, id } = setup();
  const args = post(id, {
    targets: ["sample-codex-old"],
    fixtureDialogueTurns: 4,
  });
  const g = engine.discussions.post(args);
  assert.equal(g.messages.length, 7);
  assert.equal(g.messages[0].targets.length, 2);
  assert.equal(g.messages.filter((m) => m.synthetic).length, 6);
  assert.equal(engine.discussions.post(args).version, g.version);
  assert.throws(
    () => engine.discussions.post({ ...args, text: "different" }),
    /reused/,
  );
  assert.throws(
    () =>
      engine.discussions.post(
        post(id, { deliveryId: "delivery-0002", fixtureDialogueTurns: 5 }),
      ),
    /bounded/,
  );
  assert.equal(engine.modelCalls, 0);
});
test("native wake requests stay visibly blocked and never invoke adapters", () => {
  const { engine, id } = setup();
  for (const s of engine.catalog) s.fixture = false;
  for (const m of engine.discussions.group(id).members) m.fixture = false;
  engine.nativeFactory = () => {
    throw new Error("Native adapter must not be invoked");
  };
  const g = engine.discussions.post(post(id));
  assert.equal(g.messages.length, 1);
  assert(
    g.messages[0].targets.every((t) => t.status.includes("no wake dispatched")),
  );
  assert.equal(g.automaticNativeWake, false);
  assert.throws(
    () =>
      engine.discussions.post(
        post(id, { deliveryId: "delivery-0002", fixtureDialogueTurns: 2 }),
      ),
    /synthetic participants/,
  );
});
test("unknown mentions and foreign targets reject before persisting a message", () => {
  const { engine, id } = setup();
  assert.throws(
    () => engine.discussions.post(post(id, { text: "@codex99 help" })),
    /Unknown mention/,
  );
  assert.throws(
    () => engine.discussions.post(post(id, { targets: ["sample-denied"] })),
    /not a discussion participant/,
  );
  assert.equal(engine.discussions.group(id).version, 0);
});
test("cooperative contributions require sharing from all participants and bind the author", () => {
  const { engine, id, ids } = setup();
  const binding = { sessionId: ids[1] };
  engine.grant(ids[1], {
    enrolled: true,
    content: true,
    retrieve: true,
    share: true,
  });
  assert.throws(
    () => engine.discussions.context(id, binding),
    /permit sharing/,
  );
  engine.grant(ids[0], { enrolled: true, content: true, share: true });
  const args = {
    id,
    text: "Native tool contribution",
    nativeTurnId: "self-reported-turn",
    deliveryId: "native-delivery-0001",
    author: ids[0],
  };
  const g = engine.discussions.contribute(args, binding);
  assert.equal(g.messages[0].source.sessionId, ids[1]);
  assert.match(g.messages[0].wire.metadata.attribution, /self-reported/);
  assert.equal(engine.discussions.contribute(args, binding).version, 1);
  assert.throws(
    () => engine.discussions.context(id, { sessionId: "sample-claude-old" }),
    /not a discussion participant/,
  );
  engine.grant(ids[0], { enrolled: false });
  assert.throws(
    () => engine.discussions.context(id, binding),
    /permit sharing/,
  );
});
test("revoked contribution sharing hides cached group content", () => {
  const { engine, id, ids } = setup();
  for (const sid of ids)
    engine.grant(sid, {
      enrolled: true,
      content: true,
      share: true,
      retrieve: true,
    });
  engine.discussions.contribute(
    {
      id,
      text: "Contribution",
      nativeTurnId: "turn",
      deliveryId: "delivery-native",
    },
    { sessionId: ids[0] },
  );
  engine.grant(ids[0], { share: false });
  assert.equal(engine.discussions.list()[0].available, false);
  assert.deepEqual(engine.discussions.list()[0].messages, []);
});
test("restart preserves message identity and portable wire fields without replay", () => {
  const { engine, root, id } = setup(),
    args = post(id);
  const before = engine.discussions.post(args);
  const restored = new Engine(
    new Store(root),
    new FabricAdapter({ stateRoot: root }),
  );
  restored.loadSample();
  assert.equal(restored.discussions.post(args).version, before.version);
  const snapshot = restored.discussions.snapshot(
    restored.discussions.group(id),
  );
  assert.equal(snapshot.conversationId, id);
  assert.equal(snapshot.version, 3);
  assert.equal(
    SNAPSHOT_TYPE,
    "ai.badmonkey.agentspaces.springai.model.wire.ConversationSnapshot",
  );
  for (const m of snapshot.messages) {
    assert.deepEqual(Object.keys(m), [
      "role",
      "text",
      "toolCalls",
      "toolResponses",
      "media",
      "metadata",
    ]);
    assert(Object.values(m.metadata).every((v) => typeof v === "string"));
  }
});
test("local macOS/Linux paths retain case and POSIX boundaries; remote is always POSIX", () => {
  for (const platform of ["linux", "darwin"]) {
    assert.equal(
      hostPaths("local", platform).isAbsolute("/home/me/work"),
      true,
    );
    assert.equal(
      normalizeHostPath("/Users/Me/Work/", "local", platform),
      "/Users/Me/Work",
    );
  }
  assert.equal(
    normalizeHostPath("C:\\Users\\Me\\Work\\", "local", "win32"),
    "c:\\users\\me\\work",
  );
  assert.equal(hostPaths("remote", "win32").isAbsolute("/home/example"), true);
  assert.equal(hostOS("local", "darwin"), "macOS");
  assert.equal(hostOS("local", "linux"), "Linux");
});
