# claudeswitch

Run several Claude Code accounts at the same time, one per terminal, without them
interfering with each other.

```
$ cs
  Switch Claude account   3 accounts

❯ 1 ○ personal     me, p  me@gmail.com          max   2h ago
  2 ● work         w      khoa@company.com      team  4m ago      Company ABC
  3 ! client-acme         needs login           pro   never used  Acme retainer

  ↑↓ move · 1-9 jump · type to filter · ⏎ select · esc cancel
```

```
$ cs ls
   ACCOUNT      ALIAS   EMAIL                 PLAN  STATUS  IDLE BUDGET  LAST USED
●  work         w       khoa@company.com      team  ✓       ~30d         4m ago
○  personal     me, p   me@gmail.com          max   ✓       ~28d         2h ago
○  client-acme          dev@acme.io           pro   ✓       ~11d         19d ago

$ cs usage
● work  khoa@company.com · team
  5-hour session  ██████████ 100%  resets in 1h 37m
  week            █░░░░░░░░░  13%  resets in 6d 20h
  extra usage     ███░░░░░░░  33%  11.43 of 35.00 USD this month
  as of 31m ago
```

macOS. No runtime dependencies. MIT licensed.

## Why

Most account switchers copy credentials into `~/.claude` and swap them in place.
That works until you open a second terminal: both sessions read the same
credential file, the same history, the same session store, and the last write
wins.

Worse, Claude Code's refresh tokens **rotate** — using one invalidates it and
returns a replacement. Two directories holding the same token therefore destroy
each other, and the loser is told to log in again. That is usually why a switcher
feels like it logs you out at random.

claudeswitch never copies a credential and never swaps anything. Claude Code
reads all of its state from the directory named by `CLAUDE_CONFIG_DIR`, so each
account gets its own directory and switching is one environment variable in one
shell:

```
~/.claudeswitch/accounts/work/       ← credentials, history, trusted folders
~/.claudeswitch/accounts/personal/   ← a completely separate installation
```

Environment variables belong to a process, so a terminal that ran `cs use work`
cannot affect a terminal that ran `cs use personal`. Both can run Claude Code
indefinitely and concurrently: they never open the same file.

## Install

