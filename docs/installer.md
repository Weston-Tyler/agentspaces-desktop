# Install AgentSpaces Desktop

AgentSpaces Desktop is built on [AgentSpaces by Bad Monkey](https://www.badmonkey.ai/agentspaces/). Its Apache 2.0 license and attribution notice accompany each package; dependencies retain their own notices and terms.

Windows releases provide `AgentSpaces-Desktop-Setup-<version>-x64.exe`. Run it under your normal account. The per-user NSIS installer adds AgentSpaces Desktop to Start/search, creates a desktop shortcut, and registers an uninstaller in Settings → Apps → Installed apps (Apps & Features). It does not require administrator access. Uninstalling preserves application data.

Alpha installers are unsigned and automatic updating is not implemented. Download version-specific artifacts from [v0.1.0-alpha.3](https://github.com/Weston-Tyler/agentspaces-desktop/releases/tag/v0.1.0-alpha.3) or [all GitHub releases](https://github.com/Weston-Tyler/agentspaces-desktop/releases); verify the supplied SHA-256 checksum before installation. Publication and package construction do not establish platform/native acceptance or a production release.

The companion is licensed under [Apache 2.0](../LICENSE) and built on [AgentSpaces](https://www.badmonkey.ai/agentspaces/) by [BadMonkey](https://www.badmonkey.ai/). Preserve the application's and bundled components' notices. See [brand and attribution](brand-and-attribution.md) for upstream links and repository ownership.

Linux releases provide `AgentSpaces-Desktop-<version>-linux-x64.tar.gz`. Extract the archive, then run its bundled Node runtime:

~~~bash
./resources/runtime/node ./resources/app/scripts/install-linux.mjs
~~~

This copies the application to `~/.local/opt/agentspaces-desktop/<version>` and installs a launcher in the user's applications menu. It uses the normal desktop sandbox. Linux desktop/provider parity still requires platform acceptance; archive creation alone does not establish that qualification. To remove a version, remove its installation directory; remove the `com.agentspaces.desktop.desktop` launcher to remove the menu entry. Application data remains separate.

Both packages bundle a Node.js 24 worker runtime and its license. The read-only Claude SDK JavaScript is included with its notices; its optional native inference executables are excluded. Existing Codex and Claude binaries, account sign-in, permission prompts, and provider data remain native installations under the user's account. The installer does not bundle credentials or private application state. Native provider tools and configured SSH targets must already be available.

## Build from source

Build on the target Windows/Linux x64 host using Node.js 24. Install the pinned dependencies with `npm ci`, then run `npm run check` and `npm test`. `npm run package:win` creates the Windows installer; `npm run package:linux` creates the Linux archive; `npm run package:dir` creates an unpacked package for acceptance tests. Artifacts are written to `dist/`. These commands do not publish artifacts.

If a development checkout borrows `node_modules` through a junction, preserve that junction and install build tools into a separate owned directory. Set `AGENTSPACES_PACKAGER_CLI` to that directory's absolute `node_modules/electron-builder/cli.js` path. The wrapper checks its exact repository pin before building; installing dependencies through a shared junction would change the original checkout.

For deployment from an existing source installation, keep its owned workspace directory and set the installed desktop's user-data `workspace-location.json` to `{ "schema": 1, "root": "<absolute existing workspace directory>" }` before first launch. Stop the old owned desktop shell and companion before starting the installed application. The same workspace retains groups, grants, source bindings, delivery receipts, and owner access; provider account files remain in the native tools' existing locations. Do not include this pointer or runtime state in a release artifact.

The build uses electron-builder 26.17.0 and defaults to compression level 3 for short build times. The package is unpacked (`asar: false`) so native connectors and the terminal worker run under the bundled Node runtime. Electron rebuilding is disabled because `node-pty` belongs to that worker's Node ABI. Preparation records source and runtime SHA-256 hashes and checks the addon and AgentSpaces binding; the packaged application is checked again for exact application bytes, required imports, license notices, and private-state exclusion. Build each platform separately; copying a platform's `node_modules` to the other platform is unsupported.

Official references: [electron-builder release](https://github.com/electron-userland/electron-builder/releases/tag/electron-builder%4026.17.0), [NSIS options](https://www.electron.build/v26/docs/nsis/), [package contents and native rebuilding](https://www.electron.build/v26/docs/configuration/), [Linux packaging](https://www.electron.build/v26/docs/linux/).

## Remote SSH setup and upgrading older previews

The supported remote host uses the generic SSH alias `remote`. Configure that alias in your own SSH configuration with your chosen host and user; no personal host address, username, key or password is distributed with the application. Confirm `ssh remote` works before connecting the remote tools. Native logins stay on that host.

This preview changes the old development-specific host identifier. Existing installations should keep their current private workspace and credentials backed up and use a separate workspace when evaluating this release. Old source-bound connections and delivery receipts are not automatically migrated or replayed. Do not replace an active companion mid-conversation.
