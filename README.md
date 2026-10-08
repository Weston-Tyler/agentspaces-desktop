# AgentSpaces Desktop

AgentSpaces Desktop is a planned local application that connects work across native AI tools. Users keep working in their existing applications while approved threads share findings, reference artifacts, and request bounded follow-up work through AgentSpaces.

Status: local Windows source alpha. The repository now has an executable Electron companion, a loopback background service, permissioned session discovery/retrieval, read-only Codex/Claude adapters, scoped MCP tools, and bounded tests. A real upstream Java/TypeScript fabric proof uses synthetic native session/execution payloads. No private histories or model execution were enrolled during this build; there is no signed installer or released distribution.

## Run the source alpha

Requires Node 24+. In this checkout, run npm ci, npm run check, and npm test. Then npm run desktop opens the native companion; npm start opens the standalone loopback preview on port 43127. Closing the native window hides it to its tray; tray Quit stops its owned runtime.

Start in an empty workspace or explicitly open the synthetic sample. Same-tool rediscovery is as important as cross-tool handoff. Setup supports explicit project/tool/host discovery, including Linux remote over an existing SSH connection and this Windows/local workstation device. Metadata, content access, sharing/retrieval and execution remain distinct grants.

Read [the alpha guide](docs/alpha-guide.md), [the product brief](docs/product-brief.md), and [compatibility boundaries](docs/compatibility.md) before connecting native sessions. Account boundary labels are user-configured scopes, not verified provider account identity. Native inference remains unavailable.

## Intended experience

1. Download the application and detect supported local tools.
2. Connect the tools through their supported integration surfaces. When sign-in is needed, open the provider's native authentication flow rather than collect or copy its session credentials.
3. Select projects and threads that may participate, with explicit sharing and execution permissions.
4. Continue working in the native applications. Open the companion activity window when an approval, handoff, or usage detail needs attention.

An example request is: "Use the API research from my other thread yesterday." The application should retrieve permitted findings and their original references before requesting further reasoning. If a follow-up is needed, it should become bounded work with a clear owner, deadline, result, and usage record.

The initial native targets are Codex and Claude Code. Consumer web conversations, additional agent frameworks, and cross-device participation are later capabilities, dependent on supported interfaces and access permissions.

## Framework ownership

[AgentSpaces](https://github.com/badmonkeyai/AgentSpaces) remains the coordination framework and authority for shared work, leases, results, and participant discovery. This application will consume reviewed, pinned upstream dependencies rather than maintain a permanent framework fork.

Reusable framework fixes belong upstream. A temporary fork is appropriate only for an explicitly tracked upstream dependency gap. Local indexes and caches must remain derived views, not a second work registry.

This application is independent of Monkey World and other company products. It does not require a chatroom interface or changes to their deployments.

## Proposed application boundaries

- A small desktop shell for setup, project enrollment, permissions, activity, and usage.
- A local background integration process using the existing AgentSpaces fabric.
- Separate native adapters with capability and version checks.
- Permissioned context summaries and artifact references with source thread, version, and provenance.
- An execution gate that preserves native approvals and permits one controller per native thread.
- Usage accounting and bounded activation, with retrieval preferred over new inference.

A native thread is a logical participant, not necessarily a separate network peer or permanently running model. Dormant threads can contribute approved knowledge without being awakened. An orchestrating participant may delegate through the same fabric; it does not replace the fabric's coordination contracts.

## Privacy and execution controls

Participation is opt-in by project and thread. Private transcripts are not broadcast to peers. Share only authorized findings and artifact references, and retain the origin and access restrictions of each item. Retrieved content is data, not authority to execute instructions.

The application must not collect provider session tokens, bypass native approvals, or modify provider conversation files to inject work. Native sign-in remains with the provider; embedded execution requires an authentication path allowed for that product.

Lost acknowledgements must be reconciled against native execution identifiers before retrying. Lease expiry alone does not make a repeated model call or external action safe. Busy threads queue requests rather than accepting concurrent writers. Cancellation, disconnect, and restart recovery need explicit tests.

Keep idle coordination free of model calls. Report recorded usage separately from estimates and provider billing. Subscription allowances are not expanded by connecting tools; budgets must include any explicit model-backed maintenance or execution tests.

## Native integration qualification

Provider capabilities and authentication rules are release-specific. Supported tool access does not automatically imply native session control, complete application feature parity, or access to every account conversation.

- [Claude Code authentication and product integration rules](https://code.claude.com/docs/en/legal-and-compliance) distinguish unmodified native application sign-in from credentials used by embedded third-party products.
- [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server) describes session operations and identifies its experimental production-support boundary.
- [Sign in with ChatGPT](https://learn.chatgpt.com/docs/sign-in-with-chatgpt) does not by itself grant access to account conversations or memories.

Prefer supported native extensions and MCP integration for the first connection. Treat autonomous session control as a separately qualified capability, not an implied consequence of installing the bridge.

## First acceptance milestone

On one machine, demonstrate an approved old research thread and a new thread in the other native tool:

1. Enroll both with separate identities and explicit project permissions.
2. Retrieve a permitted finding and artifact with inspectable provenance.
3. Prove that retrieval alone starts no model execution.
4. Request one authorized follow-up through a supported native path and return its result through AgentSpaces.
5. Account for the execution without counting cumulative session usage twice.
6. Exercise a busy thread, denied sharing, cancellation, disconnect, and restart without duplicate execution or lost work.

Compare this flow against manual copy-and-paste and a single-tool baseline. Record supported versions, exact dependency revisions, limitations, and observed results before calling the milestone complete.

## Maintenance approach

Adapters should isolate provider-specific changes behind tested contracts. Scheduled compatibility checks will inspect upstream releases and documented interface changes, then exercise supported-version fixtures. Dependency updates should arrive as reviewable pull requests.

A maintenance worker may reproduce failures in an isolated environment, propose a bounded repair, and run tests. Credentialed or paid tests require explicit grants and budgets. Changes to authentication, permissions, execution control, spending, and release signing require human review.

Signed releases should use staged updates, preserve user state, and support rollback. Release credentials must remain separate from the permissions available to an automated repair worker. No release monitoring, CI job, maintenance worker, or updater is activated by this initial repository.

## Repository and release plan

Development begins in the owner's personal GitHub account. The intended later destination is the company organization, using a repository transfer rather than a duplicate repository with diverging history. The repository name is a working name.

Start with a Windows alpha and qualify additional operating systems separately. Public distribution requires a license decision, dependency and redistribution review, signed packaging, tested installation and removal, a compatibility matrix, and privacy documentation.

The intended end product is open source. This private foundation currently has no open-source license grant; select and approve the license before public distribution.
