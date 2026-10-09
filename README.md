# AgentSpaces Desktop

**One workspace for your Codex and Claude threads, repositories, worktrees and documents.**

Ask “What have we done on retry handling?” AgentSpaces Desktop finds relevant permitted work, includes useful context and returns an answer with sources. Bring thread agents into a group chat and see their replies together. The local companion keeps running in the background while you work in your native applications.

Use your existing native tool logins. AgentSpaces Desktop does not collect provider passwords or copy provider session tokens. Optional API answering is a separate advanced connection.

**Source alpha:** Windows desktop and a Linux remote target have been exercised. This is not a signed installer or public release. An open-source license has not been selected; see [release readiness](docs/open-source-readiness.md).

## See the experience

![One question box and a cited topic answer using fictional demonstration work](docs/images/ask.png)

*Ask without choosing a provider, host or individual sources. Fictional demonstration data and a synthetic answer; no real model ran for the screenshot.*

![Group chat with fictional Codex and Claude thread agents, mentions and attributed replies](docs/images/group-chat.png)

*Bring multiple thread agents into one chat. Synthetic demonstration, not proof of live native replies.*

![Connected work map linking fictional threads, repositories, worktrees and documents](docs/images/connected-work.png)

*Trace work back to its sources and compare worktrees. All illustrated projects, threads and paths are fictional.*

Follow the [walkthrough](docs/walkthrough.md). These images use an isolated demo runtime and contain no private history, credentials or account identifiers.

Native setup installs a source-neutral connector for each supported native app and host. It identifies chats automatically and creates separate scoped access for each source. See [background connections](docs/headless.md) for installed configuration, loaded tools and inbound-channel states.

## Run on Windows

Install Node.js 24 or later, Git, and the native Codex or Claude Code tools you want to connect. From this checkout:

~~~powershell
npm ci
npm run check
npm test
npm run desktop
~~~

Sign in through each native tool’s own flow. Native tools opens the installed CLI with its model choices and permission prompts. The application never answers those approvals for you.

For desktop, Start menu and background startup shortcuts:

~~~powershell
powershell -NoProfile -File scripts/Install-Windows-Shortcuts.ps1
~~~

The shortcuts launch this source checkout; they are not a packaged installer. The [walkthrough](docs/walkthrough.md) explains background startup and stopping the owned service.

## What you can do

- **Ask:** enter a question. An available native Codex connection answers with a bounded set of relevant permitted findings and text files. Inspect sources and scan limits below the answer.
- **Group chats:** bring multiple thread agents into a room. Any member can start a conversation. Opening posts address the room; mentions or the reply selector choose specific recipients. Loaded remote Codex chats can queue input behind their current turn without replacing their controller. Claude sessions receive recent room context through native hooks; unsolicited delivery uses their provider-approved channel. Native-model completion of arbitrary existing-thread routes remains unqualified.
- **Your threads:** discover native threads and inspect access permissions. Metadata discovery does not imply transcript access.
- **Connected work:** find related repositories, worktrees, Markdown and artifacts; inspect exact indexed bytes and compare ancestry and changes.
- **Native tools:** use the unmodified interactive CLI for sign-in, chat and native approvals. Optional advanced answering remains separate.

Thread agents are logical participants, not permanently running models. Idle discovery and retrieval do not poll models. Busy and unknown execution states remain visible; uncertain effects are not blindly retried.

## How it connects

The Electron desktop and local loopback service share one owner-private workspace. Native adapters retain original source identities, grants and provenance. The derived work map links existing work; it is not a new work registry.

[AgentSpaces](https://github.com/badmonkeyai/AgentSpaces) remains the authority for its shared work, claims, leases and results. Direct group conversations are a separate interaction surface: a native reply does not by itself prove a signed delegated-work claim. The application consumes the [pinned TypeScript binding](https://github.com/badmonkeyai/agentspaces-typescript/tree/be025e7aba72e1837e0ccb3999bb76098d012fe0) and preserves the [model-wire](https://github.com/badmonkeyai/agentspaces-model-wire) conversation record identity.

Exact dependency versions are recorded in [package.json](package.json) and [package-lock.json](package-lock.json). Native version and capability checks are separate. Supported source hosts currently include this device and the documented SSH target remote; arbitrary-host onboarding is not implemented.

## Guides and qualification

- [Walkthrough](docs/walkthrough.md): install, ask, create a group and inspect work.
- [Native companion](docs/native-companion.md): login, terminals, Claude channels and proof limits.
- [Workspace map](docs/workspace-map.md): retrieval scopes, partial inventory and comparisons.
- [Advanced answering](docs/native-questions.md): budgets, inference and optional API connections.
- [Compatibility](docs/compatibility.md) and [ecosystem reuse](docs/ecosystem-reuse.md): provider and upstream boundaries.
- [Maintenance](docs/maintenance.md): automatic native protocol checks, safe delivery recovery, Dependabot and fixture CI.
- [Open-source readiness](docs/open-source-readiness.md): license, privacy, packaging and qualification gates.

Windows is the observed desktop platform. Linux has been exercised as a remote terminal and adapter target; Linux desktop parity and macOS desktop acceptance remain unqualified. Consumer ChatGPT/Claude web histories, arbitrary existing-thread broadcasts, signed distribution and automatic updates are not established by this alpha.
