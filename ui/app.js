import { nativeControls } from "./native-controls.js";
import { mountDiscussions } from "./discussions.js";
import { mountAsk } from "./ask.js";
import { mountNativeChat } from "./native-chat.js";
import {
  workspacePage,
  workspaceHydrate,
  workspaceAction,
  workspaceSubmit,
  workspaceFilter,
} from "./workspace.js";
let state,
  page =
    new URL(location.href).searchParams.get("view") === "advanced"
      ? "advanced"
      : new URL(location.href).searchParams.get("view") === "native" ? "native" : "discover",
  selected = null,
  filters = {
    query: "",
    provider: "all",
    status: "all",
    project: "all",
  };
const $ = (s) => document.querySelector(s),
  esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
const date = (s) =>
  new Date(s).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
async function api(path, data) {
  const response = await fetch(
    "/api/" + path,
    data === undefined
      ? {}
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-AgentSpaces": "local-companion",
          },
          body: JSON.stringify(data),
        },
  );
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "Request failed");
  return value;
}
function notice(message, error = false) {
  $("#notice").hidden = false;
  $("#notice").className = error ? "error" : "";
  $("#notice").textContent = message;
  if ($("#detail").open) {
    let inline = $("#dialog-notice");
    if (!inline) {
      inline = document.createElement("p");
      inline.id = "dialog-notice";
      inline.setAttribute("role", "status");
      $("#detail-content").prepend(inline);
    }
    inline.textContent = message;
    inline.className = "fineprint";
  }
}
async function refresh() {
  state = await api("state");
  render();
  scheduleDiscoveryPoll();
}
let discoveryPoll = null;
function scheduleDiscoveryPoll() {
  clearTimeout(discoveryPoll);
  if (!state.workspace?.running && state.desktopStartup?.status !== "discovering") return;
  discoveryPoll = setTimeout(async () => {
    try {
      state = await api("state");
      // Keep a running terminal intact while its source list updates.
      if (page === "native" && document.querySelector("#view .xterm"))
        window.dispatchEvent(new CustomEvent("agentspaces-catalog", { detail: state }));
      else render();
      scheduleDiscoveryPoll();
    } catch { notice("Local companion is reconnecting. Your saved threads remain on this device.", true); }
  }, 1500);
}
const titles = {
  native: ["Native chat", "Sign in with your native tools.", "Use Codex or Claude Code directly. Their native account, conversation and approval controls stay with them."],
  advanced: [
    "Ask",
    "Ask a question. Bring your work with you.",
    "Choose an answering service and include permitted findings, decisions and artifacts when they help.",
  ],
  discussions: [
    "Discussions",
    "Bring your threads into one conversation.",
    "Reference several native threads, mention participants, and follow their contributions together.",
  ],
  workspace: [
    "Connected work map",
    "See how your work connects.",
    "Find sessions, compare worktrees, and trace documents and work artifacts back to their sources.",
  ],
  discover: [
    "Your threads",
    "Your Codex and Claude threads.",
    "Browse your connected native threads by topic, tool or project.",
  ],
  activity: [
    "Activity",
    "A clear record of what happened.",
    "Inspect permission changes and attributable handoffs on this device.",
  ],
  permissions: [
    "Permissions",
    "You decide what can participate.",
    "Enrollment, content access, sharing and retrieval are separate grants.",
  ],
  usage: [
    "Usage",
    "Know when a model actually runs.",
    "Retrieval uses no inference. Recorded usage stays scoped to its original session.",
  ],
  settings: [
    "Setup & diagnostics",
    "Connect once. Keep your own workflow.",
    "Native tools keep their authentication, configuration, skills and approvals.",
  ],
};
function render() {
  $("#view").dataset.nativeChatMount = "";
  $("#view").dataset.askMount = "";
  $("#view").dataset.discussionMount = "";
  const t = titles[page];
  $("#crumb").textContent = t[0];
  $("#page-title").textContent = t[1];
  $("#page-description").textContent = t[2];
  document
    .querySelectorAll("[data-page]")
    .forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  $("#mode-pill").textContent =
    state.mode === "fixture"
      ? "Sample workspace · synthetic"
      : state.mode === "workspace-connected"
        ? "Connected work map"
        : state.mode === "native-read-only"
          ? "Native metadata · read only"
          : state.workspace?.running ? "Finding your local threads…" : "Your workspace";
  $("#mode-pill").className =
    "pill" + (state.mode === "fixture" ? " sample" : "");
  $("#sample").textContent =
    state.mode === "fixture"
      ? "Reload sample workspace"
      : "Open sample workspace";
  $("#sample").hidden = !state.demoAvailable;
  $("#footer-fabric").textContent =
    state.fabric.status === "connected"
      ? "Verified loopback fabric connection"
      : "Fabric disconnected";
  $("#sidebar-mode").textContent =
    state.mode === "fixture"
      ? "Synthetic sample workspace"
      : state.localOS + " alpha";
  $("#view").innerHTML = {
    native: () => "",
    advanced: () => "",
    discussions: () => "",
    workspace: () => "",
    discover: discovery,
    activity: activity,
    permissions: permissions,
    usage: usage,
    settings: settings,
  }[page]();
  if (page === "discover" && state.projects.length) {
    if (filters.project !== "all" && !state.projects.some((p) => p.id === filters.project))
      filters.project = "all";
    showResults();
  }
  if (page === "settings") nativeControls(state, { api, notice });
  if (page === "native") mountNativeChat($("#view"), state, { api, notice });
  if (page === "advanced")
    mountAsk($("#view"), { api, notice }).catch((error) =>
      notice(error.message, true),
    );
  if (page === "discussions")
    mountDiscussions($("#view"), state, { api, notice }).catch((error) =>
      notice(error.message, true),
    );
  if (page === "workspace") {
    $("#view").replaceChildren(workspacePage({ ...state.workspace, demoAvailable: state.demoAvailable }));
    workspaceHydrate(api).catch((error) => notice(error.message, true));
  }
  if (page === "workspace" && state.workspace.profile?.active) {
    $("#mode-pill").textContent = state.workspace.fixture
      ? "Synthetic work map"
      : "Read-only work map";
    $("#sidebar-mode").textContent = state.workspace.fixture
      ? "Synthetic Git worktrees"
      : "Derived source inventory";
  }
}
function stats() {
  const enrolled = state.sessions.filter((s) => s.grants.enrolled).length;
  return `<div class="stats"><div class="stat"><div class="stat-label">DISCOVERED SESSIONS</div><strong>${state.sessions.length}</strong><small>permitted metadata</small></div><div class="stat"><div class="stat-label">ENROLLED PARTICIPANTS</div><strong>${enrolled}</strong><small>explicitly opted in</small></div><div class="stat"><div class="stat-label">MODEL INVOCATIONS</div><strong>${state.modelCalls}</strong><small>by this companion</small></div></div>`;
}
function empty(title, text, button = "") {
  return `<div class="empty"><div class="empty-symbol">⌕</div><h2>${esc(title)}</h2><p>${esc(text)}</p>${button}</div>`;
}
function discovery() {
  const emptyLibrary = empty(
    state.workspace?.running ? "Finding your local threads…" : "Your thread library",
    state.workspace?.running ? "Codex and Claude thread discovery is running automatically." : "No native threads are available in the current connection. Check the installed tools and connection settings.",
    '<button class="secondary" data-page="settings">Connection settings</button>',
  );
  return `${stats()}<div class="panel"><div class="panel-title"><div><h2>Your session library</h2><p>Find by topic, native tool, project or session state.</p></div><span class="tag">Metadata first</span></div>${state.projects.length ? `<div class="searchbar"><input id="search" aria-label="Search permitted work" placeholder="Search research, decisions, artifacts…" value="${esc(filters.query)}"><select id="provider" aria-label="Tool"><option value="all">All native tools</option><option value="codex" ${filters.provider === "codex" ? "selected" : ""}>Codex</option><option value="claude" ${filters.provider === "claude" ? "selected" : ""}>Claude Code</option></select><select id="status" aria-label="Session state">${["all", "current", "dormant", "archived"].map((v) => `<option value="${v}" ${filters.status === v ? "selected" : ""}>${v === "all" ? "All session states" : v[0].toUpperCase() + v.slice(1)}</option>`).join("")}</select><select id="project" aria-label="Project"><option value="all" ${filters.project === "all" ? "selected" : ""}>All projects</option>${state.projects.map((p) => `<option value="${esc(p.id)}" ${filters.project === p.id ? "selected" : ""}>${esc(p.id)}</option>`).join("")}</select></div><div class="suggestions">Try a topic <button data-action="topic" data-value="retry">retry</button><button data-action="topic" data-value="artifact">artifact</button><span>Content stays locked until you allow it.</span></div><div id="results"></div>` : emptyLibrary}<div class="info-line">Archived and dormant work can be retrieved without waking a session. Discovery does not grant access to private content or authorize execution.</div></div>`;
}
let searchRevision = 0;
async function showResults() {
  const revision = ++searchRevision;
  try {
    const rows = await api("discover", filters);
    if (revision !== searchRevision || page !== "discover") return;
    $("#results").innerHTML = rows.length
      ? rows.map(row).join("")
      : empty(
          "No permitted metadata matches.",
          "Try another topic or project. Content remains private; unsupported sources are never searched.",
        );
  } catch (e) {
    if ($("#results"))
      $("#results").innerHTML = empty("Discovery unavailable", e.message);
  }
}
function row(s) {
  return `<div class="session-row"><div class="provider-mark ${s.provider === "claude" ? "claude" : ""}">${s.provider === "codex" ? "C" : "A"}</div><div class="row-text"><h3>${esc(s.title)}</h3><p>${s.provider === "codex" ? "Codex" : "Claude Code"} · ${esc(s.surface)} · ${esc(s.project)}</p><div class="row-meta"><span>${esc(date(s.updatedAt))}</span><span>${s.fixture ? "Synthetic fixture" : "Native metadata"}</span><span>${esc(s.topics.join(" · "))}</span></div></div><span class="tag ${esc(s.status)}">${esc(s.status)}</span><span class="tag permission">${s.grants.content ? "Content allowed" : "Content locked"}</span><button class="secondary" data-action="inspect" data-id="${esc(s.id)}">Inspect</button></div>`;
}
function activity() {
  return `<div class="panel"><div class="panel-title"><h2>Local activity</h2><span class="tag">${state.activity.length} recorded actions</span></div>${
    state.activity.length
      ? [...state.activity]
          .reverse()
          .map(
            (a) =>
              `<div class="audit-row"><div>${esc(a.action)}${a.fixture ? ' <span class="tag">fixture</span>' : ""}<div class="audit-detail">${esc(
                Object.entries(a)
                  .filter(([k]) => !["at", "action", "fixture"].includes(k))
                  .map(
                    ([k, v]) =>
                      `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`,
                  )
                  .join(" · "),
              )}</div></div><small>${esc(new Date(a.at).toLocaleString())}</small></div>`,
          )
          .join("")
      : empty(
          "No activity yet.",
          "Actions appear here when they actually happen. There are no background model runs or simulated status updates.",
        )
  }<div class="info-line">This is a bounded local audit view. AgentSpaces remains the authority for shared work and leased claims.</div></div>`;
}
function permissions() {
  return `<div class="card"><h2>Four deliberate permissions</h2><p>Project discovery exposes session metadata. Enrollment identifies a participant. Content access allows a bounded read. Sharing and retrieval allow a handoff within the same granted project and account.</p><p class="fineprint">Native execution is unavailable in this alpha. None of these permissions starts a model.</p></div><div class="panel"><div class="panel-title"><h2>Session grants</h2><span class="tag">Opt in individually</span></div>${state.sessions.length ? state.sessions.map(row).join("") : empty("No sessions discovered.", "Start in Setup, or open the sample workspace.")}<div class="info-line">Revoke enrollment to revoke its content, sharing, retrieval and connector access. Other account/project boundaries are denied.</div></div>`;
}
function usage() {
  const answers = state.answerUsage ?? {};
  return `${stats()}<div class="card"><h2>Native Ask usage</h2><p>Question receipts retain reported metrics once per request. Missing metrics remain unknown, and these totals do not establish provider billing.</p><div class="usage-values">${[
    ["requests", "Native requests"],
    ["completed", "Completed"],
    ["uncertain", "Uncertain"],
    ["unknownMetrics", "Unknown usage"],
    ["reportedInputTokens", "Reported input tokens"],
    ["reportedOutputTokens", "Reported output tokens"],
  ]
    .map(
      ([key, label]) =>
        `<div><strong>${answers[key] ?? 0}</strong><span>${label}</span></div>`,
    )
    .join(
      "",
    )}</div><p class="fineprint">${esc(answers.scope)}</p></div><div class="card"><h2>Recorded native-session usage</h2><p>Historical session usage records retain their original provider and turn attribution.</p><div class="usage-values">${[
    ["input", "Input tokens"],
    ["output", "Output tokens"],
    ["cachedInput", "Cached input"],
    ["tool", "Tool usage"],
    ["subagent", "Subagent usage"],
    ["records", "Usage records"],
  ]
    .map(
      ([key, label]) =>
        `<div><strong>${state.usage[key]}</strong><span>${label}</span></div>`,
    )
    .join(
      "",
    )}</div><p class="fineprint">${esc(state.usage.scope)}</p></div><div class="card"><h3>Retrieval and execution have different costs.</h3><p>Metadata search and finding retrieval invoke no model. This is observed companion behavior, not a measured claim about savings or provider billing.</p></div>`;
}
function settings() {
  return `<div class="two-col"><div><div class="card"><h2>Native tools</h2><p>Detected through their version commands. Account state and credentials have not been inspected.</p>${state.tools.map((t) => `<div class="tool-card"><div class="provider-mark ${t.provider === "claude" ? "claude" : ""}">${t.provider === "codex" ? "C" : "A"}</div><div><h3>${t.provider === "codex" ? "Codex" : "Claude Code"}</h3><small>${esc(t.installed ? t.version : "Not detected")}</small></div><span class="tag">${t.versionMatches ? "Version matched" : t.installed ? "Unqualified version" : "Unavailable"}</span></div>${t.installed ? `<p class="fineprint">Sign in using your unmodified native tool:</p><p><code>${esc(t.nativeSignInCommand)}</code></p>` : ""}`).join("")}<p class="fineprint">No credential collection. MCP configuration is provided for review; native configuration is never silently changed.</p></div><div class="card"><h2>Discover Codex metadata</h2><p>Explicitly authorize discovery for one local project and one account boundary. Uses the installed experimental app-server locally, with read-only methods. Conversation content stays locked.</p><form id="native-form"><label>Project label<input name="id" required placeholder="my-project"></label><label>Absolute project folder<input name="path" required placeholder="C:\\workspaces\\my-project"></label><label>Account boundary label<input name="account" required placeholder="personal or company-work"></label><label class="check-row"><input name="archived" type="checkbox">Discover archived metadata instead of current/dormant</label><button class="primary" type="submit">Authorize this metadata discovery</button></form><p class="fineprint">Reads up to 50 records. Claude Code history discovery needs a supported SDK adapter and is unavailable in this build.</p></div></div><div><div class="card"><h2>AgentSpaces fabric</h2><p>${esc(state.fabric.reason)}</p><div class="detail-meta"><b>Connection</b><span>${esc(state.fabric.status)}</span><b>Binding</b><span>${esc(state.fabric.binding.slice(0, 12))}</span><b>Scope</b><span>Literal loopback only</span></div><form id="fabric-form"><label>Loopback seed port<input name="port" type="number" min="1" max="65535" required placeholder="7500"></label><label>Self-certifying group ID<input name="groupId" required placeholder="Verified upstream group ID"></label><button class="secondary" type="submit">Connect local seed</button></form><button class="subtle" data-action="disconnect">Disconnect fabric</button><p class="fineprint">Uses the upstream peer and verified founding document. Sealed spaces, remote artifact exchange and native execution remain unqualified. Connection alone is not an end-to-end handoff proof.</p></div><div class="card"><h2>Development status</h2><p>Windows source alpha. Native tool detection is real; sample sessions are synthetic. The companion starts no model and edits no native histories.</p><p class="fineprint">Signed installers, updates, privacy review and additional operating systems are release gates.</p></div></div></div>`;
}
function detail(id) {
  selected = id;
  const s = state.sessions.find((s) => s.id === id);
  const g = s.grants;
  $("#detail-content").innerHTML =
    `<h2>${esc(s.title)}</h2><p>${s.fixture ? "Synthetic fixture. No private native history has been accessed." : "Native metadata. Content access requires a separate permission."}</p><div class="detail-meta"><b>Native tool</b><span>${s.provider === "codex" ? "Codex" : "Claude Code"}</span><b>Session state</b><span>${esc(s.status)}</span><b>Source ID</b><span>${esc(s.id)}</span><b>Account / project</b><span>${esc(s.account)} / ${esc(s.project)}</span><b>Source version</b><span>${esc(s.sourceVersion)}</span></div><h3>Session permissions</h3><div class="permission-grid">${[
      ["enrolled", "Enroll as a participant"],
      ["content", "Allow bounded content read"],
      ["share", "Share approved findings"],
      ["retrieve", "Retrieve others’ findings"],
    ]
      .map(
        ([key, label]) =>
          `<label class="check-row"><input type="checkbox" data-grant="${key}" ${g[key] ? "checked" : ""} ${key !== "enrolled" && !g.enrolled ? "disabled" : ""}>${label}</label>`,
      )
      .join(
        "",
      )}</div><div class="actions"><button class="secondary" data-action="read" data-id="${esc(id)}" ${g.content ? "" : "disabled"}>Inspect finding & artifact</button><button class="secondary" data-action="connector" data-id="${esc(id)}" ${g.retrieve ? "" : "disabled"}>Create scoped MCP connector</button></div><p class="fineprint">Retrieved material is untrusted data. Archived knowledge can be used without waking its native session.</p><div id="finding-result"></div>`;
  if (!$("#detail").open) $("#detail").showModal();
}
function findingResult(f) {
  $("#finding-result").innerHTML =
    `<div class="finding"><span class="eyebrow">${f.handoff ? "PERMITTED HANDOFF" : "BOUNDED SOURCE READ"}</span><h3>${esc(f.title)}</h3><p>${esc(f.summary)}</p><div class="detail-meta"><b>Origin</b><span>${esc(f.source.provider)} / ${esc(f.source.threadId)}</span><b>Version</b><span>${esc(f.source.version)}</span><b>Artifact</b><span>${esc(f.artifact.name)} · ${f.artifact.bytes} bytes</span><b>SHA-256</b><span>${esc(f.artifact.digest)}</span>${f.handoff ? `<b>Handoff</b><span>${esc(f.handoff.relation)} · ${esc(f.handoff.coordination)}</span><b>Model calls</b><span>0</span>` : ""}</div><pre>${esc(f.artifact.text)}</pre><div class="actions"><select id="requester" aria-label="Retrieval destination"><option value="">Choose an enrolled requester</option>${state.sessions
      .filter(
        (s) => s.id !== selected && s.grants.enrolled && s.grants.retrieve,
      )
      .map(
        (s) =>
          `<option value="${esc(s.id)}">${esc(s.title)} · ${esc(s.provider)}</option>`,
      )
      .join(
        "",
      )}</select><button class="primary" data-action="retrieve" data-id="${esc(selected)}">Retrieve to session</button></div><p class="fineprint">${f.fixture ? "This finding and its origin are explicitly synthetic." : "Source captured under an explicit content grant."} Execution stays disabled.</p></div>`;
}
document.addEventListener("click", async (event) => {
  const b = event.target.closest("button");
  if (!b) return;
  try {
    if (b.dataset.page) {
      page = b.dataset.page;
      await refresh();
      return;
    }
    const a = b.dataset.action;
    if (await workspaceAction(b, { api, refresh, notice })) return;
    if (b.id === "sample" || a === "sample") {
      await api("sample", {});
      notice(
        "Synthetic sample loaded. Enroll a requester and grant source content/sharing to try a handoff.",
      );
      await refresh();
    }
    if (a === "topic") {
      filters.query = b.dataset.value;
      $("#search").value = filters.query;
      await showResults();
    }
    if (a === "inspect") detail(b.dataset.id);
    if (a === "read") {
      const f = await api("finding", { id: b.dataset.id });
      findingResult(f);
      if (f.fixture && state.fabric.status === "connected") {
        const publishButton = document.createElement("button");
        publishButton.className = "secondary";
        publishButton.textContent = "Publish sample to loopback group";
        publishButton.dataset.action = "publish";
        publishButton.dataset.id = b.dataset.id;
        $("#finding-result").append(publishButton);
      }
    }
    if (a === "publish") {
      await api("publish", { id: b.dataset.id });
      notice(
        "Sample emitted through the real upstream fabric. Retrieval will reconcile its signed entry; source content is synthetic.",
      );
    }
    if (a === "retrieve") {
      const requesterId = $("#requester").value;
      if (!requesterId)
        throw new Error(
          "Choose a requester with enrollment and retrieval permission.",
        );
      const f = await api("retrieve", { sourceId: b.dataset.id, requesterId });
      state = await api("state");
      findingResult(f);
      notice(
        `Retrieved ${f.handoff.relation} finding with provenance. Model calls: 0.`,
      );
    }
    if (a === "connector") {
      const c = await api("connector", { id: b.dataset.id });
      $("#finding-result").innerHTML =
        `<div class="finding"><h3>Scoped MCP connector</h3><p>Use these application credentials only for the selected participant. This is not a provider session token. Keep the value private and out of Git.</p><pre>${esc(JSON.stringify({ command: "node", args: ["ABSOLUTE_PATH_TO_REPO/app/mcp.mjs"], env: { AGENTSPACES_URL: location.origin, AGENTSPACES_CONNECTOR_TOKEN: c.token } }, null, 2))}</pre><p class="fineprint">Review and install through native MCP configuration. Per-native-thread binding across surfaces needs qualification; this connector binds to the explicitly selected participant.</p></div>`;
    }
    if (a === "disconnect") {
      await api("fabric/disconnect", {});
      await refresh();
    }
    if (a === "probe-remote") {
      await api("native/probe", { host: "remote" });
      notice(
        "Native versions detected on remote over existing SSH. No session metadata or content was accessed.",
      );
      await refresh();
    }
    if (b.id === "close-detail") $("#detail").close();
  } catch (e) {
    notice(e.message, true);
  }
});
document.addEventListener("change", async (e) => {
  if (e.target.id === "workspace-kind") {
    workspaceFilter(e);
    return;
  }
  try {
    if (e.target.dataset.grant) {
      await api("grant", {
        id: selected,
        changes: { [e.target.dataset.grant]: e.target.checked },
      });
      state = await api("state");
      render();
      detail(selected);
    }
    if (["provider", "status", "project"].includes(e.target.id)) {
      filters[e.target.id] = e.target.value;
      await showResults();
    }
  } catch (error) {
    notice(error.message, true);
    state = await api("state");
    detail(selected);
  }
});
let debounce;
document.addEventListener("input", (e) => {
  if (e.target.id === "workspace-search") {
    workspaceFilter(e);
    return;
  }
  if (e.target.id === "search") {
    filters.query = e.target.value;
    clearTimeout(debounce);
    debounce = setTimeout(showResults, 160);
  }
});
document.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const fields = Object.fromEntries(new FormData(form));
  try {
    if (form.id === "workspace-scope-form") {
      await workspaceSubmit(form, { api, refresh, notice });
      return;
    }
    if (form.id === "native-form") {
      await api("native/discover", {
        ...fields,
        archived: fields.archived === "on",
      });
      filters.project = fields.id;
      notice(
        "Granted native project metadata discovered. Content remains locked.",
      );
      await refresh();
    }
    if (form.id === "fabric-form") {
      await api("fabric/connect", {
        host: "127.0.0.1",
        port: Number(fields.port),
        groupId: fields.groupId,
        project: "sample-research",
      });
      notice(
        "Verified sample-project loopback group founding document. Native content publication remains gated.",
      );
      await refresh();
    }
  } catch (e) {
    notice(e.message, true);
  }
});
refresh().catch((e) => notice(e.message, true));