Requires [Bun](https://bun.sh) to build, and Claude Code on your `PATH`.

```sh
git clone https://github.com/coderphonui/claudeswitch.git
cd claudeswitch
./install.sh                          # builds and installs ~/.local/bin/claudeswitch
claudeswitch init --install           # adds the shell hook to ~/.zshrc
source ~/.zshrc
```

Then set up your accounts:

```sh
cs import          # bring your existing ~/.claude settings under management
cs login main      # give it its own login (credentials are never copied)
cs add work        # add a second account
cs use work        # switch this terminal only
```

`init --install` appends one `eval` line between `# >>> claudeswitch >>>`
markers. Remove that block and run `./install.sh --uninstall` to undo everything;
your accounts stay in `~/.claudeswitch` until you delete that directory.

For bash or fish: `claudeswitch init --install --shell bash|fish`.

## Commands

| | |
|---|---|
| `cs` | pick an account for this terminal |
| `cs use <name>` | switch this terminal only |
| `cs <name>` | same thing, spelled shorter — accepts an alias |
| `cs off` | back to Claude Code's default account |
| `cs ls` | list accounts (`--usage`, `--wide`, `--deep`, `--json`) |
| `cs current` | what this terminal is signed in as (`--json`) |
| `cs import [name]` | adopt `~/.claude`'s settings (`--with-sessions` for history too) |
| `cs add <name>` | create an account and log in (`--email`, `--console`, `--no-login`) |
| `cs login/logout <name>` | re-authenticate, or drop credentials but keep history |
| `cs rm <name>` | archive and unregister (`--purge` to delete outright) |
| `cs rename <old> <new>` | rename an account |
| `cs label <name> <text>` | annotate an account |
| `cs alias <name> <alias…>` | add short names to type instead (`--clear`) |
| `cs unalias <alias…>` | remove an alias |
| `cs default [name]` | account for new shells, with `init --auto` |
| `cs run <name> [args…]` | run `claude` as that account, no switching |
| `cs exec <name> -- <cmd>` | run any command as that account |
| `cs shell <name>` | subshell pinned to that account |
| `cs which [name]` | print an account's `CLAUDE_CONFIG_DIR` |
| `cs share …` | configure what is shared between accounts |
| `cs usage [name]` | 5-hour and weekly limits, and when they reset (`--json`) |
| `cs refresh [name]` | roll the 30-day idle deadline forward (`--force`, `--due`) |
| `cs keepwarm --install` | do that weekly via launchd so logins never lapse |
| `cs token <name>` | swap in a long-lived token (`--clear`, `--show`) |
| `cs doctor` | health check (`--deep`) |
| `cs repair [name]` | fix links and metadata (`--adopt`, `--refresh`) |

`cs help usage`, `cs help tokens`, `cs help aliases`, `cs help isolation`,
`cs help sharing` and `cs help shell` explain the mechanics in more detail.

## Aliases

An account's name is also its directory name, so `cs rename` moves state around.
An alias is only another way to type it:

```sh
cs alias work w              # `cs w` now switches to work
cs alias personal p me       # as many as you like
cs unalias w                 # remove one
cs alias work --clear        # remove all of an account's aliases
cs alias                     # show every alias
```

Aliases work anywhere an account name does — `cs w`, `cs run w -p "hi"`,
`cs share w none`, `cs which w`. They never move a directory and never touch
credentials. An alias cannot collide with an account name, another alias, or a
claudeswitch command, because `cs <word>` has to stay unambiguous.

## Sharing configuration

Isolation is about identity, not about your settings. Your skills and hooks are
yours no matter which account pays for the tokens, so they live in one place and
are symlinked into every account that wants them:

```
~/.claudeswitch/shared/settings.json              ← the real file
~/.claudeswitch/accounts/work/settings.json       → symlink
~/.claudeswitch/accounts/personal/settings.json   → symlink
```

Shareable: `settings.json`, `CLAUDE.md`, `keybindings.json`, `skills/`,
`plugins/`, `agents/`, `commands/`, `hooks/`, `output-styles/`.

Each account picks its own policy, so a work account can be a sealed sandbox
while your personal accounts share everything:

```sh
cs share work none                 # fully isolated
cs share personal all              # share everything
cs share client-a skills,plugins   # share just those
cs share --default none            # policy for accounts created from now on
cs share                           # show what is shareable and each policy
```

Always private, because sharing them would break isolation:

- `.credentials.json` and `.long-lived-token` — credentials
- `.claude.json` — identity, trusted folders, MCP servers, onboarding state
- `projects/`, `sessions/`, `history.jsonl`, `todos/`, `file-history/`

MCP servers live inside `.claude.json`, so they are per-account by design.
`cs doctor` fails loudly if any private path ever becomes a symlink.

## Quota

```sh
cs usage              # every account: each window, and when it resets
cs usage work         # one account
cs ls --usage         # a compact column showing the tightest window
```

Claude Code meters a subscription in overlapping windows — a 5-hour session
window, a rolling week, sometimes a separate weekly budget per model — plus extra
usage credits where enabled. `cs usage` shows all of them per account with the
time remaining, so you can see which account still has room before you switch.

**The quota belongs to the account, not to this machine.** Anthropic meters the
identity, so using an account anywhere — another terminal, another machine,
claude.ai, or a second claudeswitch account holding the same login — consumes the
same windows. There is no per-directory allowance.

**What is per-directory is the recording.** Claude Code fetches usage from its API
and caches the result in each config directory; claudeswitch reads that cache
rather than fetching, because fetching would mean reading the account's access
token out of the macOS Keychain, and this tool never reads a token. So the numbers
are accurate as of their timestamp — always shown — and usage burned elsewhere
since then is counted by Anthropic but not yet visible here.

Two things soften that:

- A reading recorded by any directory signed in as the **same identity** is used,
  freshest first, with its origin named. An account you have never opened `/usage`
  in can still show real numbers if a sibling account or `~/.claude` has them.
- A window whose reset time has already passed is reported as rolled over instead
  of at its old percentage, since that number describes a window that no longer
  exists.

Claude Code fetches usage only when its own interface needs it — opening `/usage`,
or running into a limit. A `claude -p` run does not. So a brand-new account shows
nothing until you have looked at usage inside it once:

```sh
cs use work        # then run /usage in Claude Code
```

Claude Code ignores its own cache once it is an hour old, so `cs usage` labels
anything older as a historical reading, and `cs ls --usage` prefixes it with `~`.

## Staying logged in

Claude Code gives each account an access token good for about an hour and a
refresh token good for 30 days. The access token is refreshed silently. The 30
days run from **last use**, not from login: every refresh mints a new refresh
token with a fresh 30-day life, so an account you touch monthly never needs an
interactive login. Neither lifetime can be extended — the server sets them.

An account left idle past 30 days does need a login, so roll the window forward
on a schedule:

```sh
cs refresh                 # every account, now
cs keepwarm --install      # weekly, in the background, via launchd
cs keepwarm                # is it running? what did it log?
```

A refresh costs one short authenticated request, and only for accounts idle over
an hour — the token endpoint is contacted only once the access token has expired,
so `claude auth status` renews nothing.

If you would rather not think about expiry at all, `cs token <name>` stores a
long-lived token from `claude setup-token`. It never expires on a schedule, but
Claude Code limits these to inference-only scope, which switches off features
like Remote Control. Prefer `cs keepwarm` unless you need an unattended token.

## Where credentials live

On macOS, Claude Code keeps them in the login Keychain rather than in
`.credentials.json`, under a per-directory service name:

```
service = "Claude Code-credentials-" + sha256(config dir).slice(0, 8)
account = $USER
```

Per-directory entries are what let several accounts run at once, and the secret
stays encrypted rather than sitting in a plaintext file. But the entry is keyed
by the directory **path**, so renaming an account would orphan its credentials
and silently log it out. Every account therefore carries a `securestorageKey`
fixed at creation, exported as `CLAUDE_SECURESTORAGE_CONFIG_DIR` on every switch,
which keeps renames and a relocated `~/.claudeswitch` safe. `cs current` prints
the entry in use.

One consequence: the exact expiry is sealed in the Keychain, so `cs ls` shows an
idle budget estimated from the last activity it saw, marked `~`. The estimate is
pessimistic — activity outside claudeswitch is invisible to it — which is the
safe direction for deciding when to renew.

Removing an account does not remove its Keychain entry, so `cs rm` offers to sign
the account out first. See [SECURITY.md](SECURITY.md) for exactly what this tool
does and does not read.

## Details worth knowing

**Credentials are never copied.** `cs import` brings your settings across and has
the account log in for itself. `cs doctor` compares credential fingerprints —
SHA-256, never the tokens — and fails loudly if two accounts share one, including
sharing with Claude Code's own `~/.claude`.

**Clobbered symlinks are repaired, never discarded.** Claude Code sometimes
rewrites `settings.json` by replacing the file, which breaks a symlink. Every
`cs use` re-checks the links: identical content is silently relinked, a newer real
file is promoted into `shared/`, an older one is copied into
`~/.claudeswitch/archive/` first. Nothing is lost either way.

**Concurrent terminals cannot corrupt the registry.** Every read-modify-write of
`registry.json` takes an `O_EXCL` lock and writes through a temp file named with
the pid, so eight terminals switching while three accounts are being added all
land intact. `scripts/test.sh` asserts this.

**Provider overrides are cleared on switch.** `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and friends take precedence over
OAuth, so a leftover `export ANTHROPIC_BASE_URL=…` from a third-party gateway
would silently ignore the account you just selected. `cs use` unsets them in the
shell it switches and says so; pass `--keep-env` to keep them.

**Unknown flags are rejected.** `cs rm work --purgee` used to archive the account
and report success. Now it names the typo and suggests `--purge`.

**New accounts skip onboarding.** A fresh config directory would normally make
Claude Code re-ask for a theme. `cs add` seeds the minimum to skip that, and
`--inherit-trust` copies your already-trusted folders from `~/.claude.json`.

**Same identity, several accounts is allowed** — separate histories, separate
trusted folders — but rate limits belong to the identity, not the directory.
`cs doctor` points out duplicates.

## Show the active account in your prompt

```sh
# ~/.zshrc, after the claudeswitch block
setopt PROMPT_SUBST
RPROMPT='%F{cyan}$(claudeswitch_prompt)%f'
```

`claudeswitch_prompt` reads an environment variable and starts no subprocess.

## Development

```sh
bun install
bun run dev -- ls        # run from source
bun run check            # typecheck + lint + build + 86 tests
bun run build            # dist/claudeswitch (a standalone binary, ~60 MB)
./install.sh             # reinstall
```

Tests run entirely inside a throwaway `CLAUDESWITCH_HOME` and never touch
`~/.claude` or `~/.claudeswitch`.

Install the binary with `install.sh` rather than copying it over an existing one.
Overwriting a Mach-O binary in place keeps the same inode, and macOS then kills
it on launch — `Killed: 9`, exit 137 — because the code signature it cached for
that path no longer matches the bytes. The installer writes a temporary file and
renames it, which gives a fresh inode.

[ARCHITECTURE.md](ARCHITECTURE.md) explains how everything fits together and how
each claim about Claude Code's behaviour was verified.
[CONTRIBUTING.md](CONTRIBUTING.md) has the working rules.

## Uninstall

```sh
./install.sh --uninstall     # removes the binary and the weekly launchd agent
```

Then delete the `# >>> claudeswitch >>>` block from your shell rc file. Your
accounts remain in `~/.claudeswitch`; remove that directory to erase them. Sign
each account out first (`cs logout <name>`) if you also want its credential gone
from the Keychain.

## License

MIT — see [LICENSE](LICENSE).
