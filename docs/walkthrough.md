# AgentSpaces Desktop walkthrough

This guide describes the source alpha. Screenshots use fictional work and synthetic responses, not private conversations or live-model acceptance evidence.

## Install the source application

On Windows, install Node.js 24 or later, Git, and the native Codex or Claude Code CLI. Open PowerShell in the repository checkout:

~~~powershell
npm ci
npm run check
npm test
npm run desktop
~~~

Use the native providers’ login flows. Open Native tools to run the installed CLI, or sign in from your normal native terminal. Provider authentication and approval dialogs remain inside those tools. No provider credential fields are required in AgentSpaces Desktop. Optional Claude API answering is separate from native login.

For source launch shortcuts:

~~~powershell
powershell -NoProfile -File scripts/Install-Windows-Shortcuts.ps1
~~~

This creates desktop and Start menu shortcuts plus a background startup shortcut for this checkout. Keep its files and dependencies in place. These are source launchers, not a signed installer. The default local preview address is http://127.0.0.1:43127.

The desktop can attach to the owned background service. Closing the window hides it to the tray; quitting a window attached to a separate background service leaves that service running. Inspect or stop the service with:

~~~powershell
node app/cli.mjs status
powershell -NoProfile -File scripts/Stop-Background.ps1
~~~

## Ask one question

Open Ask and enter “What have we done on retry handling?” The application checks native Codex connections, searches permitted work and chooses a bounded set of eligible thread findings and text files. With no eligible context, it uses the general-question route and reports that in coverage.

![Fictional retry-handling question and synthetic answer with sources](images/ask.png)

*Fictional demonstration data; the displayed answer is synthetic and made no model call.*

Open Sources below the answer to inspect provenance, truncation and coverage. “Everything we have done” means evidence found within the captured permitted sources, not every account or machine. Cancel stops the owned request where possible; an uncertain native outcome is not automatically retried.

## Create a group chat

Open Group chats, choose Create a group chat, name it and select thread agents. Mention an alias such as @codex1 or use the reply selector. Source thread IDs remain stable even when titles change.

![Fictional group chat containing Codex and Claude thread agents](images/group-chat.png)

*Synthetic demonstration; messages do not represent observed live native replies.*

Sharing, retrieval and execution permissions remain distinct. A thread reference does not authorize reading its entire history or taking over a running controller. Known active sources are refused where observable; otherwise the native owner must confirm that other controllers are closed.

Claude participation uses a prepared scoped MCP channel in its native CLI. The owner explicitly enables the provider’s development-channel preview and accepts native confirmation. Organization settings and channel policy still apply. Replies return with connector-bound source attribution; a supplied native turn ID is self-reported unless separately verified.

The Codex scoped headless conversation route uses original source identity and bounded controls. Its current implementation has fixture coverage, which does not establish a new live proof for arbitrary existing threads. Earlier live Codex question and continuity observations retain their original scope. Check the current handoff and [native companion guide](native-companion.md) for qualification.

Direct group replies do not automatically establish signed AgentSpaces delegated-work claims, integration acceptance or completion of a code change.

## Follow the work

Your threads finds native conversations. Connected work adds permitted repositories, worktrees, documents and artifacts. Inspect a file’s exact indexed content, or compare two worktrees on a supported host for ancestry, unique commits and local changes.

![Fictional connected-work map and worktree relationships](images/connected-work.png)

*Fictional paths and projects; no private repository inventory appears here.*

Inventory can stop at time or file limits. Inspect coverage and continue the scan before assuming missing work does not exist. Equal hashes establish equal bytes, not publication, integration or permission to delete a copy.

## Connect another host

The current remote adapter uses the documented SSH target remote. Its Linux terminal and read paths have been exercised through an existing SSH connection. Native authentication stays on its owning host. Remote channels use owner-private scoped configuration and a loopback SSH forward, not an administrator capability.

This is not an arbitrary-host connection wizard. Additional machines, accounts and native homes need supported configuration. Windows desktop behavior has been observed; Linux Electron desktop parity and macOS qualification remain open.

Read [open-source readiness](open-source-readiness.md) and [compatibility](compatibility.md) for distribution and qualification boundaries.
