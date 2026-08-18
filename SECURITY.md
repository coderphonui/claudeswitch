# Security

claudeswitch handles Claude Code login credentials, so it is worth being precise
about what it touches and what it does not.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Email the
maintainer or use GitHub's private vulnerability reporting on
<https://github.com/coderphonui/claudeswitch/security/advisories/new>.

Include what you did, what happened, and the output of `claudeswitch doctor`
(it prints no secrets). A reply should arrive within a week.

## What claudeswitch does with credentials

**It never reads a token.** Claude Code owns authentication; claudeswitch only
tells it which directory to use, via `CLAUDE_CONFIG_DIR`. Logging in and
refreshing are done by `claude auth login` and by Claude Code itself.

Two places are exceptions, and both are deliberate:

- **Credential fingerprints.** `claudeswitch doctor` needs to know whether two
  accounts hold the same refresh token, because rotation would make them
  invalidate each other. It reads the refresh token from `.credentials.json`
  when that file exists, hashes it with SHA-256, and keeps the first 16 hex
  characters. The token itself is never stored, logged, printed, or returned
  from the function that reads it. See `src/core/creds.ts`.
- **Long-lived tokens.** `claudeswitch token <account>` stores a token minted by
  `claude setup-token` at `~/.claudeswitch/accounts/<name>/.long-lived-token`
  with mode `0600`, because Claude Code reads such tokens from the environment
  rather than from disk. It is written once and afterwards only read in order to
  set `CLAUDE_CODE_OAUTH_TOKEN` for a child process. `token --show` prints its
  length, never its value. Remove it with `claudeswitch token <account> --clear`.

One exposure is inherent to the mechanism: when an account uses a long-lived
token, switching to it exports `CLAUDE_CODE_OAUTH_TOKEN` into your shell, so any
process you start from that shell inherits it, and it is visible in that shell's
environment. Claude Code offers no other way to supply such a token. Accounts
using a normal login never export a credential.

## Where credentials actually live

On macOS, Claude Code stores OAuth credentials in the login Keychain, not in a
file, under a service name derived from the config directory:

```
service = "Claude Code-credentials-" + sha256(config dir).slice(0, 8)
account = $USER
```

claudeswitch never calls `security`, so it neither reads nor writes those
entries. It does pin the namespace: each account carries a fixed
`securestorageKey`, exported as `CLAUDE_SECURESTORAGE_CONFIG_DIR`, so that
renaming an account cannot orphan its credentials.

Consequences worth knowing:

- **Removing an account does not remove its Keychain entry.** `claudeswitch rm`
  therefore offers to sign the account out first, which is what clears it. Say
  no (or pass `--keep-credentials`) and the credential stays in your Keychain
  with nothing referencing it.
- **`claudeswitch rm` without `--purge` archives the account directory** to
  `~/.claudeswitch/archive/`, including a long-lived token if one was stored.
  Use `--purge` to delete outright.
- Everything under `~/.claudeswitch` is created mode `0700`, and files mode
  `0600`.

## Refresh-token rotation

Claude Code's refresh tokens rotate: using one invalidates it and returns a
replacement. A credential copied into two directories therefore self-destructs —
the first to refresh leaves the other holding something the server rejects.

claudeswitch is built around avoiding that. `claudeswitch import` copies settings
but never credentials, and `claudeswitch doctor` fails loudly if two accounts
ever share a fingerprint. If you copy account directories by hand, run
`claudeswitch doctor` afterwards.

## Trust boundaries

- claudeswitch runs entirely on your machine and makes no network requests of
  its own. Every network call comes from `claude`, which it spawns.
- It writes only inside `~/.claudeswitch`, plus — when you ask for them — one
  line in your shell rc file (`init --install`) and one launchd agent at
  `~/Library/LaunchAgents/com.claudeswitch.keepwarm.plist`
  (`keepwarm --install`).
- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and friends
  are stripped from the environment of every `claude` process it starts, and
  cleared in the shell it switches. They would otherwise override the account
  you selected and silently send your prompts elsewhere.

## Supported versions

The latest commit on `main` is supported. There are no long-lived release
branches yet.
