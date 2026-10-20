# Adapter and dependency boundaries

The native version observations below are historical evidence, not claims about
current installations. The AgentSpaces rows were requalified on 2026-10-20 for
the source upgrade; installer/deployment acceptance remains separate. See
[upstream v3](upstream-v3.md) for upgrade sequencing and limitations.

| Surface                | Observed version / pin                   | Implemented boundary                                               | Live qualification                                                                       |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Windows Codex          | 0.162.0-alpha.2                          | Version probe, read-only app-server stdio, native sign-in launcher | Version probe only; private catalog/read not run                                         |
| remote Codex           | CLI 0.162.0; daemon 0.161.0 observed       | Bounded schema compatibility checks, original source metadata and MCP retrieval | Compatible contracts and metadata injection observed without inference; existing-thread model replies remain separately qualified |
| Windows Claude Code    | 2.1.113                                  | Native MCP/sign-in entry point; SDK catalog/content adapter        | Version probe and SDK contract fixtures                                                  |
| remote Claude Code     | 2.1.283                                  | Existing SSH authentication; pinned SDK read helper                | Remote empty-fixture SDK read passed                                                     |
| Claude SDK             | 0.3.293                                  | listSessions, getSessionInfo, getSessionMessages only              | Read schemas inspected; no query/resume/mutation calls                                   |
| AgentSpaces core       | b43a02291852cafb4b45671b1df422f707ef73e2 | Upstream Java 21 wire-v3 TCP/group/replicated-space runtime                   | Java-v3 / TypeScript-v3 loopback signed entry, discovery, claim and completion proof                                                       |
| AgentSpaces TypeScript | fa20e215a002a7085f9f8f526be1af6bb8b82304 | Upstream wire-v3 Peer/Identity/signed discovery/targeted claims/Space events                   | Pinned Java loopback proof, synthetic v2 state migration and mixed-version refusal contracts                                                      |
| MCP SDK                | 1.32.1                                   | Official stdio SDK, scoped context/discussion/work/decision and coordination tools          | SDK client/server retrieval, discussion discover/read/contribute and revocation fixtures |
| Electron               | 44.7.0                                   | Sandboxed local renderer, tray, single app instance                | Native Windows render captured; installation/release not qualified                       |
| Model-wire projection | Conversation shape baseline `f55a89eb974cea30fdc295238a071239b462f1eb`; usage contract `8546c3c4ca3dd323d5b29a296db8b406aa13b752` | Owning ConversationSnapshot/WireMessage namespace and optional ModelUsageTotal observation | Shape and signed usage fixtures; no distributed native chat or provider billing qualification |
| Linux portable core    | remote Node 24                           | Native POSIX path rules, discussion persistence, router installer  | Eight isolated portable/installer tests; no Linux Electron shell                         |
| macOS                  | No observed native runtime               | Parameterized POSIX/local label contracts                          | Path-rule fixtures only; desktop, native versions and sign-in unqualified                |

The original native-tool rows above record the initial adapter proof boundary. Subsequent connected-work metadata evidence is revision-bound in the workspace-map guide and local handoff; it does not qualify automatic execution. Subsequent source work adds work-board, decision, queue and bounded observation interfaces; their receipts and deployment boundaries remain separate. It does not claim Mac/Linux desktop parity.

Version matches are admission checks plus fixture evidence, not blanket native feature parity. Review an exact update, inspect provider schemas, run bounded drift fixtures and then repeat the affected native acceptance check. No maintenance schedule is activated.

## Bounded native E2E update, 2026-10-08

Fresh Codex exec questions were exercised through the Windows-hosted browser/API and remote native binary0.161: one general answer and one two-source cited answer. The two source findings were synthetic. A shared-daemon WebSocket adapter exercised three actual turns on two owned read-only native threads, including continuity on the original A UUID. ws8.22.0 is pinned for standard transport. The native queue proof does not qualify arbitrary existing thread permissions or wire broad broadcast into the UI. Local Codex0.162 availability/authentication/flags were checked without an extra live question. Claude API-mode process contracts pass, but local/remote API environment credentials are absent and live Claude answering was not tested. See native-questions.md and the exact local E2E handoff for snapshot recovery/unknown-usage boundaries.

## Wire-v3 / 0.4.0 source qualification, 2026-10-20

The TypeScript dependency is pinned by commit and reports `0.4.0` while retaining
wire v3. The previous Desktop pin also spoke v3. Node-only key loading,
TCP registration and the owning Node crypto port are now selected explicitly;
CBOR comparisons accept portable `Uint8Array` bytes. A v2 seed and v3 client
reject one another's frames. Upgrade configured peers as an explicitly qualified
tuple. Snapshot-schema compatibility is a separate check from network compatibility.

The source integration reuses signed AgentCards, current socket health, upstream
robustness counters and Space activity. Optional usage/advisory spaces and local
semantic ranking require explicit fixture-project loopback configuration. Options
are runtime-only and reset on disconnect/restart; no native metadata is exported.
Native identity, permissions and wake readiness remain separate from peer cards.

The board remains a single companion-owned replica, not multi-companion federation.
Known upstream limitations include effective-lease expiry events and an inert,
unref'd Space sweep timer after subscriptions close. Activity is bounded observation,
not complete history. Active aggregate exchange and bundled JVM frameworks are not
included. See [ecosystem reuse](ecosystem-reuse.md), [upstream v3](upstream-v3.md) and
[0.4.0 transport qualification](upstream-040.md).

## Official references

- [Codex app-server](https://learn.chatgpt.com/docs/app-server): local read/resume/turn interfaces; metadata reads and explicitly authorized native delivery use separate adapters and version checks. The app-server boundary remains experimental.
- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp): native connector configuration.
- [Sign in with ChatGPT](https://learn.chatgpt.com/docs/sign-in-with-chatgpt): sign-in alone is not conversation or memory access.
- [Claude session interfaces](https://code.claude.com/docs/en/agent-sdk/sessions): supported SDK enumeration and bounded message reading.
- [Claude authentication/compliance](https://code.claude.com/docs/en/legal-and-compliance): unmodified native sign-in and embedded-product credential boundaries.
- [Claude MCP](https://code.claude.com/docs/en/mcp): native connector configuration.
- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security): renderer isolation, sandbox and navigation restrictions.

The installed SDK declarations are the precise implementation schema used by this alpha. They were inspected because the large official TypeScript reference could not be fetched by the web reader. No private API, token scrape or provider transcript-file mutation is used.
