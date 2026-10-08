let graph = null,
  query = "",
  kind = "all",
  selected = null,
  polling = null;
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const action = (text, name, className = "secondary", data = {}) => {
  const button = el("button", text, className);
  button.type = "button";
  button.dataset.action = name;
  Object.assign(button.dataset, data);
  return button;
};
const field = (text, name, value = "", type = "text") => {
  const label = el("label", text);
  const input = el("input");
  input.name = name;
  input.type = type;
  input.value = value;
  label.append(input);
  return label;
};
function choice(labelText, name, options, value) {
  const label = el("label", labelText),
    select = el("select");
  select.name = name;
  for (const [key, text] of options) {
    const option = el("option", text);
    option.value = key;
    option.selected = key === value;
    select.append(option);
  }
  label.append(select);
  return label;
}
export function workspacePage(summary) {
  const root = el("div");
  root.append(
    el(
      "p",
      "One permissioned map of native sessions, repositories, worktrees, documents and work left behind. No model calls.",
      "map-intro",
    ),
  );
  const stats = el("div", undefined, "map-stats");
  for (const [type, label] of [
    ["session", "Sessions"],
    ["repository", "Repositories"],
    ["worktree", "Worktrees"],
    ["document", "Documents"],
    ["artifact", "Work artifacts"],
  ]) {
    const card = el("div", undefined, "stat");
    card.append(
      el("div", label.toUpperCase(), "stat-label"),
      el("strong", String(summary?.counts?.[type] ?? 0)),
    );
    stats.append(card);
  }
  root.append(stats);
  const setup = el("details", undefined, "card map-setup");
  setup.open = !summary?.profile?.active;
  setup.append(el("summary", "Find everything on my connected machines"));
  const form = el("form");
  form.id = "workspace-scope-form";
  const domains = el("div", undefined, "permission-grid");
  for (const [value, text, checked] of [
    ["local", "This Windows device", true],
    ["remote", "remote over existing SSH", true],
    ["codex", "Codex metadata", true],
    ["claude", "Claude Code metadata", true],
  ]) {
    const label = el("label", undefined, "check-row"),
      input = el("input");
    input.type = "checkbox";
    input.name = ["local", "remote"].includes(value) ? "hosts" : "providers";
    input.value = value;
    input.checked = summary?.profile?.[input.name]?.includes(value) ?? checked;
    label.append(input, document.createTextNode(text));
    domains.append(label);
  }
  form.append(
    domains,
    field(
      "Account boundary label",
      "account",
      summary?.profile?.account ?? "personal",
    ),
    choice(
      "Lookup policy",
      "policy",
      [
        ["metadata", "Find everything · metadata only"],
        ["local-retrieval", "Find and retrieve everything locally"],
      ],
      summary?.profile?.policy ?? "local-retrieval",
    ),
  );
  const readLabel = el("label", undefined, "check-row"),
    read = el("input");
  read.type = "checkbox";
  read.name = "indexFiles";
  read.checked = summary?.profile?.indexFiles ?? true;
  readLabel.append(
    read,
    document.createTextNode(
      "Read local code/docs/artifacts for links, hashes and comparisons",
    ),
  );
  form.append(readLabel);
  const advanced = el("details");
  advanced.append(el("summary", "Optional exclusions and workspace roots"));
  for (const [name, text] of [
    [
      "exclusions",
      "Excluded absolute folders, one per line (prefix remote| for Linux)",
    ],
    [
      "roots",
      "Optional roots, one per line (leave blank for automatic locations)",
    ],
  ]) {
    const label = el("label", text),
      textarea = el("textarea");
    textarea.name = name;
    textarea.rows = 3;
    textarea.value = Object.entries(summary?.profile?.[name] ?? {})
      .flatMap(([host, paths]) =>
        paths.map((path) => (host === "remote" ? "remote|" : "") + path),
      )
      .join("\n");
    textarea.placeholder =
      name === "exclusions"
        ? "C:\\private-project\nremote|/home/me/private-project"
        : "Automatic: native working folders and conventional workspace folders";
    label.append(textarea);
    advanced.append(label);
  }
  form.append(advanced);
  const submit = el("button", "Connect selected scope", "primary");
  submit.type = "submit";
  form.append(
    submit,
    el(
      "p",
      "Metadata discovery does not wake sessions. Broad local lookup replaces individual enrollment for this scope; exclusions and per-session revocations still apply. The account label is a local permission domain, not verified historical provider ownership. No execution or external publication is granted. Changes activate when inventory completes; Revoke disables the current scope immediately.",
      "fineprint",
    ),
  );
  setup.append(form);
  root.append(setup);
  const controls = el("div", undefined, "actions");
  if (summary?.demoAvailable) controls.append(action("Explore synthetic work map", "workspace-sample"));
  controls.append(
    action("Refresh granted scope", "workspace-refresh"),
    action("Continue remaining inventory", "workspace-continue"),
    action("Cancel inventory", "workspace-cancel"),
    action("Revoke broad scope", "workspace-revoke", "subtle"),
  );
  root.append(controls);
  const status = el("div", undefined, "info-line");
  status.id = "workspace-progress";
  status.textContent = summary?.running
    ? "Inventory: " + JSON.stringify(summary.progress)
    : summary?.stale
      ? "Cached view restored. Refresh to observe current source revisions."
      : summary?.fixture
        ? "Synthetic sessions and files in actual temporary Git worktrees. No private history."
        : "Derived read-only view. Coverage and unknown states stay explicit.";
  root.append(status);
  const coverage = el("details", undefined, "card");
  coverage.append(el("summary", "Coverage, gaps and limits"));
  const info = el(
    "pre",
    JSON.stringify(
      {
        coverage: summary?.coverage ?? [],
        errors: summary?.errors ?? [],
        moreMetadata: summary?.hasMore ?? false,
      },
      null,
      2,
    ),
  );
  coverage.append(info);
  root.append(coverage);
  const panel = el("section", undefined, "panel");
  const header = el("div", undefined, "panel-title");
  header.append(
    el("h2", "Connected work map"),
    el("span", "Evidence before inference", "tag"),
  );
  panel.append(header);
  const search = el("div", undefined, "searchbar"),
    input = el("input");
  input.id = "workspace-search";
  input.setAttribute("aria-label", "Search connected work");
  input.placeholder =
    "Find a thread, repo, worktree, document or work artifact";
  input.value = query;
  const select = el("select");
  select.id = "workspace-kind";
  select.setAttribute("aria-label", "Map item type");
  for (const value of [
    "all",
    "session",
    "repository",
    "worktree",
    "document",
    "artifact",
  ]) {
    const option = el("option", value === "all" ? "All connections" : value);
    option.value = value;
    option.selected = value === kind;
    select.append(option);
  }
  search.append(input, select);
  panel.append(search);
  const split = el("div", undefined, "map-split"),
    list = el("div");
  list.id = "workspace-results";
  const detail = el("div");
  detail.id = "workspace-detail";
  detail.className = "map-detail";
  split.append(list, detail);
  panel.append(split);
  root.append(panel);
  const compare = el("section", undefined, "card map-compare");
  compare.append(
    el("h2", "Compare worktrees"),
    el(
      "p",
      "Compare exact Git heads, unique commits, committed file deltas, local dirty patches and untracked hashes. No merge, cleanup or acceptance is inferred.",
    ),
  );
  const row = el("div", undefined, "actions");
  for (const [id, label] of [
    ["compare-left", "Left worktree"],
    ["compare-right", "Right worktree"],
  ]) {
    const select = el("select");
    select.id = id;
    select.setAttribute("aria-label", label);
    row.append(select);
  }
  row.append(
    action("Compare selected worktrees", "workspace-compare", "primary"),
  );
  compare.append(row);
  const result = el("div");
  result.id = "workspace-comparison";
  compare.append(result);
  root.append(compare);
  queueMicrotask(renderGraph);
  return root;
}
function renderGraph() {
  if (!document.querySelector("#workspace-results")) return;
  const list = document.querySelector("#workspace-results");
  list.replaceChildren();
  if (!graph?.nodes?.length) {
    list.append(
      el("div", "Connect a scope or explore the synthetic map.", "empty"),
    );
    return;
  }
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const nodes = graph.nodes
    .filter(
      (n) =>
        (kind === "all" || n.kind === kind) &&
        words.every((w) =>
          [n.title, n.path, n.branch, n.provider, n.host]
            .join(" ")
            .toLowerCase()
            .includes(w),
        ),
    )
    .sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title),
    );
  list.append(
    el(
      "p",
      "Showing " +
        Math.min(nodes.length, 150) +
        " of " +
        nodes.length +
        " matching items. Refine the search for a large workspace.",
      "fineprint map-count",
    ),
  );
  for (const node of nodes.slice(0, 150)) {
    const button = el("button", undefined, "map-node");
    button.type = "button";
    button.dataset.action = "workspace-node";
    button.dataset.id = node.id;
    button.append(
      el("span", node.kind, "tag"),
      el("strong", node.title),
      el(
        "small",
        (node.host ?? "") + " · " + (node.path ?? node.nativeThreadId ?? ""),
      ),
    );
    list.append(button);
  }
  const trees = graph.nodes.filter(
    (n) => n.kind === "worktree" && n.readAllowed,
  );
  for (const id of ["compare-left", "compare-right"]) {
    const select = document.querySelector("#" + id);
    const previous = select.value;
    select.replaceChildren(el("option", "Choose worktree"));
    select.firstChild.value = "";
    for (const node of trees) {
      const option = el(
        "option",
        node.host +
          " · " +
          node.title +
          " · " +
          (node.branch?.replace("refs/heads/", "") ?? "detached"),
      );
      option.value = node.id;
      option.selected = node.id === previous;
      select.append(option);
    }
  }
  if (selected && graph.nodes.some((n) => n.id === selected))
    detailNode(selected);
}
function detailNode(id) {
  selected = id;
  const node = graph.nodes.find((n) => n.id === id),
    panel = document.querySelector("#workspace-detail");
  if (!node || !panel) return;
  panel.replaceChildren(
    el("span", node.kind.toUpperCase(), "eyebrow"),
    el("h2", node.title),
  );
  const values = el("dl", undefined, "map-facts");
  for (const key of [
    "host",
    "provider",
    "nativeThreadId",
    "path",
    "branch",
    "head",
    "worktreeHead",
    "dirty",
    "untracked",
    "relativePath",
    "localState",
    "trackedBlob",
    "hash",
    "bytes",
    "sourceVersion",
    "observedAt",
    "verification",
    "integration",
  ])
    if (node[key] !== undefined && node[key] !== null) {
      values.append(el("dt", key), el("dd", String(node[key])));
    }
  panel.append(values);
  if (node.scratchLocation)
    panel.append(
      el(
        "p",
        "Scratch location. Existence and Git status do not establish verification or acceptance.",
        "fineprint",
      ),
    );
  if (node.kind === "session")
    panel.append(
      action("Inspect session permissions / finding", "inspect", "secondary", {
        id: node.participantId,
      }),
    );
  if (["document", "artifact"].includes(node.kind) && node.hash)
    panel.append(
      action("Inspect exact indexed file", "workspace-inspect", "secondary", {
        id: node.id,
      }),
    );
  panel.append(el("h3", "How it connects"));
  const relations = graph.edges.filter((e) => e.from === id || e.to === id);
  if (!relations.length)
    panel.append(
      el("p", "No evidenced relationship observed yet.", "fineprint"),
    );
  for (const edge of relations.slice(0, 40)) {
    const other = graph.nodes.find(
      (n) => n.id === (edge.from === id ? edge.to : edge.from),
    );
    if (!other) continue;
    const item = el("div", undefined, "map-relation");
    item.append(
      el("span", edge.relation + " · " + edge.confidence, "tag"),
      action(other.title, "workspace-node", "subtle", { id: other.id }),
      el("p", edge.evidence, "fineprint"),
    );
    panel.append(item);
  }
  const content = el("div");
  content.id = "workspace-file-content";
  panel.append(content);
}
function renderComparison(result) {
  const root = el("div");
  root.append(
    el(
      "h3",
      "Left-only commits: " +
        result.leftOnly +
        " · Right-only commits: " +
        result.rightOnly,
    ),
    el("p", result.integration, "fineprint"),
  );
  const cards = el("div", undefined, "comparison-cards");
  for (const [side, label] of [
    [result.left, "Left worktree"],
    [result.right, "Right worktree"],
  ]) {
    const card = el("div", undefined, "comparison-card");
    card.append(
      el("span", label, "eyebrow"),
      el("h3", side.branch?.replace("refs/heads/", "") ?? "detached"),
      el("code", side.head.slice(0, 12)),
      el(
        "p",
        side.localChanges.length + " local changed/untracked paths",
        "fineprint",
      ),
    );
    const list = el("ul");
    for (const change of side.localChanges.slice(0, 30)) {
      const row = el("li");
      row.append(
        el(
          "span",
          change.xy === "??"
            ? "Untracked"
            : change.xy === " M"
              ? "Modified"
              : change.xy,
          "tag",
        ),
        document.createTextNode(" " + change.path),
      );
      list.append(row);
    }
    card.append(list);
    if (side.patch) {
      const details = el("details");
      details.append(
        el("summary", "Inspect bounded local patch"),
        el("pre", side.patch),
      );
      card.append(details);
    }
    if (side.untracked.length) {
      const details = el("details");
      details.append(
        el("summary", "Untracked byte hashes (" + side.untracked.length + ")"),
        el(
          "pre",
          side.untracked
            .map((f) => f.path + "\n  " + (f.hash ?? "Hash exceeds size bound"))
            .join("\n"),
        ),
      );
      card.append(details);
    }
    cards.append(card);
  }
  root.append(cards, el("h3", "Committed file changes"));
  const files = el("ul", undefined, "comparison-files");
  for (const file of result.changedFiles)
    files.append(el("li", file.replace("\t", " · ")));
  if (!result.changedFiles.length)
    files.append(el("li", "No committed file differences observed."));
  root.append(files);
  root.append(
    el(
      "p",
      result.overlappingLocalPaths.length
        ? "Overlapping local paths: " + result.overlappingLocalPaths.join(", ")
        : "No overlapping local changed paths observed. This is not a safe-merge decision.",
      "fineprint",
    ),
  );
  const facts = el("details");
  facts.append(
    el("summary", "Exact revision and comparison evidence"),
    el(
      "pre",
      "Left: " +
        result.left.head +
        "\nRight: " +
        result.right.head +
        "\nCommon base: " +
        result.mergeBase +
        "\nObserved: " +
        result.observedAt +
        "\n\n" +
        result.diffStat,
    ),
  );
  root.append(facts);
  return root;
}
export async function workspaceAction(button, { api, refresh, notice }) {
  const name = button.dataset.action;
  if (!name?.startsWith("workspace-")) return false;
  if (name === "workspace-node") {
    detailNode(button.dataset.id);
    return true;
  }
  if (name === "workspace-inspect") {
    const file = await api("workspace/inspect", { nodeId: button.dataset.id });
    const target = document.querySelector("#workspace-file-content");
    target.replaceChildren(
      el("p", file.authority, "fineprint"),
      el("pre", file.text),
    );
    return true;
  }
  if (name === "workspace-compare") {
    const leftId = document.querySelector("#compare-left").value,
      rightId = document.querySelector("#compare-right").value;
    if (!leftId || !rightId) throw new Error("Choose two worktrees");
    const result = await api("workspace/compare", { leftId, rightId });
    document
      .querySelector("#workspace-comparison")
      .replaceChildren(renderComparison(result));
    return true;
  }
  let route = {
    "workspace-sample": "workspace/sample",
    "workspace-refresh": "workspace/connect",
    "workspace-continue": "workspace/continue",
    "workspace-cancel": "workspace/cancel",
    "workspace-revoke": "workspace/revoke",
  }[name];
  if (!route) return true;
  if (graph?.fixture && name === "workspace-refresh")
    route = "workspace/sample";
  if (graph?.fixture && name === "workspace-continue")
    throw new Error("The synthetic catalog has no native pages to continue");
  if (name === "workspace-refresh" && !graph?.profile?.active)
    throw new Error("Connect a workspace scope first");
  const data = name === "workspace-refresh" ? graph.profile : {};
  await runInventory(route, data, { api, refresh, notice });
  return true;
}
async function runInventory(route, data, context) {
  const { api, refresh, notice } = context;
  if (polling) clearInterval(polling);
  polling = setInterval(async () => {
    try {
      const state = await api("state");
      const node = document.querySelector("#workspace-progress");
      if (node)
        node.textContent = state.workspace.running
          ? "Inventory: " + JSON.stringify(state.workspace.progress)
          : "Finishing derived view…";
    } catch {}
  }, 900);
  try {
    await api(route, data);
    graph = await api("workspace");
    notice(
      "Workspace view updated. Sources were read; no model ran and no repository was changed.",
    );
    await refresh();
  } finally {
    clearInterval(polling);
    polling = null;
  }
}
export async function workspaceSubmit(form, context) {
  const data = new FormData(form),
    hosts = data.getAll("hosts"),
    providers = data.getAll("providers"),
    roots = {},
    exclusions = {};
  for (const [name, target] of [
    ["roots", roots],
    ["exclusions", exclusions],
  ])
    for (const line of String(data.get(name) ?? "")
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean)) {
      const host = line.startsWith("remote|") ? "remote" : "local",
        path = line.replace(/^remote\|/, "");
      (target[host] ??= []).push(path);
    }
  await runInventory(
    "workspace/connect",
    {
      hosts,
      providers,
      account: data.get("account"),
      policy: data.get("policy"),
      indexFiles: data.get("indexFiles") === "on",
      roots,
      exclusions,
    },
    context,
  );
}
export async function workspaceHydrate(api) {
  graph = await api("workspace");
  renderGraph();
}
export function workspaceFilter(event) {
  if (event.target.id === "workspace-search") query = event.target.value;
  if (event.target.id === "workspace-kind") kind = event.target.value;
  renderGraph();
}
