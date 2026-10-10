# Retaining a configured remote host across upgrades

AgentSpaces supports this device and one configured SSH host. A host's **identity**
is part of saved source IDs, room membership, grants, registration bindings and
native delivery receipts. The **SSH alias** selects an existing SSH configuration
entry. They can differ. Neither setting creates SSH credentials or connects an
account.

New installations default to identity `remote` and SSH alias `remote`. Existing
installations can retain their original identity without changing saved records:

| Setting | Purpose | Default |
| --- | --- | --- |
| `AGENTSPACES_REMOTE_HOST` | Exact retained remote identity | `remote` |
| `AGENTSPACES_SSH_ALIAS` | Existing SSH configuration alias | Remote identity |
| `AGENTSPACES_HOST_CONFIG` | Absolute path to an owner-private JSON configuration | No file |

Set these before starting the companion or desktop process. They apply for the
process lifetime; restart to load a deliberate configuration change. Identity and
SSH alias each accept 1–100 ASCII letters, digits, dots, underscores or hyphens,
starting with a letter or digit. `local` is reserved. Usernames, options, spaces
and shell expressions are not accepted; put connection details in your normal SSH
configuration instead.

For a persistent configuration, keep this file outside the application installation
folder and point `AGENTSPACES_HOST_CONFIG` at it in the retained service launcher
or user environment. The following labels are fictional examples:

```json
{
  "schema": 1,
  "remoteHost": "legacy-lab",
  "sshAlias": "lab-transport"
}
```

On Unix, the file must belong to the current owner and have mode `0600`. Symlinked
files or parent directories are refused. Keep it in the owner-private workspace
on Windows. Environment identity/alias values override corresponding file values.
The file contains no provider credentials or SSH passwords.

An upgrade must retain the workspace location and this startup configuration.
Do not globally replace old labels with `remote` in saved JSON, rewrite session
IDs, regenerate connector capabilities, or replay native input to migrate hosts.
If saved workspace/preferences use a different identity from the configured one,
startup refuses before restoring or saving the workspace. Configure the retained
identity and restart; this refusal performs no state migration.

With the matching identity, adapter eligibility, Linux path handling, version
checks, source selection, room delivery, registration and reverse-tunnel recovery
use that identity consistently. SSH processes use the separate configured alias.
The UI receives the identity from the owner service. Copied participant CLI/MCP
modules accept the bounded host-label syntax and let the service enforce the
configured host and existing grants; they do not need the service's configuration
file or environment. Refreshing managed connector code must retain its existing
source identity and grants.

Changing only the SSH alias is appropriate when an SSH configuration entry is
renamed for the **same computer**. It is not permission to redirect existing
identities and grants to a different computer. Additional-host onboarding and
moving native histories to another host remain outside this compatibility path.

## Verification boundary

Tests cover default configuration and a fictional retained identity with a
separate SSH alias. A saved-workspace fixture starts the HTTP service again,
reuses its existing connector, and checks source/project IDs, denials, device
binding, room membership, queued receipts and permission proofs. Other fixtures
check Linux path handling on a Windows host, copied CLI and serialized installer
code, transport arguments and retained reverse-tunnel records.

These are synthetic process/transport fixtures, not a live model invocation or
proof that an installed service has been upgraded. Deployment must separately
verify the retained workspace, startup configuration, source hashes and service
health.

For a normal installed launch, an optional owner-private
`~/.agentspaces-desktop/host.json` uses the same configuration schema.
Explicit `AGENTSPACES_HOST_CONFIG` selects another private file; explicit host
and SSH environment values take precedence. The file is never shipped with the
application or committed to source control. This makes an existing installation's
identity persist independently of a temporary deployment shell.
