const node = (tag, text, cls) => {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
function field(label, element) {
  const e = node("label", label);
  element.setAttribute("aria-label", label);
  e.append(element);
  return e;
}
function select(name, options) {
  const e = node("select");
  e.name = name;
  for (const [value, text] of options) {
    const o = node("option", text);
    o.value = value;
    e.append(o);
  }
  return e;
}
function answerText(text) {
  const body = node("div", null, "ask-answer-text");
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    const paragraph = node("p");
    let offset = 0;
    for (const bold of line.matchAll(/\*\*([^*]+)\*\*/g)) {
      paragraph.append(
        document.createTextNode(line.slice(offset, bold.index)),
        node("strong", bold[1]),
      );
      offset = bold.index + bold[0].length;
    }
    paragraph.append(document.createTextNode(line.slice(offset)));
    body.append(paragraph);
  }
  return body;
}
export async function mountAsk(root, { api, notice }) {
  const mount = crypto.randomUUID();
  root.dataset.askMount = mount;
  const form = node("form", null, "card ask-form"),
    question = node("textarea"),
    results = node("section", null, "ask-results"),
    candidates = node("div", null, "ask-candidates"),
    availability = node("p", "Checking answering services…", "fineprint");
  question.name = "question";
  question.required = true;
  question.maxLength = 4000;
  question.rows = 4;
  question.placeholder =
    "What have we done on retry handling? What was decided, tested and left unfinished?";
  const mode = select("mode", [
      ["general", "General question"],
      ["work", "Use connected work"],
    ]),
    provider = select("provider", [
      ["codex", "OpenAI through native Codex"],
      ["claude", "Claude through provider-permitted API"],
    ]),
    host = select("host", [
      ["remote", "remote / Linux"],
      ["local", "This device"],
    ]);
  const topic = node("input");
  topic.name = "topic";
  topic.placeholder = "Optional topic keywords, e.g. retry transport";
  topic.maxLength = 200;
  const controls = node("div", null, "ask-controls");
  controls.append(
    field("Answering service", provider),
    field("Run on", host),
    field("Context", mode),
  );
  const budget = node("details"),
    summary = node("summary", "Question limits");
  budget.append(
    summary,
    node(
      "p",
      "One fresh question per submission. The native answer has no original-thread resume. Time and captured-output bounds apply; the Codex output-token limit is an instruction, not a guaranteed billing cap.",
      "fineprint",
    ),
  );
  const tokens = node("input");
  tokens.name = "tokens";
  tokens.type = "number";
  tokens.min = 1;
  tokens.max = 2000;
  tokens.value = 800;
  const seconds = node("input");
  seconds.name = "seconds";
  seconds.type = "number";
  seconds.min = 5;
  seconds.max = 120;
  seconds.value = 90;
  const cost = node("input");
  cost.name = "cost";
  cost.type = "number";
  cost.min = 0.01;
  cost.max = 5;
  cost.step = 0.01;
  cost.value = 0.05;
  budget.append(
    field("Requested maximum answer tokens", tokens),
    field("Timeout in seconds", seconds),
    field("Claude API request budget in USD", cost),
  );
  const search = node("button", "Find relevant work", "secondary");
  search.type = "button";
  const submit = node("button", "Ask", "primary");
  submit.type = "submit";
  const cancel = node("button", "Stop waiting", "secondary");
  cancel.type = "button";
  cancel.hidden = true;
  form.append(
    field("Your question", question),
    controls,
    field("Topic filter", topic),
    availability,
    search,
    candidates,
    budget,
    submit,
    cancel,
  );
  root.replaceChildren(form, results);
  let searchResult = null,
    selectedSources = new Set(),
    selectedNodes = new Set(),
    deliveryId = null,
    running = false;
  async function probe() {
    availability.textContent = "Checking answering services…";
    try {
      const services = await api("ask/providers", { host: host.value });
      if (root.dataset.askMount !== mount) return;
      const available = services.find((s) => s.provider === provider.value);
      availability.textContent = available
        ? (available.available ? "Ready: " : "Unavailable: ") +
          (available.reason ??
            available.authentication ??
            available.version ??
            "See setup")
        : "Answering service unavailable";
    } catch (e) {
      availability.textContent = e.message;
    }
  }
  host.onchange = probe;
  provider.onchange = probe;
  mode.onchange = () => {
    search.hidden = mode.value === "general";
    topic.disabled = mode.value === "general";
    candidates.hidden = mode.value === "general";
  };
  mode.onchange();
  search.onclick = async () => {
    try {
      if (!question.value.trim()) throw new Error("Enter a question first");
      search.disabled = true;
      searchResult = await api("ask/search", {
        question: question.value,
        topic: topic.value,
        mode: mode.value,
        provider: provider.value,
        host: host.value,
      });
      deliveryId = null;
      selectedSources.clear();
      selectedNodes.clear();
      renderCandidates();
    } catch (e) {
      notice(e.message, true);
    } finally {
      search.disabled = false;
    }
  };
  function renderCandidates() {
    candidates.replaceChildren();
    const sessions = searchResult.sessionMatches ?? searchResult.sessions ?? [],
      works = searchResult.workMatches ?? searchResult.work ?? [];
    candidates.append(
      node("h3", "Relevant sources"),
      node(
        "p",
        "Select findings and files to include. Content and sharing permissions are checked before the answering service receives anything.",
        "fineprint",
      ),
    );
    for (const s of sessions) {
      const input = node("input");
      input.type = "checkbox";
      input.value = s.id;
      input.disabled = s.contentAvailable === false;
      input.onchange = () => {
        if (!running) deliveryId = null;
        input.checked
          ? selectedSources.add(s.id)
          : selectedSources.delete(s.id);
      };
      const row = node("label", null, "check-row");
      row.append(
        input,
        node(
          "span",
          s.title + " · " + s.provider + " · " + (s.host ?? "local"),
        ),
      );
      candidates.append(row);
    }
    for (const n of works) {
      const input = node("input");
      input.type = "checkbox";
      input.value = n.id;
      input.disabled = !["document", "artifact"].includes(n.kind) || !n.hash;
      input.onchange = () => {
        if (!running) deliveryId = null;
        input.checked ? selectedNodes.add(n.id) : selectedNodes.delete(n.id);
      };
      const row = node("label", null, "check-row");
      row.append(
        input,
        node("span", (n.title ?? n.path ?? n.id) + " · " + n.kind),
      );
      candidates.append(row);
    }
    const coverage = node("details");
    coverage.append(
      node("summary", "Search coverage"),
      node(
        "pre",
        JSON.stringify(
          searchResult.sourceCoverage ?? searchResult.coverage ?? {},
          null,
          2,
        ),
        "ask-evidence",
      ),
    );
    candidates.append(coverage);
    candidates.append(
      node(
        "p",
        "Original-thread fan-out is not enabled by this answer. Native thread references remain available in Discussions.",
        "fineprint",
      ),
    );
  }
  question.oninput = topic.oninput = () => {
    if (!running) deliveryId = null;
  };
  for (const input of [mode, provider, host, tokens, seconds, cost])
    input.addEventListener("change", () => {
      if (!running) deliveryId = null;
    });
  cancel.onclick = async () => {
    try {
      notice((await api("ask/cancel", { deliveryId })).status);
    } catch (e) {
      notice(e.message, true);
    }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (running) return;
    try {
      if (mode.value === "work" && !selectedSources.size && !selectedNodes.size)
        throw new Error("Find and select permitted work first");
      deliveryId ??= crypto.randomUUID();
      running = true;
      submit.disabled = true;
      cancel.hidden = false;
      results.replaceChildren(
        node("p", "Waiting for the answering service…", "card"),
      );
      const answer = await api("ask/answer", {
        question: question.value,
        topic: topic.value,
        mode: mode.value,
        provider: provider.value,
        host: host.value,
        sourceIds: mode.value === "work" ? [...selectedSources] : [],
        nodeIds: mode.value === "work" ? [...selectedNodes] : [],
        executionGranted: true,
        deliveryId,
        budget: {
          timeoutMs: Number(seconds.value) * 1000,
          maxOutputTokens: Number(tokens.value),
          inputChars: 24000,
          outputChars: 12000,
          ...(provider.value === "claude"
            ? { maxCostUsd: Number(cost.value) }
            : {}),
        },
      });
      results.replaceChildren();
      const card = node("article", null, "card ask-answer");
      card.append(
        node(
          "h2",
          answer.executionKind?.includes("fixture")
            ? "Synthetic test answer"
            : "Answer",
        ),
        answerText(answer.text ?? answer.answer),
      );
      card.append(
        node(
          "p",
          [
            answer.provider,
            answer.host,
            answer.nativeThreadId
              ? "Native thread " + answer.nativeThreadId
              : "",
            answer.nativeTurnId ? "Turn " + answer.nativeTurnId : "",
          ]
            .filter(Boolean)
            .join(" · "),
          "fineprint",
        ),
      );
      if (answer.citations?.length) {
        card.append(node("h3", "Sources"));
        for (const c of answer.citations) {
          const citation = node("details");
          citation.append(
            node(
              "summary",
              (c.id ?? c.label ?? "Source") +
                " · " +
                (c.title ??
                  c.path ??
                  c.nativeThreadId ??
                  c.threadId ??
                  c.sessionId ??
                  ""),
            ),
            node("pre", JSON.stringify(c, null, 2), "ask-evidence"),
          );
          card.append(citation);
        }
      }
      const evidence = node("details");
      evidence.append(
        node("summary", "Usage and coverage"),
        node(
          "pre",
          JSON.stringify(
            {
              usage: answer.usage,
              coverage: answer.sourceCoverage ?? answer.coverage,
              limitations: answer.limitations,
            },
            null,
            2,
          ),
          "ask-evidence",
        ),
      );
      card.append(evidence);
      results.append(card);
    } catch (error) {
      results.replaceChildren(node("p", error.message, "card"));
      notice(error.message, true);
    } finally {
      running = false;
      submit.disabled = false;
      cancel.hidden = true;
    }
  };
  await probe();
}
