let activeId = null;
function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
function replyLabel(status) {
  const labels = { "waiting-for-native-transport": "Waiting for channel reconnect", "channel-access-changed; not dispatched": "Access changed; message not sent", "connecting-native-agent": "Connecting…", "queued": "Queued in native chat", "conversation-budget-reached": "Automatic exchange paused", "awaiting-native-reply": "Waiting for reply", "native-agent-replied": "Replied", "needs-native-attention": "Needs attention in the native app", "native-reply-uncertain": "Reply status unknown", "native-reply-pending": "Reply pending; native work preserved", "native-agent-unavailable": "Agent unavailable", "delivered-to-native-transport": "Message delivered" };
  if (labels[status]) return labels[status];
  return /blocked|unavailable|access changed/.test(status ?? "") ? "Agent is not connected" : status;
}
function button(text, fn, cls = "secondary") {
  const n = el("button", text, cls);
  n.type = "button";
  n.onclick = fn;
  return n;
}
export async function mountDiscussions(root, state, { api, notice, demoAvailable = false }) {
  const remoteHost = state.remoteHost ?? "remote";
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
    groups = (await api("discussions")).filter((g) => demoAvailable || !g.members.some((m) => m.fixture));
  };
  await load();
  if (!root.isConnected || root.dataset.discussionMount !== mountId) return;
  function render() {
    root.replaceChildren();
    const layout = el("div", null, "discussion-layout"),
      channels = el("aside", null, "discussion-channels"),
      main = el("section", null, "discussion-main");
    channels.append(
      el("h2", "Group chats"),
      button("+ New group chat", () => {
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
            " thread agents" +
            (g.fixture ? " · Demo" : ""),
        ),
      );
      channels.append(b);
    }
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
      el("h2", "Create a group chat"),
      el(
        "p",
        "Bring multiple thread agents into one chat.",
      ),
    );
    title.name = "title";
    title.required = true;
    title.maxLength = 80;
    title.placeholder = "Name this chat";
    const label = el("label", "Chat name");
    label.append(title);
    query.placeholder = "Search threads";
    query.value = search;
    query.setAttribute("aria-label", "Choose thread agents");
    const pick = () => {
      picker.replaceChildren();
      for (const provider of ["codex", "claude"]) {
        picker.append(el("h3", provider === "codex" ? "Codex" : "Claude Code"));
        const rows = state.sessions
          .filter(
            (s) =>
              s.provider === provider &&
              (demoAvailable || !s.fixture) &&
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
              (s.host === remoteHost ? "remote" : "This device") + (s.fixture ? " · Demo" : s.status && s.status !== "unknown" ? " · " + s.status : ""),
            ),
          );
          row.append(input, caption);
          picker.append(row);
        }
      }
      count.textContent =
        chosen.size +
        " selected · showing up to 60 matches per app.";
    };
    query.oninput = () => {
      search = query.value;
      pick();
    };
    pick();
    const submit = el("button", "Create group chat", "primary");
    submit.type = "submit";
    form.append(label, el("h3", "Choose thread agents"), query, picker, count, submit);
    form.onsubmit = run(async (e) => {
      e.preventDefault();
      const g = await api("discussions/create", {
        title: title.value,
        sessionIds: [...chosen],
        agentInitiation: true,
        selfRegistration: true,
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
          ? "Demo chat"
          : g.members.length + " thread agents",
        "tag",
      ),
    );
    const chips = el("p"),
      details = el("details");
    details.append(el("summary", "Thread details & availability"));
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
            (m.available ? m.replyMode : "Unavailable: access changed"),
        ),
      );
      details.append(p);
    }
    header.append(chips, details);
    const registration = el("label", null, "check-row"), allowJoin = el("input");
    allowJoin.type = "checkbox";
    allowJoin.checked = g.policy?.selfRegistration === true;
    allowJoin.onchange = run(async () => {
      await api("discussions/policy", { id: g.id, selfRegistration: allowJoin.checked });
      await load(); render();
    });
    registration.append(allowJoin, document.createTextNode("Connected agents can join this group"));
    header.append(registration);
    const messages = el("div", null, "discussion-messages");
    messages.setAttribute("aria-live", "polite");
    if (!g.available)
      messages.append(
        el(
          "p",
          "Access to a thread changed. Restore access in Settings to view this chat.",
          "discussion-empty",
        ),
      );
    else if (!g.messages.length)
      messages.append(
        el(
          "p",
          "Start a conversation.",
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
      if (m.source) {
        const provenance = el("details");
        provenance.append(el("summary", "Source details"),
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
        if (m.replyTo) provenance.append(el("small", "Reply to message " + m.replyTo));
        content.append(provenance);
      }
      if (m.wire?.metadata?.originalSelectorText) {
        const selection = el('details');
        selection.append(el('summary', 'Addressed agents'), el('p', m.wire.metadata.originalSelectorText));
        try {
          const report = JSON.parse(m.wire.metadata.agentSelectionCoverage ?? '{}');
          const coverage = report.coverage ?? {};
          selection.append(el('p', `${report.selectedCount ?? m.targets?.length ?? 0} selected across ${report.batchCount ?? 1} group(s). Catalog coverage: ${coverage.catalogCompleteness ?? 'not-established'}.`));
          const omitted = Object.entries(report.omitted ?? {}).filter(([, count]) => count > 0).map(([kind,count]) => `${kind}: ${count}`).join(' · ');
          if (omitted) selection.append(el('small', omitted));
        } catch {}
        content.append(selection);
      }
      for (const t of m.targets ?? [])
        content.append(
          el("div", "@" + t.alias + " · " + replyLabel(t.status), "reply-status"),
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
    textarea.placeholder = '@all Share your results, or @recent(30d) @topic("chillit recipe")…';
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
    targets.append(el("summary", "Choose agents to reply"));
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
    if (demoAvailable && g.fixture) {
      const roundsLabel = el(
          "label",
          "Extra demo turns",
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
    }
    const submit = el(
      "button",
      g.fixture ? "Send demo message" : "Send",
      "primary",
    );
    submit.type = "submit";
    submit.disabled = !g.available;
    controls.append(submit);
    form.append(
      el("p", 'Use @aliases, @all, @thread(UUID), @recent(30d), or @topic("keywords"). Topic and date filters select connected peers beyond this room.', "fineprint"),
      label,
      textarea,
      suggestions,
      controls,
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
      const latest = (await api("discussions")).filter((g) => demoAvailable || !g.members.some((m) => m.fixture)),
        next = latest.find((g) => g.id === activeId),
        old = groups.find((g) => g.id === activeId);
      // Preserve in-progress drafts; refresh remote contributions once composer is empty.
      if (
        !root.querySelector("#discussion-text")?.value &&
        next &&
        (next.version !== old?.version || next.available !== old?.available || JSON.stringify(next.messages.map(m => m.targets)) !== JSON.stringify(old?.messages.map(m => m.targets)))
      ) {
        groups = latest;
        render();
      }
    } catch {
      /* No message or execution replay on a UI refresh failure. */
    }
  }, 4000);
}
