# Architecture

How claudeswitch works, and why it is built this way. Most of what follows was
established by reading Claude Code 2.1.234 and testing against it, not from
documentation — so each claim notes how it was checked.

## The core idea

Claude Code reads all of its state from one directory, named by
`CLAUDE_CONFIG_DIR`. Point it somewhere else and you get a separate
installation: its own credentials, conversation history, trusted folders and MCP
servers.

```
~/.claudeswitch/accounts/work/       ← one account
~/.claudeswitch/accounts/personal/   ← another
```

Switching is therefore just setting an environment variable, and environment
variables belong to a process rather than to the machine. Two terminals can hold
two accounts indefinitely and concurrently, because they never open the same
file. Nothing is copied into place, so there is no window in which a switch can
corrupt a live session.

*Verified:* a fresh directory reports `Not logged in`; two shells each running
`cs use <different account>` keep their own identity while the other switches.

## Layout

```
~/.claudeswitch/
├── registry.json            index: accounts, aliases, share policies, cached state
├── accounts/<name>/         one Claude Code config dir per account
├── shared/                  the real files that shared assets symlink to
├── archive/                 anything replaced or removed, never deleted silently
└── keepwarm.log             output of the scheduled refresh
```

```
src/
├── cli.ts                 dispatch, per-command flag validation, help topics
├── core/
│   ├── paths.ts           every path in one place
│   ├── registry.ts        registry.json; all writes go through a lock
│   ├── share.ts           shareable assets, symlink sync and repair
│   ├── securestorage.ts   the macOS Keychain namespace, pinned per account
│   ├── claude.ts          wraps the `claude` CLI; builds each account's env
│   ├── creds.ts           non-secret credential view: kind, storage, expiry
│   ├── reserved.ts        command words, and which ones change the environment
│   ├── args.ts            flag parsing and validation
│   └── util.ts            atomic writes, cross-process lock, robust copy
├── shell/hook.ts          zsh/bash/fish integration, env emission
├── ui/                    output routing, colour, tables, /dev/tty picker
└── commands/              one file per group of subcommands
```

## Why a shell function

A process cannot change its parent shell's environment. So `cs` is a shell
function that evaluates what the binary prints:

```sh
eval "$(claudeswitch init)"
```

The generated function splits commands in two. Read-only ones
(`ls`, `doctor`, …) run directly so their stdout stays pipeable —
`cs ls --json | jq` works. Everything else, including a bare account name or
alias, is captured and `eval`ed, which is how `cs work` sets the variables.

`HOOK_VERSION` in `src/shell/hook.ts` is bumped whenever the generated function
gains behaviour the binary depends on. The rc file regenerates the hook at every
shell start, so a mismatch only means the current shell is stale; `cs doctor`
says so and asks for a `source`.

## Credentials

### They are in the Keychain, not in a file

On macOS, Claude Code keeps OAuth credentials in the login Keychain. The entry is
namespaced:

```
service = "Claude Code" + OAUTH_FILE_SUFFIX + "-credentials" + "-" + sha256(dir).slice(0, 8)
account = $USER
```

where `dir` is `CLAUDE_SECURESTORAGE_CONFIG_DIR` if set, else `CLAUDE_CONFIG_DIR`.
With neither set there is no suffix — that is the entry `~/.claude` uses.

*Verified:* two accounts report different emails simultaneously with no
`.credentials.json` anywhere; and pointing `CLAUDE_SECURESTORAGE_CONFIG_DIR` at
one account's directory while `CLAUDE_CONFIG_DIR` points at an empty one makes
the empty directory report that account's login.

Two consequences shape the design:

- Per-directory entries are what make concurrent accounts possible, and the
  secret stays encrypted rather than sitting in plaintext.
- The entry is keyed by the directory **path**, so renaming an account would
  orphan its credentials. Every account therefore carries a `securestorageKey`
  fixed at creation; `cs rename` deliberately does not update it, and every
  switch exports it. *Verified:* removing the key from the registry makes a
  renamed account report `loggedIn: false`; restoring it brings it back.

Because the expiry date is sealed in the Keychain, `cs ls` shows an idle budget
estimated from the last activity claudeswitch saw, marked `~`. Activity outside
claudeswitch is invisible to it, which makes the estimate pessimistic — the safe
direction for deciding when to renew.

### Token lifetimes and rotation

| | |
|---|---|
| access token | ~1 hour; refreshed silently by Claude Code |
| refresh token | 30 days (`xj_ = 2592000000` ms in the binary) |
| warning | at 3 days left (`GCh = 3 * 86400000`) |

The 30 days run from last use: every refresh mints a new refresh token with a
fresh window, so an account touched monthly never needs an interactive login.
Neither lifetime is configurable — the server sets them.

Refresh tokens **rotate**: using one invalidates it and returns a replacement.
So a credential must never exist in two places, or the first to refresh leaves
the other holding something the server rejects. This is the whole reason
`cs import` copies settings but not credentials, and why `cs doctor` compares
SHA-256 fingerprints of refresh tokens (never the tokens themselves) across
accounts and against `~/.claude`.

