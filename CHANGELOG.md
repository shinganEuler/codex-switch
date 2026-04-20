# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog][],
and this project adheres to [Semantic Versioning][].

<!--
## Unreleased

### Added
### Changed
### Removed
-->

## [1.3.6][] - 2026-04-20

### Changed

* Renamed command IDs and configuration keys from `codexSwitch` /
  `codex-switch` to `codexIdentityRouter` / `codex-identity-router`.
* Switched active-profile state keys and secret prefixes to the new
  `codexIdentityRouter` namespace.

## [1.3.5][] - 2026-04-20

### Changed

* Renamed the published extension package ID to `codex-identity-router`.
* Updated generated package artifacts, export filenames, and debug log prefixes
  to match the new extension ID.

## [1.3.4][] - 2026-04-20

### Changed

* Switched shared active-profile markers to machine-scoped filenames such as
  `active-profile@<machine>.json`.
* Kept compatibility with legacy `active-profile.json` so existing shared state
  can still be read during the transition.

## [1.3.3][] - 2026-04-20

### Changed

* Rebranded the Marketplace-facing name to Codex Identity Router.
* Replaced the extension icon and listing copy so the Marketplace entry is
  visually and editorially distinct.
* Rewrote the README around runtime-aware auth routing, independent identity
  isolation, and environment-specific profile handling.

## [1.3.2][] - 2026-04-14

### Added

* `customRemoteFiles` storage mode with a machine-scoped custom remote root
  setting for synced directories such as Dropbox.
* Token freshness checks before switching profiles, using `last_refresh`
  to write back newer runtime auth data to stored profiles.

### Changed

* Rebranded the project for the `shinganEuler/codex-switch` fork.
* Switched packaging and publishing scripts from the deprecated `vsce`
  package to `@vscode/vsce`.
* Removed `.vscodeignore` so packaging relies only on `package.json.files`,
  which matches current `vsce` requirements.

## [1.3.1][] - 2026-04-05

### Added

* Automatic publishing to <https://open-vsx.org/> in the release workflow.

[1.3.6]: https://github.com/shinganEuler/codex-switch/compare/v1.3.5...v1.3.6
[1.3.5]: https://github.com/shinganEuler/codex-switch/compare/v1.3.4...v1.3.5
[1.3.3]: https://github.com/shinganEuler/codex-switch/compare/v1.3.2...v1.3.3
[1.3.4]: https://github.com/shinganEuler/codex-switch/compare/v1.3.3...v1.3.4
[1.3.2]: https://github.com/shinganEuler/codex-switch/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/shinganEuler/codex-switch/compare/v1.3.0...v1.3.1

## [1.3.0][] - 2026-03-16

### Added

* Shared SSH profile storage for remote sessions.
  (PR #9 by @iqdoctor)
* Added storage mode selection with `auto`, `secretStorage`, `remoteFiles`.
  (PR #9 by @iqdoctor)
* Direct profile activation from tooltip.
  (PR #8 by @iqdoctor)
* Added export and import profile commands for full profile backup/restore,
  including credentials and active/previous profile selection.

### Changed

* `auth.json` resolution now follows the active runtime environment,
  including Windows + WSL scenarios.
  (PR #10 by @panella87)
* Duplicate detection now uses identity-first matching.
  (PR #10 by @panella87)
* Duplicate detection is workspace-aware while preserving identity-first logic.
  (follow-up changes on `master`; aligns with PR #5 by @iqdoctor)
* Status-bar click behavior is explicitly configurable:
  `cycle` (cycle all profiles) or `toggleLast` (switch current/previous).

### Fixed

* Removed redundant Cancel action in duplicate-account modal prompts.
  (PR #4 by @iqdoctor)
* Prevented false duplicate matches in Team/Business account scenarios.
  (PR #10 by @panella87)

### Removed

* Removed `auth.json.bak.*` backup creation during sync.
  (PR #7 by @iqdoctor)

[1.3.0]: https://github.com/shinganEuler/codex-switch/compare/v1.2.0...v1.3.0

## [1.2.0][] - 2026-02-15

### Added

* First public release

[1.2.0]: https://github.com/shinganEuler/codex-switch/tree/v1.2.0

<!--links-->
[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
[Semantic Versioning]: https://semver.org/spec/v2.0.0.html
