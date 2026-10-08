# Adapter and dependency boundaries

| Surface                | Observed version / pin                   | Implemented boundary                                               | Live qualification                                                                       |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Windows Codex          | 0.162.0-alpha.2                          | Version probe, read-only app-server stdio, native sign-in launcher | Version probe only; private catalog/read not run                                         |
| remote Codex           | 0.161.0                                  | Version probe, read-only app-server over SSH, Linux paths          | Version probe; protocol fixtures, no private reads                                       |
| Windows Claude Code    | 2.1.113                                  | Native MCP/sign-in entry point; SDK catalog/content adapter        | Version probe and SDK contract fixtures                                                  |
| remote Claude Code     | 2.1.283                                  | Existing SSH authentication; pinned SDK read helper                | Remote empty-fixture SDK read passed                                                     |
| Claude SDK             | 0.3.293                                  | listSessions, getSessionInfo, getSessionMessages only              | Read schemas inspected; no query/resume/mutation calls                                   |
| AgentSpaces core       | bb52d8a7b37458b147ee7660e0b8dbc43da4d392 | Upstream Java TCP/group/replicated-space runtime                   | Real loopback fixture fabric proof                                                       |
| AgentSpaces TypeScript | be025e7aba72e1837e0ccb3999bb76098d012fe0 | Upstream Peer/Identity/signed entries/LEASE_RACE                   | Real Java/TypeScript loopback proof                                                      |
| MCP SDK                | 1.32.1                                   | Official stdio SDK, seven scoped context/discussion tools          | SDK client/server retrieval, discussion discover/read/contribute and revocation fixtures |
| Electron               | 44.7.0                                   | Sandboxed local renderer, tray, single app instance                | Native Windows render captured; installation/release not qualified                       |
| Model-wire projection  | f55a89eb974cea30fdc295238a071239b462f1eb | Owning ConversationSnapshot/WireMessage namespace and field shape  | Shape fixtures only; Java/CBOR/distributed chat unqualified                              |
| Linux portable core    | remote Node 24                           | Native POSIX path rules, discussion persistence, router installer  | Eight isolated portable/installer tests; no Linux Electron shell                         |
| macOS                  | No observed native runtime               | Parameterized POSIX/local label contracts                          | Path-rule fixtures only; desktop, native versions and sign-in unqualified                |

The original native-tool rows above record the initial adapter proof boundary. Subsequent connected-work metadata evidence is revision-bound in the workspace-map guide and local handoff; it does not qualify automatic execution. This slice adds discussion fixtures, real scoped MCP transport and local/remote router installation. It does not claim Mac/Linux desktop parity.

Version matches are admission checks plus fixture evidence, not blanket native feature parity. Review an exact update, inspect provider schemas, run bounded drift fixtures and then repeat the affected native acceptance check. No maintenance schedule is activated.

## Bounded native E2E update, 2026-10-08

Fresh Codex exec questions were exercised through the Windows-hosted browser/API and remote native binary0.161: one general answer and one two-source cited answer. The two source findings were synthetic. A shared-daemon WebSocket adapter exercised three actual turns on two owned read-only native threads, including continuity on the original A UUID. ws8.22.0 is pinned for standard transport. The native queue proof does not qualify arbitrary existing thread permissions or wire broad broadcast into the UI. Local Codex0.162 availability/authentication/flags were checked without an extra live question. Claude API-mode process contracts pass, but local/remote API environment credentials are absent and live Claude answering was not tested. See native-questions.md and the exact local E2E handoff for snapshot recovery/unknown-usage boundaries.

## Official references

- [Codex app-server](https://learn.chatgpt.com/docs/app-server): local read/resume/turn interfaces; this product exposes only read methods and treats the app-server boundary as experimental.
- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp): native connector configuration.
- [Sign in with ChatGPT](https://learn.chatgpt.com/docs/sign-in-with-chatgpt): sign-in alone is not conversation or memory access.
- [Claude session interfaces](https://code.claude.com/docs/en/agent-sdk/sessions): supported SDK enumeration and bounded message reading.
- [Claude authentication/compliance](https://code.claude.com/docs/en/legal-and-compliance): unmodified native sign-in and embedded-product credential boundaries.
- [Claude MCP](https://code.claude.com/docs/en/mcp): native connector configuration.
- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security): renderer isolation, sandbox and navigation restrictions.

The installed SDK declarations are the precise implementation schema used by this alpha. They were inspected because the large official TypeScript reference could not be fetched by the web reader. No private API, token scrape or provider transcript-file mutation is used.
