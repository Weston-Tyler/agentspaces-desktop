import { findNativeAnswerService } from "./answer-connection.js";
const el = (tag, text, cls) => {
  const element = document.createElement(tag);
  if (text !== undefined && text !== null) element.textContent = text;
  if (cls) element.className = cls;
  return element;
};
export function mountHomeChat(root, { api, notice, preferredHost, state = {} } = {}) {
  const mountId = crypto.randomUUID();
  root.dataset.homeChatMount = mountId;
  const welcome = el("section", null, "home-chat-welcome"),
    history = el("section", null, "home-chat-history"),
    messages = el("section", null, "home-chat-messages"),
    form = el("form", null, "card home-chat-compose"),
    question = el("textarea"),
    label = el("label", "Your question"),
    submit = el("button", "Send", "primary"),
    cancel = el("button", "Cancel", "secondary"),
    status = el("p", "Relevant work is included automatically.", "fineprint"),
    setup = el("button", "Settings", "subtle");
  welcome.append(el("h2", "Ask about anything you’re working on."), el("p", "Find prior work, understand decisions, or ask a general question."));
  messages.setAttribute("aria-live", "polite");
  question.rows = 3; question.required = true; question.maxLength = 4000;
  question.placeholder = "Ask a question…";
  question.setAttribute("aria-label", "Your question");
  label.append(question);
  submit.type = "submit"; cancel.type = "button"; cancel.hidden = true;
  setup.type = "button"; setup.dataset.page = "settings";
  const actions = el("div", null, "actions"); actions.append(submit, cancel, setup);
  form.append(label, actions, status); root.replaceChildren(history, messages, form);
  let running = false, disposed = false, deliveryId = null, dispatched = false,
    cancelled = false;
  const uncertainQuestions = new Set(), submittedIds = new Set();
  if (!state.desktopPreferences?.connectAll) {
    const firstRun = el("section", null, "card"), connect = el("button", "Connect work on this device", "primary"), native = el("button", "Open native sign-in", "secondary"), help = el("p", "Use your own Codex or Claude Code installation and account. SSH is optional and is only used after you select another computer.", "fineprint");
    firstRun.append(el("h2", "Get started on this device"), help);
    const links = el("p");
    for (const [title, url] of [["Install Codex", "https://developers.openai.com/codex/cli/"], ["Install Claude Code", "https://code.claude.com/docs/en/setup"]]) {
      const link = el("a", title); link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer"; links.append(link, document.createTextNode("  "));
    }
    firstRun.append(links, el("p", "Connect lets this companion retrieve permitted local work and index files. Existing exclusions and denied sources stay excluded. Ask currently needs Codex; Claude Code can join group chats.", "fineprint"));
    connect.type = "button"; native.type = "button"; native.dataset.page = "native";
    connect.onclick = async () => {
      connect.disabled = true;
      try {
        const result = await api("desktop/connect-all", { hosts: ["local"] });
        help.textContent = result.status === "connecting" ? "Local discovery started. You can ask questions while it runs; see Connected work for progress. Other computers can be added there later." : "Connection status: " + result.status + ". See Connected work for details.";
      } catch (error) { notice(error.message, true); }
      finally { connect.disabled = false; }
    };
    const buttons = el("div", null, "actions"); buttons.append(connect, native); firstRun.append(buttons); root.replaceChildren(firstRun, history, messages, form);
  }

  const current = () => !disposed && root.isConnected && root.dataset.homeChatMount === mountId && form.isConnected;
  const showStatus = (text) => { if (current()) status.textContent = text; };
  async function cancelCurrent() {
    cancelled = true;
    if (deliveryId && dispatched) {
      const result = await api("ask/cancel", { deliveryId });
      showStatus(result.status ?? "Cancellation requested. Native acceptance may be uncertain.");
    } else showStatus("Question cancelled before inference.");
  }
  cancel.onclick = async () => {
    cancel.disabled = true;
    try { await cancelCurrent(); } catch (error) { if (current()) notice(error.message, true); }
    finally { if (current()) cancel.disabled = false; }
  };
  const ensureActive = () => {
    if (cancelled || !current()) throw new Error("Question cancelled before inference");
  };
  const findService = () => findNativeAnswerService({ api, hosts: state.workspace?.profile?.hosts ?? ["local"], preferredHost, ensureActive });
  function renderAnswer(answer, search, selected, destination = messages, restored = false) {
    const card = el("article", null, "card home-chat-answer"),
      synthetic = answer.fixture || /fixture|synthetic/i.test(answer.executionKind ?? "");
    card.append(el("h3", synthetic ? "Example answer" : "Answer"));
    const text = el("div", null, "ask-answer-text");
    for (const paragraph of String(answer.text ?? answer.answer ?? "").split(/\n\s*\n/)) text.append(el("p", paragraph));
    card.append(text);
    const citations = answer.citations ?? [], coverage = answer.sourceCoverage ?? answer.coverage ?? {},
      sources = el("details"),
      total = search.totalMatches ?? (search.sessions ?? search.sessionMatches ?? []).length + (search.work ?? search.workMatches ?? []).length;
    sources.append(el("summary", "Sources · " + citations.length + " included"));
    sources.append(el("p", (restored ? "Saved source references and coverage. " : selected + " selected from " + total + " matching records. ") + (coverage.truncated?.length ?? 0) + " excerpts truncated; " + (coverage.omitted?.length ?? 0) + " selected sources omitted by limits.", "fineprint"));
    if (coverage.partial || coverage.stale || coverage.hasMore)
      sources.append(el("p", "Coverage is partial or stale. More work may exist outside the captured permitted sources.", "fineprint"));
    if (!selected) sources.append(el("p", "No eligible connected context was found. This answer used the general question route.", "fineprint"));
    for (const citation of citations) {
      const row = el("div", null, "home-chat-source");
      row.append(el("strong", citation.id ?? "Source"), el("p", citation.title ?? citation.path ?? citation.threadId ?? citation.nativeThreadId ?? citation.sourceId ?? citation.nodeId), el("small", [citation.provider, citation.host, citation.version, citation.digest ?? citation.sha256].filter(Boolean).join(" · ")));
      sources.append(row);
    }
    sources.append(el("p", [answer.provider, answer.host, answer.nativeThreadId ? "Native thread " + answer.nativeThreadId : "", answer.nativeTurnId ? "Turn " + answer.nativeTurnId : ""].filter(Boolean).join(" · "), "fineprint"));
    for (const limitation of answer.limitations ?? []) sources.append(el("p", limitation, "fineprint"));
    card.append(sources); destination.append(card);
  }
  function renderHistory(value) {
    history.replaceChildren();
    const entries = Array.isArray(value?.entries) ? value.entries.filter(entry => !submittedIds.has(entry.deliveryId)) : [];
    const header = el("div", null, "actions"), clear = el("button", "Clear recent history", "subtle");
    clear.type = "button"; clear.disabled = running || !entries.length;
    header.append(el("h3", "Recent questions"), clear); history.append(header);
    const days = Math.round((value?.retention?.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000) / (24 * 60 * 60 * 1000));
    const maximum = value?.retention?.maxEntries ?? 100;
    history.append(el("p", "Saved on this device for " + days + " days, up to " + maximum + " questions. Clearing this view keeps delivery records that prevent duplicate requests.", "fineprint"));
    if (!entries.length) history.append(el("p", "No saved questions yet.", "fineprint"));
    for (const entry of entries) {
      if (entry.status === "uncertain") uncertainQuestions.add(String(entry.question ?? "").trim());
      const saved = el("details", null, "card"), summary = el("summary");
      const at = new Date(entry.createdAt), date = Number.isFinite(at.getTime()) ? at.toLocaleString() : "";
      summary.append(el("strong", entry.question), el("small", [entry.status === "complete" ? "Answered" : entry.status === "uncertain" ? "Uncertain" : "Failed", date].filter(Boolean).join(" · ")));
      saved.append(summary);
      if (entry.status === "complete" && entry.result) renderAnswer(entry.result, {}, entry.result.sourceCoverage?.selected ?? entry.result.citations?.length ?? 0, saved, true);
      else saved.append(el("p", entry.error ?? (entry.status === "uncertain" ? "Native acceptance is uncertain. This question will not be retried automatically." : "The question did not complete."), "fineprint"));
      history.append(saved);
    }
    clear.onclick = async () => {
      if (running || !current()) return;
      clear.disabled = true;
      try {
        const result = await api("ask/history", { clear: true });
        if (current()) renderHistory(result);
      } catch (error) { if (current()) { clear.disabled = false; notice(error.message, true); } }
    };
  }
  history.append(el("p", "Loading recent questions…", "fineprint"));
  // Keep restored history separate from the current exchange. A slow read must
  // never reset a draft or replace a question submitted after mounting.
  api("ask/history", {}).then(value => { if (current()) renderHistory(value); }).catch(() => {
    if (current()) history.replaceChildren(el("p", "Recent questions are unavailable. New questions can still be sent.", "fineprint"));
  });
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (running || !current()) return;
    const input = question.value.trim();
    if (!input) return;
    if (uncertainQuestions.has(input)) {
      notice("That question has an uncertain native outcome. It will not be automatically retried; inspect it in Settings before another submission.", true);
      return;
    }
    running = true; cancelled = false; dispatched = false;
    deliveryId = crypto.randomUUID();
    submittedIds.add(deliveryId);
    submit.disabled = true; question.disabled = true; cancel.hidden = false;
    const owner = el("article", null, "card home-chat-question"); owner.append(el("h3", "You"), el("p", input)); messages.append(owner);
    try {
      showStatus("Finding your native connection…");
      const service = await findService(); ensureActive();
      showStatus("Finding relevant work…");
      const search = await api("ask/search", { question: input, mode: "work", ...service });
      ensureActive();
      const sessions = (search.sessions ?? search.sessionMatches ?? []).filter((s) => s.contentAvailable === true).slice(0, 6), nodes = [];
      // Automatic selection omits stale/unavailable files instead of requiring
      // the user to repair an index before asking an ordinary question.
      for (const candidate of (search.work ?? search.workMatches ?? []).filter((n) => ["document", "artifact"].includes(n.kind) && n.hash).slice(0, 20)) {
        ensureActive();
        try { await api("workspace/inspect", { nodeId: candidate.id }); nodes.push(candidate); } catch { /* Keep searching eligible candidates; no model call or retry. */ }
        if (nodes.length >= 6) break;
      }
      const selected = sessions.length + nodes.length;
      showStatus(selected ? "Answering with " + selected + " relevant sources…" : "Answering your general question…");
      ensureActive(); dispatched = true;
      const answer = await api("ask/answer", {
        question: input, mode: selected ? "work" : "general", ...service,
        sourceIds: sessions.map((s) => s.id), nodeIds: nodes.map((n) => n.id),
        executionGranted: true, deliveryId,
        budget: { timeoutMs: 90000, maxOutputTokens: 800, inputChars: 24000, outputChars: 12000 },
      });
      if (!current()) return;
      renderAnswer(answer, search, selected); question.value = "";
      showStatus("Answered. Sources and coverage are available below the response.");
    } catch (error) {
      if (dispatched) uncertainQuestions.add(input);
      else api("ask/history", { record: { deliveryId, question: input, status: "failed" } }).catch(() => {});
      if (current()) {
        const failure = el("article", null, "card home-chat-error");
        failure.append(el("p", error.message), el("p", dispatched ? "The question was not retried. Native acceptance may be uncertain." : "No answering request was sent.", "fineprint"));
        messages.append(failure); showStatus(error.message); notice(error.message, true);
      }
    } finally {
      running = false;
      if (current()) { submit.disabled = false; question.disabled = false; cancel.hidden = true; question.focus(); }
    }
  };
  function dispose() {
    if (disposed) return;
    disposed = true; observer.disconnect();
    if (running && dispatched) api("ask/cancel", { deliveryId }).catch(() => {});
    cancelled = true;
  }
  const observer = new MutationObserver(() => { if (!current()) dispose(); });
  observer.observe(document.body, { childList: true, subtree: true });
  return dispose;
}
