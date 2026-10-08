export function nativeControls(state) {
  const form = document.querySelector("#native-form");
  if (!form) return;
  form.closest(".card").querySelector("h2").textContent =
    "Discover native metadata";
  const note = form.closest(".card").querySelector("p");
  note.textContent =
    "Choose a native tool and host, then authorize one project folder. Use the same project label/account boundary only when explicitly linking permitted work across hosts. Metadata may include a provider title derived from its first prompt. Content remains separately gated.";
  for (const [name, description, choices] of [
    [
      "host",
      "Host",
      [
        ["local", "Local workstation / this Windows device"],
        ["remote", "remote / Linux over SSH"],
      ],
    ],
    [
      "provider",
      "Native tool",
      [
        ["codex", "Codex"],
        ["claude", "Claude Code"],
      ],
    ],
  ]) {
    const label = document.createElement("label");
    label.textContent = description;
    const select = document.createElement("select");
    select.name = name;
    for (const [value, text] of choices) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.append(option);
    }
    label.append(select);
    form.prepend(label);
  }
  const probe = document.createElement("button");
  probe.type = "button";
  probe.className = "secondary";
  probe.dataset.action = "probe-remote";
  probe.textContent = "Detect native tools on remote";
  form.before(probe);
  const fine = form.closest(".card").querySelector(".fineprint");
  fine.textContent =
    "At most 50 records per read. Codex current/archive filtering is native; Claude SDK session activity/archive state is unknown. No blanket transcript indexing or model summarization. SSH authentication stays with your existing connection.";
  for (const project of state.projects)
    for (const [key, target] of Object.entries(project.targets ?? {})) {
      if (target.nextCursor === null || target.nextCursor === undefined)
        continue;
      const more = document.createElement("button");
      more.className = "secondary";
      more.type = "button";
      more.dataset.action = "more-native";
      more.dataset.project = project.id;
      more.dataset.target = key;
      more.textContent = "Load next metadata page: " + project.id + " / " + key;
      form.after(more);
    }
  document.querySelectorAll(".tool-card").forEach((card, index) => {
    const tool = state.tools[index];
    const caption = card.querySelector("small");
    caption.textContent +=
      tool.host === "remote" ? " · remote / Linux" : " · this device / Windows";
    if (tool.installed) {
      const button = document.createElement("button");
      button.className = "subtle";
      button.type = "button";
      button.dataset.action = "sign-in";
      button.dataset.provider = tool.provider;
      button.dataset.host = tool.host ?? "local";
      button.textContent = "Open native sign-in";
      card.after(button);
    }
  });
}
