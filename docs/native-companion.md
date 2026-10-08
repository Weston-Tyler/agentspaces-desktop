# Native companion

The desktop opens on Your threads and restores its saved metadata connection. On first use it discovers the local Codex and Claude catalogs automatically, without reading transcripts or waiting for filesystem/Git inventory. Existing exclusions and revoked scopes remain authoritative. Repository/worktree/file inventory is available separately through Connected work. Normal runtimes cannot be replaced with sample data; demos require a separate explicit runtime.

Install Node 24+, the locked application dependencies and the actual Codex or Claude Code CLI. Open Native chat to use the tool on this device or remote, optionally choose a project folder, and use its native sign-in, model selection and permission prompts. Existing native authentication stays with the provider. AgentSpaces launches the unmodified interactive CLI in an embedded terminal and does not copy provider tokens, collect passwords or automatically answer approvals.

The terminal uses product-owned node-pty and xterm. A separate Node worker loads the native addon, including when the parent is Electron. Three active terminals are allowed. Closing the terminal, navigating away or losing its browser connection stops the owned process. Output is bounded in memory and is not saved to the application audit or transcript. Native tools may retain their own ordinary conversation history. If Node is unavailable in the Electron launch environment, set AGENTSPACES_NODE_BINARY to its executable path.

## Connect a Claude discussion participant

Discover and explicitly grant a Claude source enrollment, content, sharing and retrieval. Select it under Existing source reference, then prepare its channel. Preparation creates an owner-private MCP configuration with a scoped AgentSpaces capability, not a provider token. It preserves global native configuration. Remote preparation installs pinned MCP transport dependencies in the managed account directory and uses a loopback SSH reverse forward.

Close other controllers for that thread, check the availability confirmation and open Claude with the prepared channel. This action visibly resumes that exact source UUID. Confirm the development channel in Claude itself. The preview launch uses --dangerously-load-development-channels server:agentspaces as documented by Claude; it does not relay permissions or bypass organization channel controls. Known active sources are refused; unknown activity still requires the native owner to confirm availability.

In Discussions, mention the connected participant or select it as a target. A connected channel receives the message in its running native session and can use its reply tool to contribute to the same group. Delivery means the message reached the channel transport; it does not prove model acceptance or a completed reply. Replies retain source, message ancestry and an explicitly self-reported native turn. Grants are checked on each delivery and contribution. Duplicate or uncertain delivery is not automatically replayed. No dormant-thread broadcast or automatic model polling is enabled.

Codex supports interactive native chat here and existing scoped MCP contribution tools. This release does not implement a Codex push-channel equivalent. A native login alone does not establish access to every account chat, host or repository. Connector source attribution is locally bound; independent verification of the native caller identity remains unqualified.

## Qualification

Automated fixtures exercise owner-authenticated terminal WebSockets, input/output/resize/cleanup and a real MCP stdio/HTTP/WebSocket roundtrip from a targeted discussion through the Claude bridge and back to the group, both directly and through a different-port TCP alias. Synthetic terminal and channel actors invoke no models. Product-owned PTY smoke runs exercise Windows and remote SSH terminals. Both installed native binaries render --help and exit cleanly through that terminal on both hosts. The browser renders the terminal and routes synthetic typing. Actual managed remote dependency installation, loopback reverse forwarding and scoped MCP discovery also passed with a synthetic participant. A live Claude preview consent and model reply have not been exercised. Earlier bounded Codex answer proofs belong to the separate Advanced path.

Windows is the observed desktop platform; remote Linux is the exercised remote terminal target. macOS and Linux Electron desktop packaging, native login rendering and full parity have not been qualified. There is no signed installer, published package or public release in this change.

Native provider authentication and channels remain subject to their own product requirements: [Claude native integration terms](https://code.claude.com/docs/en/legal-and-compliance), [Claude channels](https://code.claude.com/docs/en/channels) and [channel protocol](https://code.claude.com/docs/en/channels-reference). Open-source distribution does not change those requirements.
