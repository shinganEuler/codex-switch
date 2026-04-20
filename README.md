# Codex Identity Router

Codex Identity Router is a VS Code extension for people who need to keep
multiple Codex identities isolated across different runtimes. It stores named
profiles and routes the correct `auth.json` into the environment you are
actually using, whether that is local VS Code, WSL, an SSH remote, or a shared
directory setup.

## Why This Extension Exists

Many Codex setups do not have a single stable login:

* one identity for client work and another for internal work,
* WSL and Windows pointing at different auth locations,
* SSH remotes shared by more than one editor session,
* synced directories used to carry profile state between machines,
* refreshed tokens landing in `auth.json` before a saved profile is updated.

Codex Identity Router focuses on runtime-aware auth routing so those
identities stay separate while profile changes remain fast inside VS Code.

## Main Workflows

* Capture a named profile from the current runtime `auth.json`.
* Import a profile from an exported JSON file.
* Switch from the status bar, command palette, or profile manager.
* Jump back to the previous profile without reopening a picker.
* Export and import complete profile sets for migration or backup.
* Choose credential storage based on whether you are local or remote.
* Refresh stored credentials automatically when the runtime auth file is newer.

## Runtime-Aware Auth Routing

The extension resolves the active auth file from the current runtime before it
imports, syncs, or writes profile data.

* Default resolution is `<CODEX_HOME>/auth.json`.
* If `CODEX_HOME` is not set, the fallback path is `~/.codex/auth.json`.
* On Windows, the extension checks
  `chatgpt.runCodexInWindowsSubsystemForLinux`.
  When enabled, it targets the WSL-side auth file instead of the
  Windows-local file.
* In shared SSH storage mode, it reconciles the current runtime auth file with
  the machine-scoped active-profile marker before deciding which identity is
  active.

This prevents a profile saved for one environment from overwriting the
credentials used by another environment.

## Storage Modes

`codexIdentityRouter.storageMode` controls where credentials and profile state live:

* `secretStorage`: credentials stay in VS Code SecretStorage and metadata
  stays in VS Code global storage.
* `remoteFiles`: credentials and shared state are stored in `~/.codex-switch`.
* `customRemoteFiles`: credentials and shared state are stored in the
  directory configured by `codexIdentityRouter.remoteFilesRoot`.
* `auto`: SSH remotes use `remoteFiles`; local sessions use `secretStorage`.

File-based stores use the following layout:

* `profiles.json` for profile metadata,
* `profiles/<profile-id>.json` for per-profile auth payloads,
* `active-profile@<machine>.json` for the machine-scoped active identity marker.

Directories are created with `0700`, files with `0600`.

## Quick Start

1. Sign in with Codex CLI in the runtime you actually use.
   If you run Codex through WSL, use `wsl codex login`.
1. Run `Codex Identity Router: Manage Profiles`.
1. Import the current `auth.json` or a JSON export.
1. Switch from the status bar or the command palette.
1. Optionally choose a storage mode that matches your machine or remote setup.

## Recovery Behavior

If profile metadata exists but the stored auth payload is missing, the
extension offers recovery choices instead of silently discarding the profile:

* recover from the remote file store when that data exists,
* import from the current runtime `auth.json`,
* delete the broken profile.

## Main Settings

* `codexIdentityRouter.debugLogging`
* `codexIdentityRouter.activeProfileScope` (`global` or `workspace`)
* `codexIdentityRouter.storageMode` (`auto`, `secretStorage`, `remoteFiles`,
  `customRemoteFiles`)
* `codexIdentityRouter.remoteFilesRoot`
* `codexIdentityRouter.reloadWindowAfterProfileSwitch`
* `codexIdentityRouter.statusBarClickBehavior` (`cycle` or `toggleLast`)

## Security Notes

* `secretStorage` is the safest default for single-machine use.
* Shared file stores should only be used on systems and directories you trust.
* `auth.json` is written through a temp-file-and-replace flow to reduce
  partial-write risk.
* The extension does not create rolling `auth.json.bak.*` files.

## Development

```bash
npm ci
npm run compile
```

Useful commands:

* `npm run watch`
* `npm run lint`
* `npm run vscode:package`
