let activeId = null;
function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
function button(text, fn, cls = "secondary") {
  const n = el("button", text, cls);
  n.type = "button";
  n.onclick = fn;
  return n;
}
export async function mountDiscussions(root, state, { api, notice }) {
  const mountId = crypto.randomUUID();
  root.dataset.discussionMount = mountId;
  let groups = [],
    search = "",
    chosen = new Set();
  const run = (fn) => async (e) => {
    try {
      await fn(e);
    } catch (error) {
      notice(error.message, true);
    }
  };
  const load = async () => {
    groups = await api("discussions");
  };
  await load();
  if (!root.isConnected || root.dataset.discussionMount !== mountId) return;
  function render() {
    root.replaceChildren();
    const layout = el("div", null, "discussion-layout"),
      channels = el("aside", null, "discussion-channels"),
      main = el("section", null, "discussion-main");
    channels.append(
      el("h2", "Discussions"),
      button("+ New discussion", () => {
        activeId = null;
        render();
      }),
    );
    for (const g of groups) {
      const b = button(
        "# " + g.title,
        () => {
          activeId = g.id;
          render();
        },
        "channel" + (activeId === g.id ? " selected" : ""),
      );
      b.append(
        el(
          "small",
          g.members.length +
            " source threads · " +
            (g.fixture ? "synthetic" : "native references"),
        ),
      );
      channels.append(b);
    }
    channels.append(
      el(
        "p",
        "Each source keeps its native history, workspace and permissions.",
        "discussion-note",
      ),
    );
    layout.append(channels, main);
    root.append(layout);
    const group = groups.find((g) => g.id === activeId);
    if (group) conversation(main, group);
    else createForm(main);
  }
  function createForm(main) {
    const card = el("div", null, "card"),
      form = el("form"),
      title = el("input"),
      query = el("input"),
      picker = el("div", null, "thread-picker"),
      count = el("p", null, "fineprint");
    card.append(
      el("h2", "Start a shared discussion"),
      el(
        "p",
        "Choose references from discovered Codex and Claude Code threads. Adding references does not load their histories.",
      ),
    );
    title.name = "title";
    title.required = true;
    title.maxLength = 80;
    title.placeholder = "Client design review";
    const label = el("label", "Discussion name");
    label.append(title);
    query.placeholder = "Search title, tool or host";
    query.value = search;
    query.setAttribute("aria-label", "Find source threads");
    const pick = () => {
      picker.replaceChildren();
      for (const provider of ["codex", "claude"]) {
        picker.append(el("h3", provider === "codex" ? "Codex" : "Claude Code"));
        const rows = state.sessions
          .filter(
            (s) =>
              s.provider === provider &&
              [s.title, s.host, s.id]
                .join(" ")
                .toLowerCase()
                .includes(search.toLowerCase()),
          )
          .slice(0, 60);
        for (const s of rows) {
          const row = el("label", null, "thread-option"),
            input = el("input"),
            caption = el("span");
          input.type = "checkbox";
          input.checked = chosen.has(s.id);
          input.value = s.id;
          input.onchange = () => {
            input.checked ? chosen.add(s.id) : chosen.delete(s.id);
            count.textContent = chosen.size + " selected";
          };
          caption.append(
            el("b", s.title),
            el(
              "small",
              (s.host ?? "local") +
                " · " +
                (s.nativeThreadId ?? s.id) +
                " · " +
                (s.fixture ? "synthetic" : s.status),
            ),
          );
          row.append(input, caption);
          picker.append(row);
        }
      }
      count.textContent =
        chosen.size +
        " selected · up to 60 matches per app; narrow the search for another thread.";
    };
    query.oninput = () => {
      search = query.value;
      pick();
    };
    pick();
    const submit = el("button", "Create discussion", "primary");
    submit.type = "submit";
    form.append(label, query, picker, count, submit);
    form.onsubmit = run(async (e) => {
      e.preventDefault();
      const g = await api("discussions/create", {
        title: title.value,
        sessionIds: [...chosen],
      });
      activeId = g.id;
      await load();
      render();
    });
    card.append(form);
    main.append(card);
  }
  function conversation(main, g) {
    const header = el("div", null, "discussion-header");
    header.append(
      el("h2", "# " + g.title),
      el(
        "span",
        g.fixture
          ? "Synthetic conversation demo"
          : "Native references · cooperative replies",
        "tag",
      ),
    );
    const chips = el("p"),
      details = el("details");
    details.append(el("summary", "Source threads & reply availability"));
    for (const m of g.members) {
      chips.append(
        el("span", "@" + m.alias + " · " + m.host, "participant-chip"),
      );
      const p = el("p", "@" + m.alias + " · " + m.title);
      p.append(
        el("br"),
        el(
          "small",
          m.nativeThreadId +
            " · " +
            (m.available ? m.replyMode : "source scope unavailable"),
        ),
      );
      details.append(p);
    }
    details.append(
      el(
        "p",
        "Automatic native wake is unavailable. A configured participant can read and contribute using scoped MCP tools. Its native turn ID is self-reported.",
        "fineprint",
      ),
    );
    header.append(chips, details);
    const messages = el("div", null, "discussion-messages");
    messages.setAttribute("aria-live", "polite");
    if (!g.available)
      messages.append(
        el(
          "p",
          "A source scope is unavailable. Cached conversation content is hidden.",
          "discussion-empty",
        ),
      );
    else if (!g.messages.length)
      messages.append(
        el(
          "p",
          "Start with a question. Mention the source threads you want to hear from.",
          "discussion-empty",
        ),
      );
    for (const m of g.messages) {
      const row = el("article", null, "discussion-message"),
        avatar = el(
          "div",
          m.source ? m.source.provider[0].toUpperCase() : "Y",
          "message-avatar" + (m.source?.provider === "claude" ? " claude" : ""),
        ),
        content = el("div");
      content.append(
        el("b", m.author),
        el(
          "small",
          " · " +
            new Date(m.at).toLocaleTimeString() +
            (m.synthetic ? " · Synthetic" : ""),
        ),
        el("p", m.text, "message-text"),
      );
      if (m.source)
        content.append(
          el(
            "p",
            m.source.host +
              " · source " +
              m.source.nativeThreadId +
              " · turn " +
              m.turnId +
              " · " +
              m.wire.metadata.attribution,
            "message-provenance",
          ),
        );
      if (m.replyTo)
        content.append(el("small", "Reply to message " + m.replyTo));
      for (const t of m.targets ?? [])
        content.append(
          el("div", "@" + t.alias + " · " + t.status, "reply-status"),
        );
      row.append(avatar, content);
      messages.append(row);
    }
    const form = el("form", null, "discussion-compose"),
      textarea = el("textarea"),
      label = el("label", "Message #" + g.title),
      suggestions = el("div"),
      controls = el("div", null, "compose-controls");
    textarea.id = "discussion-text";
    textarea.name = "text";
    textarea.required = true;
    textarea.maxLength = 8000;
    textarea.rows = 3;
    textarea.placeholder = "What can we reuse from @codex1 and @claude1?";
    textarea.disabled = !g.available;
    label.htmlFor = textarea.id;
    textarea.oninput = () => {
      suggestions.replaceChildren();
      const part = /(?:^|\s)@([a-zA-Z0-9_-]*)$/.exec(
        textarea.value.slice(0, textarea.selectionStart),
      );
      if (!part) return;
      for (const m of g.members.filter((m) => m.alias.startsWith(part[1])))
        suggestions.append(
          button(
            "@" + m.alias + " · " + m.title,
            () => {
              const end = textarea.selectionStart;
              textarea.setRangeText(
                "@" + m.alias + " ",
                end - part[1].length - 1,
                end,
                "end",
              );
              suggestions.replaceChildren();
              textarea.focus();
            },
            "subtle",
          ),
        );
    };
    const targets = el("details", null, "reply-selector");
    targets.append(el("summary", "Choose threads to reply"));
    for (const provider of ["codex", "claude"]) {
      targets.append(el("h3", provider === "codex" ? "Codex" : "Claude Code"));
      for (const m of g.members.filter((m) => m.provider === provider)) {
        const row = el("label", "@" + m.alias + " · " + m.title, "check-row"),
          input = el("input");
        input.type = "checkbox";
        input.name = "target";
        input.value = m.sessionId;
        row.prepend(input);
        targets.append(row);
      }
    }
    controls.append(targets);
    if (g.fixture) {
      const roundsLabel = el(
          "label",
          "Extra synthetic dialogue turns",
          "dialogue-budget",
        ),
        rounds = el("select");
      rounds.name = "rounds";
      for (const v of [0, 2, 4]) {
        const o = el("option", String(v));
        o.value = v;
        rounds.append(o);
      }
      roundsLabel.append(rounds);
      controls.append(roundsLabel);
    } else
      controls.append(
        el(
          "small",
          "Selected native requests stay blocked; no wake is dispatched.",
        ),
      );
    const submit = el(
      "button",
      g.fixture ? "Send & simulate selected replies" : "Send message",
      "primary",
    );
    submit.type = "submit";
    submit.disabled = !g.available;
    controls.append(submit);
    form.append(
      label,
      textarea,
      suggestions,
      controls,
      el(
        "p",
        "Mentions and checked threads are combined. Without targets, the message stays here. No paid model calls.",
        "fineprint",
      ),
    );
    let deliveryId = null;
    form.onsubmit = run(async (e) => {
      e.preventDefault();
      const data = new FormData(form);
      deliveryId ??= crypto.randomUUID();
      submit.disabled = true;
      try {
        await api("discussions/post", {
          id: g.id,
          text: data.get("text"),
          targets: data.getAll("target"),
          fixtureDialogueTurns: Number(data.get("rounds") ?? 0),
          deliveryId,
        });
        await load();
        render();
        root.querySelector(".discussion-messages").scrollTop = 1e9;
      } finally {
        if (submit.isConnected) submit.disabled = false;
      }
    });
    main.append(header, messages, form);
  }
  render();
  const timer = setInterval(async () => {
    if (!root.isConnected || root.dataset.discussionMount !== mountId)
      return clearInterval(timer);
    if (document.hidden || !activeId) return;
    try {
      const latest = await api("discussions"),
        next = latest.find((g) => g.id === activeId),
        old = groups.find((g) => g.id === activeId);
      // Preserve in-progress drafts; refresh remote contributions once composer is empty.
      if (
        !root.querySelector("#discussion-text")?.value &&
        next &&
        (next.version !== old?.version || next.available !== old?.available)
      ) {
        groups = latest;
        render();
      }
    } catch {
      /* No message or execution replay on a UI refresh failure. */
    }
  }, 4000);
}
