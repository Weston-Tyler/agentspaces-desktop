import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../app/store.mjs";
import { RecentHistory } from "../app/recent-history.mjs";
import { mountHomeChat } from "../ui/home-chat.js";

const DAY = 24 * 60 * 60 * 1000;
const entry = (extra = {}) => ({ deliveryId: "recent-question-0001", question: "What did we decide?", status: "complete", result: { text: "Keep the existing ownership boundary [S1].", citations: [{ id: "S1", title: "Decision", sourceId: "codex@local:fixture-source", digest: "c".repeat(64) }], sourceCoverage: { selected: 1, retrieved: 1, partial: true } }, ...extra });
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "as-recent-history-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  store.data.askReceipts = { "stable-native-receipt": { state: "uncertain", dispatchCounted: true } };
  let now = Date.parse("2026-10-09T12:00:00Z");
  const clock = () => now, history = new RecentHistory(store, { clock, ...options });
  return { root, store, history, clock, advance: milliseconds => { now += milliseconds; } };
}

test("recent questions, answers and bounded source coverage survive an owner-private store restart", t => {
  const f = fixture(t), recorded = f.history.record(entry());
  assert.equal(recorded.status, "complete");
  const restored = new RecentHistory(new Store(f.root), { clock: f.clock }).list();
  assert.equal(restored.entries.length, 1); assert.deepEqual(restored.entries[0], recorded);
  assert.equal(restored.entries[0].result.citations[0].digest, "c".repeat(64));
  assert.equal(restored.entries[0].result.sourceCoverage.partial, true);
  assert.deepEqual(restored.retention, { maxAgeMs: 30 * DAY, maxEntries: 100 });
  if (process.platform !== "win32") assert.equal(statSync(f.store.path).mode & 0o777, 0o600);
});

test("stable delivery IDs update uncertainty once and preserve completed answers against downgrade", t => {
  const f = fixture(t), initial = f.history.record(entry({ status: "uncertain", result: undefined }));
  f.advance(1000);
  const complete = f.history.record(entry());
  assert.equal(complete.createdAt, initial.createdAt); assert.notEqual(complete.updatedAt, initial.updatedAt);
  f.advance(1000);
  assert.deepEqual(f.history.record(entry({ status: "uncertain", result: undefined })), complete);
  assert.deepEqual(f.history.record(entry()), complete);
  assert.equal(f.history.list().entries.length, 1);
  assert.throws(() => f.history.record(entry({ question: "A different question" })), { code: "recent_history_delivery_id_conflict" });
  const copy = f.history.list(); copy.entries[0].result.text = "Changed outside the store";
  assert.equal(f.history.list().entries[0].result.text, entry().result.text);
});

test("retention expires at thirty days without deleting inference idempotency receipts", t => {
  const f = fixture(t), receipts = structuredClone(f.store.data.askReceipts);
  f.history.record(entry()); f.advance(30 * DAY - 1);
  assert.equal(f.history.list().entries.length, 1);
  f.advance(1);
  assert.deepEqual(f.history.list().entries, []);
  const restored = new Store(f.root);
  assert.deepEqual(restored.data.recentAskHistory.entries, []);
  assert.deepEqual(restored.data.askReceipts, receipts);
});

test("the newest one hundred entries are retained, with configurable smaller limits", t => {
  const f = fixture(t);
  for (let index = 0; index < 105; index++) {
    f.advance(1);
    f.history.record(entry({ deliveryId: "bounded-question-" + String(index).padStart(4, "0"), question: "Question " + index }));
  }
  const entries = f.history.list().entries;
  assert.equal(entries.length, 100); assert.equal(entries[0].question, "Question 104");
  assert.equal(entries.at(-1).question, "Question 5");
  const smaller = new RecentHistory(f.store, { clock: f.clock, maxEntries: 3 }).list();
  assert.deepEqual(smaller.entries.map(item => item.question), ["Question 104", "Question 103", "Question 102"]);
});

