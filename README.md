# Codex Profile Switcher

Codex Profile Switcher is a VS Code extension for people who work with more
than one Codex account, workspace, or runtime environment. It keeps named
profiles, lets you switch them from the UI, and synchronizes the selected
profile into the auth file used by the current Codex runtime.

This repository is maintained from the
[`shinganEuler/codex-switch`](https://github.com/shinganEuler/codex-switch)
fork and is intended as the base for a customized multi-profile Codex workflow.

## What This Fork Focuses On

Compared with a minimal profile switcher, this fork is oriented around the
practical failure cases that show up in real development setups:

* multiple Codex accounts on one machine,
* different workspaces under the same account,
* WSL and Windows using different auth files,
* SSH remotes shared by multiple local clients,
* synced profile stores such as Dropbox-backed directories,
* token freshness reconciliation before switching profiles.

The goal is to keep the active runtime auth file, saved profile data, and
shared storage state aligned without collapsing distinct identities by mistake.

## Core Features

* Create named Codex profiles from the current `auth.json` or from a file.
* Switch profiles from the status bar, tooltip links, or the command palette.
* Keep track of the previous profile for one-click toggling.
* Export and import full profile sets for backup or migration.
* Store credentials in SecretStorage, the default remote file store, or a
  machine-specific custom shared directory.
* Reconcile active profile state from both the saved store and the current
  runtime `auth.json`.
* Compare token freshness before switching and write back newer auth data
  to the stored profile when appropriate.

## Quick Start

1. Sign in with Codex CLI in the runtime you actually use.
   If you use WSL from Windows and enabled
   `chatgpt.runCodexInWindowsSubsystemForLinux`, run `wsl codex login`.
1. Run `Codex Profile Switcher: Manage Profiles`.
1. Import from the current `auth.json` or from a selected JSON file.
1. Switch profiles from the status bar, tooltip links, or the manage command.

## How Switching Works

The status bar shows the current active profile. Click behavior is configurable:

* `cycle`: switch through all saved profiles in order.
* `toggleLast`: switch between current and previous profile.

Before switching away from the current active profile, the extension compares
the stored profile payload with the current runtime `auth.json`. When the
runtime auth has the newer `last_refresh` value, the saved profile is updated
first and only then does the switch continue.

After a successful switch, Codex Profile Switcher writes the chosen auth data
into the active auth file so CLI and extension state stay aligned.

## Auth File Resolution

By default, auth is resolved as `<CODEX_HOME>/auth.json`.
If `CODEX_HOME` is not set, the fallback path is `~/.codex/auth.json`.

On Windows, the extension also checks
`chatgpt.runCodexInWindowsSubsystemForLinux`.
If enabled, it resolves and uses the WSL-side `~/.codex/auth.json` path.
If disabled, it uses the Windows-local path.

This prevents importing from one environment and switching in another.

## Profile Matching

Duplicate detection is identity-first.
When available, it matches by user identity fields from auth payloads:
`chatgptUserId`, `userId`, and JWT `sub`.

If identity fields are missing, matching falls back to combinations of
`email`, `accountId`, and default organization/workspace id when present.
If organization id exists only on one side, profiles are treated as distinct
to avoid accidental collapse.

## Storage Modes

`codexSwitch.storageMode` controls where profile data is stored:

* `secretStorage`: tokens are stored in VS Code SecretStorage.
* `remoteFiles`: tokens are stored in the default shared remote directory
  `~/.codex-switch`.
* `customRemoteFiles`: tokens are stored in a custom shared filesystem
  location from `codexSwitch.remoteFilesRoot`.
* `auto`: uses `remoteFiles` in SSH remote sessions, otherwise
  `secretStorage`.

In file-based modes, the storage layout is:

* `profiles.json` stores profile metadata.
* `profiles/<profile-id>.json` stores per-profile auth payloads.
* `active-profile.json` stores shared active-profile state.

Directories are created with `0700`, files with `0600`.

`codexSwitch.remoteFilesRoot` is machine-specific and intended for paths such
as Dropbox or other platform-local sync directories. It is marked as a
non-synced machine setting so the configured path does not follow VS Code
Settings Sync across different operating systems.

In `secretStorage` mode, profile metadata is still stored in a local
`profiles.json` file under VS Code global storage, while credentials stay in
SecretStorage.

## SSH Shared Mode

In `remoteFiles` mode, active state is reconciled from both
`~/.codex/auth.json` and `active-profile.json`.
If current auth clearly matches a saved profile, that match wins and the
shared active marker is updated.

This keeps multiple clients in sync when one client switches profiles,
runs `codex login`, or writes `auth.json` directly.

## Recovery

If profile metadata exists but stored auth data is missing,
the extension offers recovery options:

* recover from remote store data when available,
* import from current `auth.json`,
* or delete the broken profile.

## Main Settings

* `codexSwitch.debugLogging`
* `codexSwitch.activeProfileScope` (`global` or `workspace`)
* `codexSwitch.storageMode` (`auto`, `secretStorage`, `remoteFiles`,
  `customRemoteFiles`)
* `codexSwitch.remoteFilesRoot`
* `codexSwitch.reloadWindowAfterProfileSwitch`
* `codexSwitch.statusBarClickBehavior` (`cycle` or `toggleLast`)

## Development

```bash
npm ci
npm run compile
```

Useful commands:

* `npm run watch`
* `npm run lint`
* `npm run vscode:package`

## Security Notes

For local single-client use, `secretStorage` is the safer default.
Use file-based shared storage only on machines and directories you trust.

Sync writes `auth.json` via a temp-file-and-replace flow to reduce partial
write risk. The extension does not create rotated backup files such as
`auth.json.bak.*`.
