# Contributing

Thanks for looking. claudeswitch is small, has no runtime dependencies, and is
meant to stay that way.

## Getting set up

You need [Bun](https://bun.sh) to build, Claude Code on your `PATH`, and macOS.

```sh
git clone https://github.com/coderphonui/claudeswitch.git
cd claudeswitch
bun install
bun run check        # typecheck + lint + build + 86 tests
```

Run from source while you work, so you are not testing a stale binary:

```sh
bun run dev -- ls
bun run dev -- use work --emit-shell
```

To try the real thing end to end, `./install.sh` and open a new shell. Note that
the installer copies through a temporary file and renames it: overwriting a
Mach-O binary in place keeps the same inode, and macOS then kills it on launch
(`Killed: 9`, exit 137) because the signature cached for that path no longer
matches. Do not `cp` over an installed binary.

## Working safely

This tool manages real credentials, and mistakes cost people their logins. A few
rules that came out of getting them wrong:

- **Never experiment on a live account.** Point `CLAUDESWITCH_HOME` at a
  temporary directory instead:

  ```sh
  CLAUDESWITCH_HOME=$(mktemp -d) bun run dev -- add test --no-login
  ```

- **Never copy a credential into a second directory.** Claude Code's refresh
  tokens rotate, so two copies invalidate each other and someone has to log in
  again. See [SECURITY.md](SECURITY.md).
- **Never read a token into a value that could be printed.** Fingerprints only,
  and only where `src/core/creds.ts` already does it.
- **Never rewrite an account's `securestorageKey`.** The macOS Keychain entry is
  derived from it; changing it logs the account out.

## Tests

`scripts/test.sh` is the whole suite: shell-level behavioural tests that run
inside a throwaway `CLAUDESWITCH_HOME` and never touch `~/.claude` or
`~/.claudeswitch`.

```sh
bun run test
```

Add a test for anything you fix. The helpers are `check "description" expected
actual` and `contains "description" needle haystack`, and the aim is one clear
line of output per assertion. Prefer asserting on observable behaviour — emitted
shell code, a file's contents, an exit status — over internals.

Two things to know when writing them:

- Terminal-width assertions must count **characters**, not bytes: the status
  glyphs are multi-byte UTF-8, and `awk length()` gets it wrong.
- Multi-line `case` statements inside `$( )` do not survive every shell here. Use
  `contains` instead.

`scripts/check-value-flags.py` is the lint: it fails if a flag is read with
`flagString()` but missing from `VALUE_FLAGS`, which would make its value parse
as a positional and the command silently fall back to a default.

## Code style

Match what is already there. Some specifics:

- **Comments explain why, not what.** Most comments in this codebase record a
  fact about Claude Code that is not obvious from the code, or a bug that
  motivated the shape of something. If a comment would only restate the line
  below it, leave it out.
- **Errors are for humans.** `UserError` takes a message and an optional hint;
  the hint should contain the command that fixes the problem.
- **No dependencies.** The picker, tables and colours are all hand-rolled on
  purpose. A new runtime dependency needs a strong argument.
- **Adding a flag?** Add it to that command's list in `FLAGS` in `src/cli.ts`, or
  it will be rejected. If it takes a value, add it to `VALUE_FLAGS` too.
- **Adding a command?** Add it to `HANDLERS` and `FLAGS` in `src/cli.ts`, and to
  `PASSTHROUGH_COMMANDS` in `src/core/reserved.ts` unless it changes the shell's
  environment. Words in that list cannot be used as account names or aliases.
- Run `bun run check` before opening a pull request. CI runs the same thing.

## Pull requests

Describe what changed and how you verified it. If you found a Claude Code
behaviour the code did not know about, say how you established it — that
reasoning is worth more than the patch and belongs in
[ARCHITECTURE.md](ARCHITECTURE.md).

Keep unrelated changes in separate pull requests.

## Scope

claudeswitch does one thing: let several Claude Code accounts be used at once,
one per terminal, without them interfering. Things deliberately out of scope:

- Managing third-party providers or gateways. Those are environment variables and
  do not need an account model; claudeswitch clears them so they cannot silently
  override the account you picked.
- Anything that writes to a Claude Code config file on your behalf. Claude Code
  owns that state.
- Linux and Windows. The Keychain handling is macOS-specific. A port is welcome
  but is a real piece of work, not a flag.