test("only bounded display text, citations and coverage are persisted", t => {
  const f = fixture(t);
  const recorded = f.history.record(entry({ question: "q".repeat(10000), result: {
    text: "a".repeat(20000), rawResponse: { privateDiagnostic: "NEVER-PERSIST-RAW" },
    citations: Array.from({ length: 100 }, () => ({ id: "S1", title: "t".repeat(1000), path: "/" + "p".repeat(5000), token: "NEVER-PERSIST-TOKEN", raw: { diagnostics: "NEVER-PERSIST-RAW" } })),
    sourceCoverage: { partial: true, omitted: Array(100).fill("o".repeat(1000)), truncated: Array(100).fill("S1"), errors: ["NEVER-PERSIST-DIAGNOSTIC"], metadataCursors: { private: "NEVER-PERSIST-CURSOR" } },
    limitations: Array(100).fill("l".repeat(1000)),
  } }));
  assert.equal(recorded.question.length, 8000); assert.equal(recorded.result.text.length, 12000);
  assert.equal(recorded.result.citations.length, 20); assert.equal(recorded.result.citations[0].title.length, 500);
  assert.equal(recorded.result.citations[0].path.length, 2048);
  assert.equal(recorded.result.sourceCoverage.omitted.length, 20); assert.equal(recorded.result.sourceCoverage.omitted[0].length, 300);
  assert.equal(recorded.result.sourceCoverage.truncated.length, 20); assert.equal(recorded.result.limitations.length, 10);
  assert(!readFileSync(f.store.path, "utf8").includes("NEVER-PERSIST"));
});

test("recognizable credentials are redacted and failed or uncertain diagnostics never enter history", t => {
  const f = fixture(t), capability = "a".repeat(64), key = "sk-proj-" + "privatekey".repeat(8);
  f.history.record(entry({ question: "Question " + capability + " " + key, result: { text: "Bearer private-authorization-value password=hidden-password " + capability + " " + key } }));
  f.history.record(entry({ deliveryId: "uncertain-question-0002", status: "uncertain", result: { text: "PRIVATE-UNVERIFIED-ANSWER" }, error: { message: "PRIVATE-PROVIDER-DIAGNOSTIC", token: capability } }));
  f.history.record(entry({ deliveryId: "failed-question-0003", status: "failed", result: undefined, error: "PRIVATE-PROVIDER-DIAGNOSTIC" }));
  const persisted = readFileSync(f.store.path, "utf8");
  for (const secret of [capability, key, "private-authorization-value", "hidden-password", "PRIVATE-UNVERIFIED-ANSWER", "PRIVATE-PROVIDER-DIAGNOSTIC"]) assert(!persisted.includes(secret));
  assert.match(persisted, /redacted/);
  const restored = new RecentHistory(new Store(f.root), { clock: f.clock });
  const uncertain = restored.list().entries.find(item => item.status === "uncertain");
  assert(!("result" in uncertain)); assert.match(uncertain.error, /will not be retried automatically/);
});

test("clearing recent UI memory preserves receipt tombstones and restart does not restore cleared entries", t => {
  const f = fixture(t), receipts = structuredClone(f.store.data.askReceipts);
  f.history.record(entry());
  assert.deepEqual(f.history.clear().entries, []);
  const store = new Store(f.root);
  assert.deepEqual(new RecentHistory(store, { clock: f.clock }).list().entries, []);
  assert.deepEqual(store.data.askReceipts, receipts);
});

test("invalid history records and malformed cached entries cannot persist raw state", t => {
  const f = fixture(t);
  for (const value of [null, [], { ...entry(), deliveryId: "bad" }, { ...entry(), question: "" }, { ...entry(), status: "running" }, { ...entry(), result: undefined }, { ...entry(), raw: "PRIVATE-RAW" }]) assert.throws(() => f.history.record(value), { code: "invalid_recent_history_entry" });
  f.store.data.recentAskHistory.entries = [{ ...entry(), createdAt: "not-a-date", updatedAt: "not-a-date", raw: "PRIVATE-RAW" }]; f.store.save();
  assert.deepEqual(new RecentHistory(new Store(f.root), { clock: f.clock }).list().entries, []);
  assert(!readFileSync(f.store.path, "utf8").includes("PRIVATE-RAW"));
});