*Verified, the hard way:* copying one credential into a second directory and
refreshing there did invalidate the original.

### Keeping accounts alive

`cs refresh` makes one short authenticated request per account. That is the
cheapest option available: `claude auth status` reads the stored credential and
contacts nothing, so it cannot renew anything (verified — an artificially
expired access token stayed expired across `auth status`). The token endpoint is
only reached once the access token has expired, which is true of any account idle
for over an hour.

`cs keepwarm --install` writes a launchd agent that runs `claudeswitch refresh`
weekly. launchd hands a job only `/usr/bin:/bin:/usr/sbin:/sbin`, so
`findClaudeBin()` searches known install locations rather than trusting `PATH` —
found by the first real scheduled run failing with "claude not found".

### Long-lived tokens

`claude setup-token` mints a token that does not expire on a schedule, read from
`CLAUDE_CODE_OAUTH_TOKEN`. Claude Code limits these to inference-only scope; a
normal login also carries `user:profile`, `user:file_upload`, `user:mcp_servers`
and `user:sessions:claude_code`, and Remote Control refuses to work without them.
`cs token` therefore exists but warns, and `cs keepwarm` is the default answer to
expiry.

## Quota reporting

Claude Code fetches `GET /api/oauth/usage` and caches the parsed result in
`<config dir>/.claude.json` as `cachedUsageUtilization`: a `fetchedAtMs`, the
`accountUuid` it belongs to, and one entry per limit window (`five_hour`,
`seven_day`, `seven_day_opus`, …) each with a utilization percentage and a
`resets_at`, plus `extra_usage` credits in minor units.

claudeswitch reads that cache and never fetches. Fetching would require the
account's access token, which on macOS means reading the Keychain — the one thing
this tool promises not to do. Two behaviours are copied from Claude Code so the
numbers mean the same thing in both places:

- A cache whose `accountUuid` differs from the directory's own `oauthAccount` is
  discarded. Without this, re-logging in as somebody else would show the previous
  identity's quota.
- Readings older than an hour (`hzb = 3600000`) are marked as historical, because
  that is the point at which Claude Code stops trusting its own cache.

Coverage is the cost. The fetch happens only from interactive code paths — the
`/usage` panel, the extra-usage flows, and the limit messages. *Verified:* a
`claude -p` turn does not populate the cache; a real working session does.

Two refinements follow from the fact that a limit belongs to the identity rather
than to a directory:

- Readings are pooled by `accountUuid`. `readUsage` looks in the account's own
  directory, every sibling account directory, and `~/.claude`, keeps those whose
  identity matches, and uses the freshest — naming its origin in the output. An
  account never opened in `/usage` can therefore still report real numbers.
  *Verified:* `~/.claude` and the managed `khoa.tran` account, the same identity
  in two directories, reported identical windows from independent fetches 44
  minutes apart.
- A bucket whose `resets_at` has passed is flagged `rolledOver`. Its percentage
  describes a window that no longer exists, so it is withheld rather than
  displayed, and `tightestBucket` skips it.

## Sharing configuration

Isolation is about identity, not about settings. Skills and hooks are yours
regardless of which account pays for the tokens, so they live once in `shared/`
and are symlinked into each account that wants them. Each account chooses its own
policy (`all`, `none`, or a list), stored in the registry.

Claude Code sometimes replaces `settings.json` rather than writing through it,
which breaks a symlink. Every `cs use` re-checks the links and repairs them
without discarding anything: identical content is silently relinked, a newer real
file is promoted into `shared/`, an older one is copied into `archive/` first.

Private per account, because sharing them would break isolation:
`.credentials.json`, `.long-lived-token`, `.claude.json`, `projects/`,
`sessions/`, `history.jsonl`, `todos/`. `cs doctor` fails loudly if any of them
becomes a symlink.

## Concurrency

Every read-modify-write of `registry.json` goes through `mutateRegistry`, which
takes an `O_EXCL` lock and writes through a temp file named with the pid. Without
it, two terminals switching at the same moment each saved their own stale
snapshot and silently dropped the other's changes — a real bug, found by running
two shells at once, now covered by a test that runs eight switches and three
additions concurrently.

Locks are not reentrant, so anything slow — an interactive login, an auth probe —
happens outside the lock, and the result is applied in a short callback
afterwards.

## Design rules worth keeping

- **Never guess about credentials.** An absent `.credentials.json` means "look in
  the Keychain", not "logged out". Conflating the two made every account look
  broken in the picker.
- **Never lose data.** Anything replaced goes to `archive/` first. A corrupt
  `registry.json` raises an error instead of being treated as empty and
  overwritten.
- **The hot path stays instant.** `cs` and `cs use` are typed constantly, so the
  picker never probes; probes happen on the one account being switched to, and
  their results are cached in the registry for the picker to read.
- **Fail loudly on typos.** Unknown flags are rejected, because
  `cs rm work --purgee` used to archive the account and report success.
- **Fall silent on a closed pipe.** `cs usage | head -1` must not print an EPIPE
  stack trace. `src/ui/io.ts` routes every write through a guard that latches
  once the destination is gone.
