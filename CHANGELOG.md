# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-08-18

First public release.

### Added

- Per-terminal account switching through `CLAUDE_CONFIG_DIR`, so several Claude
  Code accounts run at once without interfering.
- `cs` / `cs use` / `cs off`, plus an interactive picker sorted most-recently-used
  with filtering and number jumps.
- Aliases: `cs alias work w`, then `cs w`. A bare account name or alias switches
  directly.
- Per-account config sharing (`all`, `none`, or a list) via symlinks into
  `~/.claudeswitch/shared`, with broken links repaired on every switch and
  nothing ever discarded.
- `cs run`, `cs exec` and `cs shell` for using another account without switching.
- `cs refresh` and `cs keepwarm --install` to roll the 30-day idle deadline
  forward, the latter as a weekly launchd agent.
- `cs token` for long-lived tokens from `claude setup-token`, with a clear warning
  that Claude Code limits them to inference-only scope.
- `cs usage` and `cs ls --usage`: per-account 5-hour and weekly quota windows
  with reset times, and extra usage credits, read from Claude Code's own cache.
- `cs doctor` and `cs repair`, including detection of two accounts sharing one
  credential — the failure that makes copy-based switchers demand repeated
  logins.
- `cs help tokens`, `cs help isolation`, `cs help sharing`, `cs help aliases`,
  `cs help shell`.
- Shell integration for zsh, bash and fish, and `claudeswitch_prompt` for
  prompts.

### Notes on behaviour that took work to get right

- Account credentials are never copied. Claude Code rotates refresh tokens, so
  two copies invalidate each other.
- Each account pins a `securestorageKey`, exported as
  `CLAUDE_SECURESTORAGE_CONFIG_DIR`, so renaming an account or moving
  `~/.claudeswitch` cannot orphan its macOS Keychain entry.
- An absent `.credentials.json` means the credential is in the Keychain, not that
  the account is logged out.
- Registry writes take a cross-process lock, so concurrent terminals cannot drop
  each other's changes.
- `ANTHROPIC_*` and other provider overrides are cleared on switch; they would
  otherwise silently override the account you selected.
- Unknown command-line flags are rejected rather than ignored.
- Quota readings are discarded when they belong to a different identity, and
  labelled as historical past the one-hour mark Claude Code itself uses.
- A closed output pipe (`cs usage | head -1`) exits quietly.

[1.0.0]: https://github.com/coderphonui/claudeswitch/releases/tag/v1.0.0