class Element {
  constructor(tag, content = "") { this.tag = tag; this.textContent = content; this.children = []; this.dataset = {}; this.isConnected = true; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(name, value) { this[name] = value; }
  focus() {}
}
function dom(t) {
  const previousDocument = globalThis.document, previousObserver = globalThis.MutationObserver;
  globalThis.document = { createElement: tag => new Element(tag), createTextNode: text => new Element("text", text), body: new Element("body") };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  t.after(() => { globalThis.document = previousDocument; globalThis.MutationObserver = previousObserver; });
  const root = new Element("root"), find = (node, tag) => node.tag === tag ? node : node.children.map(child => find(child, tag)).find(Boolean);
  const allText = node => [node.textContent, ...node.children.map(allText)].join(" ");
  return { root, find: tag => find(root, tag), allText: () => allText(root) };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("restoring uncertain UI history makes no answering request and does not retry that question", async t => {
  const d = dom(t), calls = [], notices = [];
  const dispose = mountHomeChat(d.root, { notice: (...args) => notices.push(args), api: async (path, body) => {
    calls.push({ path, body });
    return { entries: [{ deliveryId: "restored-uncertain-0001", question: "Uncertain prior question", status: "uncertain", createdAt: "2026-10-09T12:00:00Z" }] };
  } });
  t.after(dispose); await flush();
  assert.deepEqual(calls.map(call => call.path), ["ask/history"]);
  d.find("textarea").value = "Uncertain prior question";
  await d.find("form").onsubmit({ preventDefault() {} });
  assert.deepEqual(calls.map(call => call.path), ["ask/history"]);
  assert.match(notices[0][0], /uncertain native outcome/);
});

test("late history hydration preserves a new submission, its answer and a later draft", async t => {
  const d = dom(t), calls = []; let finishHistory;
  const pendingHistory = new Promise(resolve => { finishHistory = resolve; });
  const dispose = mountHomeChat(d.root, { notice() {}, api: async (path, body) => {
    calls.push({ path, body });
    if (path === "ask/history") return pendingHistory;
    if (path === "ask/providers") return [{ provider: "codex", available: true }];
    if (path === "ask/search") return { sessions: [], work: [] };
    if (path === "ask/answer") return { text: "Fresh answer stays visible", citations: [], fixture: true };
    throw new Error("Unexpected native or UI operation");
  } });
  t.after(dispose);
  const input = d.find("textarea"); input.value = "A new question";
  await d.find("form").onsubmit({ preventDefault() {} });
  const answerCall = calls.find(call => call.path === "ask/answer");
  input.value = "Draft typed while history loads";
  finishHistory({ entries: [{ deliveryId: answerCall.body.deliveryId, question: "A new question", status: "uncertain", createdAt: "2026-10-09T12:00:00Z" }, { ...entry(), createdAt: "2026-10-09T11:00:00Z" }] });
  await flush();
  assert.equal(input.value, "Draft typed while history loads");
  assert.match(d.allText(), /A new question/); assert.match(d.allText(), /Fresh answer stays visible/);
  assert.match(d.allText(), /What did we decide/); assert(!d.allText().includes("Uncertain ·"));
  assert.equal(calls.filter(call => call.path === "ask/answer").length, 1);
});

test("first-run local connection preserves the draft and grants no native execution policy", async t => {
  const d = dom(t), calls = [];
  const dispose = mountHomeChat(d.root, { notice() {}, api: async (path, body) => {
    calls.push({ path, body }); return path === "ask/history" ? { entries: [] } : { status: "connecting" };
  } });
  t.after(dispose); await flush();
  d.find("textarea").value = "Keep this draft";
  await d.find("button").onclick();
  assert.deepEqual(calls.find(call => call.path === "desktop/connect-all").body, { hosts: ["local"] });
  assert.equal(d.find("textarea").value, "Keep this draft");
  assert.equal(calls.filter(call => call.path.startsWith("ask/") && call.path !== "ask/history").length, 0);
});
