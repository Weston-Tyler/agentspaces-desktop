# Adapter and dependency boundaries

| Surface                | Observed version / pin                   | Implemented boundary                                               | Live qualification                                                 |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Windows Codex          | 0.162.0-alpha.2                          | Version probe, read-only app-server stdio, native sign-in launcher | Version probe only; private catalog/read not run                   |
| remote Codex           | 0.161.0                                  | Version probe, read-only app-server over SSH, Linux paths          | Version probe; protocol fixtures, no private reads                 |
| Windows Claude Code    | 2.1.113                                  | Native MCP/sign-in entry point; SDK catalog/content adapter        | Version probe and SDK contract fixtures                            |
| remote Claude Code     | 2.1.283                                  | Existing SSH authentication; pinned SDK read helper                | Remote empty-fixture SDK read passed                               |
| Claude SDK             | 0.3.293                                  | listSessions, getSessionInfo, getSessionMessages only              | Read schemas inspected; no query/resume/mutation calls             |
| AgentSpaces core       | bb52d8a7b37458b147ee7660e0b8dbc43da4d392 | Upstream Java TCP/group/replicated-space runtime                   | Real loopback fixture fabric proof                                 |
| AgentSpaces TypeScript | be025e7aba72e1837e0ccb3999bb76098d012fe0 | Upstream Peer/Identity/signed entries/LEASE_RACE                   | Real Java/TypeScript loopback proof                                |
| MCP SDK                | 1.32.1                                   | Official stdio SDK, two scoped retrieval tools                     | SDK client/server fixture roundtrip                                |
| Electron               | 44.7.0                                   | Sandboxed local renderer, tray, single app instance                | Native Windows render captured; installation/release not qualified |

Version matches are admission checks plus fixture evidence, not blanket native feature parity. Review an exact update, inspect provider schemas, run bounded drift fixtures and then repeat the affected native acceptance check. No maintenance schedule is activated.

## Official references

- [Codex app-server](https://learn.chatgpt.com/docs/app-server): local read/resume/turn interfaces; this product exposes only read methods and treats the app-server boundary as experimental.
- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp): native connector configuration.
- [Sign in with ChatGPT](https://learn.chatgpt.com/docs/sign-in-with-chatgpt): sign-in alone is not conversation or memory access.
- [Claude session interfaces](https://code.claude.com/docs/en/agent-sdk/sessions): supported SDK enumeration and bounded message reading.
- [Claude authentication/compliance](https://code.claude.com/docs/en/legal-and-compliance): unmodified native sign-in and embedded-product credential boundaries.
- [Claude MCP](https://code.claude.com/docs/en/mcp): native connector configuration.
- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security): renderer isolation, sandbox and navigation restrictions.

The installed SDK declarations are the precise implementation schema used by this alpha. They were inspected because the large official TypeScript reference could not be fetched by the web reader. No private API, token scrape or provider transcript-file mutation is used.
