const el = (tag, text, cls) => {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (cls) element.className = cls;
  return element;
};
const field = (text, input) => {
  const label = el("label", text);
  input.setAttribute("aria-label", text);
  label.append(input);
  return label;
};
const select = (options) => {
  const input = el("select");
  for (const [value, text] of options) {
    const option = el("option", text); option.value = value; input.append(option);
  }
  return input;
};
// Only provider-owned interactive native UI handles model authentication and
// approvals. This view never captures terminal output into an application log.
export function mountNativeChat(root, state, { api, notice }) {
  const mountId = crypto.randomUUID();
  root.dataset.nativeChatMount = mountId;
  const card = el("section", null, "card native-chat"),
    provider = select([["codex", "Codex"], ["claude", "Claude Code"]]),
    host = select([["local", "This device"], ["remote", "remote / Linux over SSH"]]),
    cwd = el("input"),
    source = select([["", "Choose a discovered source thread"]]),
    status = el("p", "Choose a tool and folder to open its native chat.", "fineprint"),
    reference = el("div", null, "native-reference"),
    channelStatus = el("div", null, "fineprint"),
    terminalElement = el("div", null, "native-terminal"),
    actions = el("div", null, "actions");
  cwd.placeholder = state.localOS === "Windows" ? "C:\\workspaces\\project" : "/home/you/project";
  cwd.required = false;
  terminalElement.setAttribute("aria-label", "Native provider terminal");
  terminalElement.style.minHeight = "400px";
  for (const s of state.sessions ?? []) {
    if (s.fixture) continue;
    const option = el("option", s.title + " · " + s.provider + " · " + (s.host ?? "local"));
    option.value = s.id; source.append(option);
  }
  let terminal = null, socket = null, fit = null, terminalId = null,
    connectionId = null, busy = false, disposed = false;
  const ownerAvailable = el("input"); ownerAvailable.type = "checkbox";
  const ownerLabel = field("I closed other native controllers before opening this selected thread", ownerAvailable); ownerLabel.hidden = true;
  const buttons = [];
  const run = (fn) => async () => {
    if (busy || disposed) return;
    busy = true; buttons.forEach((b) => { b.disabled = true; });
    try { await fn(); }
    catch (error) { notice(error.message, true); status.textContent = error.message; }
    finally { busy = false; if (!disposed) buttons.forEach((b) => { b.disabled = false; }); }
  };
  const button = (text, fn, cls = "secondary") => {
    const b = el("button", text, cls); b.type = "button"; b.onclick = run(fn); buttons.push(b); return b;
  };
  async function closeTerminal() {
    const id = terminalId; terminalId = null;
    socket?.close(); socket = null;
    terminal?.dispose(); terminal = null; fit = null;
    terminalElement.replaceChildren();
    if (id) await api("native/terminal/close", { id });
  }
  async function openTerminal(intent, prepared = false) {
    if (prepared && !ownerAvailable.checked) throw new Error("Close other native controllers and confirm before resuming the selected thread");
    if (!globalThis.Terminal || !globalThis.FitAddon?.FitAddon)
      throw new Error("Native terminal assets are unavailable; reload the companion");
    await closeTerminal();
    const value = await api("native/terminal/open", {
      provider: prepared ? "claude" : provider.value, host: host.value,
      ...(cwd.value.trim() ? { cwd: cwd.value.trim() } : {}), intent,
      ...(prepared ? { connectionId, ownerConfirmedAvailable: true } : {}),
    });
    if (disposed) { await api("native/terminal/close", { id: value.id }); return; }
    terminalId = value.id;
    terminal = new globalThis.Terminal({ convertEol: false, scrollback: 1000, fontSize: 14 });
    fit = new globalThis.FitAddon.FitAddon(); terminal.loadAddon(fit);
    // xterm creates its scoped style elements synchronously during open. Give
    // those elements the response nonce without allowing arbitrary inline CSS.
    const createElement = document.createElement, nonce = document.querySelector('meta[name="terminal-style-nonce"]')?.content;
    document.createElement = function(tag, ...args) {
      const element = createElement.call(this, tag, ...args);
      if (String(tag).toLowerCase() === "style" && nonce) element.nonce = nonce;
      return element;
    };
    try { terminal.open(terminalElement); fit.fit(); }
    finally { document.createElement = createElement; }
    const url = new URL("/api/native/terminal/" + encodeURIComponent(value.id), location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(url);
    const currentId = value.id, currentSocket = socket, currentTerminal = terminal;
    const send = (value) => { if (terminalId === currentId && currentSocket.readyState === WebSocket.OPEN) currentSocket.send(JSON.stringify(value)); };
    terminal.onData((data) => send({ type: "input", data }));
    terminal.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
    socket.onopen = () => {
      if (terminalId !== currentId) return;
      status.textContent = value.provider + " native chat on " + value.host + ". Sign-in and approvals belong to the native tool.";
      send({ type: "resize", cols: terminal.cols, rows: terminal.rows }); terminal.focus();
    };
    socket.onmessage = (event) => {
      if (terminalId !== currentId) return;
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === "output" && typeof message.data === "string") currentTerminal.write(message.data);
      if (message.type === "exit") status.textContent = "Native process exited (" + message.exitCode + ").";
    };
    socket.onerror = () => { if (terminalId === currentId) status.textContent = "Native terminal connection failed. Close it before opening another."; };
    socket.onclose = () => { if (terminalId === currentId) status.textContent = "Native terminal disconnected; close it before opening another."; };
  }
  source.onchange = () => {
    connectionId = null; ownerAvailable.checked = false; ownerLabel.hidden = true; channelStatus.replaceChildren(); reference.replaceChildren();
    const s = state.sessions.find((s) => s.id === source.value);
    if (!s) return;
    provider.value = s.provider; host.value = s.host ?? "local";
    cwd.value = s.cwd ?? "";
    reference.append(el("p", s.title), el("p", "Source " + (s.nativeThreadId ?? s.id) + " · " + (s.host ?? "local"), "fineprint"), el("p", "This is a reference. Opening chat starts native interaction without automatically resuming this source. Connector attribution is locally bound; native source identity remains self-reported.", "fineprint"));
  };
  const updateCatalog = event => {
    state.sessions = event.detail.sessions;
    const selected = source.value;
    source.replaceChildren();
    const placeholder = el("option", "Choose a discovered source thread"); placeholder.value = ""; source.append(placeholder);
    for (const s of state.sessions ?? []) {
      if (s.fixture) continue;
      const option = el("option", s.title + " · " + s.provider + " · " + (s.host ?? "local"));
      option.value = s.id; source.append(option);
    }
    source.value = selected;
  };
  window.addEventListener("agentspaces-catalog", updateCatalog);
  const channelButton = button("Connect selected Claude thread via channel", async () => {
    const s = state.sessions.find((s) => s.id === source.value);
    if (!s || s.provider !== "claude") throw new Error("Select a discovered Claude Code thread first");
    const result = await api("native/channel/prepare", { sessionId: s.id });
    connectionId = result.connectionId ?? result.id;
    host.value = result.host; provider.value = "claude";
    cwd.value = result.cwd ?? s.cwd ?? "";
    channelStatus.replaceChildren(el("p", "Prepared channel " + (result.channelName ?? "AgentSpaces") + " on " + result.host), el("p", "Configuration: " + result.configPath), el("p", typeof (result.publicInstructions ?? result.instructions) === "string" ? (result.publicInstructions ?? result.instructions) : "The native tool will request channel confirmation. Confirm it there to connect. Existing source identity is self-reported; the companion does not resume it automatically."));
    if (!connectionId) throw new Error("Channel preparation did not return a connection identifier");
    ownerLabel.hidden = false; ownerAvailable.checked = false;
  });
  for (const input of [provider, host, cwd]) input.addEventListener("change", () => {
    connectionId = null; ownerAvailable.checked = false; ownerLabel.hidden = true;
    channelStatus.replaceChildren();
  });
  const preparedButton = button("Open Claude with prepared channel", async () => {
    if (!connectionId) throw new Error("Prepare the selected thread’s channel first");
    await openTerminal("chat", true);
  });
  actions.append(button("Open native chat", () => openTerminal("chat"), "primary"), button("Sign in with native tool", () => openTerminal("login")), button("Close native terminal", closeTerminal));
  card.append(el("h2", "Chat with your native tools"), el("p", "Use your existing Codex or Claude Code login. The native tool handles account sign-in, model choices and permission prompts."), field("Native tool", provider), field("Host", host), field("Native project folder (optional)", cwd), actions, status, field("Existing source reference", source), reference, channelButton, ownerLabel, preparedButton, channelStatus, terminalElement);
  root.replaceChildren(card);
  const resize = new ResizeObserver(() => { if (terminal && terminalElement.isConnected) fit?.fit(); });
  resize.observe(terminalElement);
  const observer = new MutationObserver(() => {
    if (!root.isConnected || root.dataset.nativeChatMount !== mountId || !card.isConnected) dispose();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  function dispose() {
    if (disposed) return;
    disposed = true; observer.disconnect(); resize.disconnect();
    window.removeEventListener("agentspaces-catalog", updateCatalog);
    closeTerminal().catch(() => {});
  }
  return dispose;
}
