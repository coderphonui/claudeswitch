#!/usr/bin/env bun
import { assertKnownFlags, parseArgs, flagBool, type Args } from "./core/args.ts";
import { ROOT } from "./core/paths.ts";
import { loadRegistry, resolveName } from "./core/registry.ts";
import { UserError } from "./core/util.ts";
import { cmdAlias, cmdUnalias } from "./commands/alias.ts";
import { cmdLogin, cmdLogout } from "./commands/auth.ts";
import { cmdDoctor, cmdRepair } from "./commands/doctor.ts";
import { cmdHandoff } from "./commands/handoff.ts";
import { cmdInit } from "./commands/init.ts";
import { cmdKeepwarm } from "./commands/keepwarm.ts";
import { cmdCurrent, cmdList } from "./commands/list.ts";
import {
  cmdAdd, cmdDefault, cmdImport, cmdLabel, cmdRemove, cmdRename, cmdShare, cmdWhich,
} from "./commands/manage.ts";
import { cmdRefresh } from "./commands/refresh.ts";
import { cmdExec, cmdRun, cmdShell } from "./commands/run.ts";
import { cmdUsage } from "./commands/usage.ts";
import { cmdToken } from "./commands/token.ts";
import { cmdOff, cmdUse } from "./commands/use.ts";
import { c, configureIo, fail, guardBrokenPipes, out, outputClosed } from "./ui/io.ts";

const VERSION = "1.0.0";

/**
 * Options each command accepts, on top of the global ones. Anything else is
 * rejected rather than ignored, so a typo cannot quietly change what happens.
 */
const FLAGS: Record<string, readonly string[]> = {
  "": ["default", "keepEnv"],
  use: ["default", "keepEnv"],
  switch: ["default", "keepEnv"],
  off: [],
  unuse: [],
  ls: ["deep", "wide", "usage"],
  list: ["deep", "wide", "usage"],
  current: ["probe"],
  status: ["probe"],
  add: ["email", "label", "notes", "share", "login", "console", "inheritTrust"],
  new: ["email", "label", "notes", "share", "login", "console", "inheritTrust"],
  import: ["label", "share", "withSessions", "seedShared", "takeCredentials"],
  login: ["email", "console"],
  logout: [],
  rm: ["purge", "yes", "logout", "keepCredentials"],
  remove: ["purge", "yes", "logout", "keepCredentials"],
  delete: ["purge", "yes", "logout", "keepCredentials"],
  rename: [],
  mv: [],
  share: ["default"],
  default: ["clear"],
  which: [],
  label: [],
  alias: ["clear", "show"],
  unalias: [],
  exec: [],
  run: [],
  shell: [],
  handoff: ["from", "session", "move", "yes", "stay", "open"],
  usage: [],
  refresh: ["force", "due"],
  keepwarm: ["install", "uninstall", "everyDays"],
  token: ["clear", "show", "paste"],
  doctor: ["deep"],
  repair: ["adopt", "refresh"],
  init: ["install", "shell", "alias", "auto"],
};

const HANDLERS: Record<string, (args: Args) => number> = {
  "": cmdUse,
  use: cmdUse,
  switch: cmdUse,
  off: cmdOff,
  unuse: cmdOff,
  ls: cmdList,
  list: cmdList,
  current: cmdCurrent,
  status: cmdCurrent,
  add: cmdAdd,
  new: cmdAdd,
  import: cmdImport,
  login: cmdLogin,
  logout: cmdLogout,
  rm: cmdRemove,
  remove: cmdRemove,
  delete: cmdRemove,
  rename: cmdRename,
  mv: cmdRename,
  share: cmdShare,
  default: cmdDefault,
  which: cmdWhich,
  label: cmdLabel,
  alias: cmdAlias,
  unalias: cmdUnalias,
  exec: cmdExec,
  run: cmdRun,
  shell: cmdShell,
  handoff: cmdHandoff,
  usage: cmdUsage,
  refresh: cmdRefresh,
  keepwarm: cmdKeepwarm,
  token: cmdToken,
  doctor: cmdDoctor,
  repair: cmdRepair,
  init: cmdInit,
};

function main(argv: string[]): number {
  guardBrokenPipes();
  const args = parseArgs(argv);

  const emit = process.env.CLAUDESWITCH_SHELL_HOOK === "1" || flagBool(args, "emitShell");
  configureIo({ emit, color: args.flags.color === false ? false : undefined });

  if (flagBool(args, "version") || flagBool(args, "V") || args.cmd === "version") {
    out(`claudeswitch ${VERSION}`);
    return 0;
  }
  if (args.cmd === "help" || (flagBool(args, "help") && !args.cmd) || flagBool(args, "h")) {
    printHelp(args.positionals[0]);
    return 0;
  }
  if (flagBool(args, "help")) {
    printHelp(args.cmd);
    return 0;
  }

  const handler = HANDLERS[args.cmd];
  if (handler) {
    assertKnownFlags(args, FLAGS[args.cmd] ?? []);
    return handler(args);
  }

  // Not a command: `cs work` and `cs w` are shorthand for `cs use work`.
  const account = resolveName(loadRegistry(), args.cmd);
  if (account) {
    const asUse: Args = { ...args, cmd: "use", positionals: [account.slug, ...args.positionals] };
    assertKnownFlags(asUse, FLAGS.use ?? []);
    return cmdUse(asUse);
  }

  fail(`Unknown command or account: ${args.cmd}`);
  out();
  printHelp();
  return 64;
}

function printHelp(topic?: string): void {
  if (topic && TOPICS[topic]) {
    out(TOPICS[topic]!().trim());
    return;
  }
  out(`${c.bold("claudeswitch")} ${c.dim(VERSION)} — run several Claude Code accounts side by side.

${c.bold("USAGE")}
  cs                        pick an account for this terminal ${c.dim("(↑↓, type to filter)")}
  cs <account>              same thing, spelled shorter
  cs use <account>          switch this terminal only
  cs off                    back to Claude Code's default account
  cs ls                     list accounts ${c.dim("(--usage, --wide, --deep, --json)")}
  cs current                what this terminal is signed in as ${c.dim("(--json)")}

${c.bold("ACCOUNTS")}
  cs import [name]          adopt the account already in ~/.claude ${c.dim("(--with-sessions)")}
  cs add <name>             create an account and log in ${c.dim("(--email, --console, --no-login)")}
  cs login <name>           re-authenticate an account
  cs logout <name>          drop its credentials, keep its history
  cs rm <name>              archive and unregister ${c.dim("(--purge to delete)")}
  cs rename <old> <new>     rename an account
  cs label <name> <text>    set a note shown in listings
  cs alias <name> <alias…>  add short names to type instead ${c.dim("(--clear)")}
  cs unalias <alias…>       remove an alias
  cs default [name]         account for new shells ${c.dim("(--clear)")}

${c.bold("WITHOUT SWITCHING")}
  cs run <name> [args…]     run claude as that account
  cs exec <name> -- <cmd>   run any command as that account
  cs shell <name>           open a subshell pinned to that account
  cs which [name]           print the account's CLAUDE_CONFIG_DIR

${c.bold("CONTINUING A SESSION")}
  cs handoff <name>         switch and resume this project's chat on another account ${c.dim("(--session, --from, --move, --no-open, --stay)")}

${c.bold("CONFIG SHARING")}
  cs share                  what can be shared, and each account's policy
  cs share <name> <policy>  all | none | skills,plugins,…
  cs share --default <p>    policy for new accounts

${c.bold("QUOTA")}
  cs usage [name]           5-hour and weekly limits, and when they reset ${c.dim("(--json)")}

${c.bold("STAYING LOGGED IN")}
  cs refresh [name]         roll the 30-day idle deadline forward ${c.dim("(--force, --due)")}
  cs keepwarm --install     do that on a schedule so logins never lapse
  cs token <name>           swap in a long-lived token ${c.dim("(--clear, --show)")}

${c.bold("MAINTENANCE")}
  cs doctor                 health check ${c.dim("(--deep)")}
  cs repair [name]          fix links and metadata ${c.dim("(--adopt, --refresh)")}
  cs init                   print the shell hook ${c.dim("(--install, --shell, --alias, --auto)")}

${c.bold("STATE")}  ${c.dim(ROOT)}

${c.dim("More detail:")} cs help usage ${c.dim("·")} cs help tokens ${c.dim("·")} cs help aliases ${c.dim("·")} cs help isolation ${c.dim("·")} cs help sharing ${c.dim("·")} cs help shell ${c.dim("·")} cs help handoff`);
}

// Built lazily so colour settings are already resolved.
const TOPICS: Record<string, () => string> = {
  usage: () => `
${c.bold("Quota: the 5-hour and weekly windows")}

  cs usage              every account
  cs usage work         one account
  cs usage --json       machine-readable
  cs ls --usage         a compact column in the account list

Claude Code meters a subscription in overlapping windows — a 5-hour session
window, a rolling week, and on some plans a separate weekly budget per model —
plus extra usage credits when those are enabled. ${c.cyan("cs usage")} shows all of them per
account with the time remaining.

${c.bold("The quota belongs to the account, not to this machine")}

Anthropic meters the identity. Using an account anywhere — another terminal,
another machine, claude.ai, or a second claudeswitch account holding the same
login — consumes the same windows. There is no per-directory allowance.

What is per-directory is the ${c.bold("recording")}. Claude Code fetches usage from its API and
caches the result in each config directory's .claude.json; claudeswitch reads
that cache. So the numbers are accurate as of their timestamp, which is always
shown, and usage burned elsewhere since then is counted by Anthropic but not yet
visible here.

Two things soften that. A reading recorded by any directory signed in as the same
identity is used, freshest first, and its origin is named — so an account you have
never opened ${c.cyan("/usage")} in can still show real numbers if a sibling account or
~/.claude has them. And a window whose reset time has already passed is reported
as rolled over rather than shown at its old percentage, because that number
describes a window which no longer exists.

${c.bold("Why claudeswitch does not just ask the API")}

Fetching would mean reading the account's access token out of the macOS Keychain,
and this tool never reads a token. See SECURITY.md.

The cost is coverage: Claude Code fetches usage only when its own interface needs
it — opening ${c.cyan("/usage")}, or running into a limit. A ${c.cyan("claude -p")} run does not fetch it. So
a new account shows nothing until you have looked at usage inside it once:

  cs use work           then run /usage in Claude Code

${c.bold("Reading the output")}

The bar and percentage are coloured by how close the limit is, not by which limit
it is — what matters at a glance is whether you are about to be cut off. Claude
Code ignores its own cache once it is an hour old, so anything older is marked as
a historical reading, and ${c.cyan("cs ls --usage")} prefixes it with "~".

That column shows only the tightest window still in force, since that is the one
that will actually stop you. Use ${c.cyan("cs usage")} to see them all.
`,
  tokens: () => `
${c.bold("Logins, tokens, and why switchers make you re-authenticate")}

Claude Code holds two tokens per account:

  access token    about 1 hour. Refreshed silently; you never see it.
  refresh token   30 days. Used to mint access tokens.

The 30 days run from ${c.bold("last use")}, not from login: every refresh issues a brand-new
refresh token with a fresh 30-day life. An account you touch monthly therefore
never needs an interactive login. Claude Code warns at three days left.

Neither lifetime can be extended — the server sets them, and no environment
variable changes that.

${c.bold("Where the credential actually lives")}

On macOS it is in the login Keychain, not in a file, and the entry is namespaced:

  service = "Claude Code-credentials-" + sha256(config dir).slice(0, 8)
  account = $USER

Per-directory entries are what let several accounts work at once, and the secret
stays encrypted instead of sitting in plaintext. But the entry is keyed by the
directory ${c.bold("path")}, so renaming an account would orphan its credentials and log it
out. Every account therefore carries a fixed key that claudeswitch exports as
CLAUDE_SECURESTORAGE_CONFIG_DIR on each switch, so renames and a relocated
~/.claudeswitch are both safe. ${c.cyan("cs current")} shows the entry in use.

One consequence: the exact expiry date is sealed in the Keychain, so ${c.cyan("cs ls")} shows
an idle budget estimated from the last activity it saw, marked with a "~".

${c.bold("The real reason switchers keep asking you to log in")}

Refresh tokens ${c.bold("rotate")}: using one invalidates it and returns a replacement. If the
same refresh token exists in two places, the first to refresh invalidates the
other, and the loser is left with a credential the server rejects.

Tools that switch accounts by copying credentials into place create exactly that
situation. claudeswitch does not copy them: ${c.cyan("cs import")} brings your settings over
and has the account log in for itself, so each owns its own token lineage.
${c.cyan("cs doctor")} compares credential fingerprints — never the tokens — and fails loudly
if two accounts ever share one.

${c.bold("Staying logged in forever")}

  cs refresh              roll every account's window forward now
  cs refresh work         just that one
  cs keepwarm --install   weekly, in the background, via launchd
  cs keepwarm             show whether it is running, and the recent log

A refresh needs one short authenticated request, because the token endpoint is
only contacted once the access token has expired — ${c.cyan("claude auth status")} reads the
stored credential and renews nothing. Each refresh costs a couple of tokens, and
only for accounts idle longer than an hour.

${c.bold("Long-lived tokens")}

  cs token work           mint one with claude setup-token and store it
  cs token work --clear   go back to a normal login

These never expire on a schedule, so the 30-day question disappears. The cost is
scope: Claude Code limits them to inference only, where a normal login also
carries user:profile, user:file_upload, user:mcp_servers and
user:sessions:claude_code. Remote Control, for one, refuses to work on them.
Prefer ${c.cyan("cs keepwarm")} unless you specifically need an unattended token.
`,
  aliases: () => `
${c.bold("Aliases")}

An account's name is also the name of its directory, so renaming it moves state
around. An alias is just another way to type it, and you can have as many as you
like:

  cs alias work w              ${c.dim("`cs w` now switches to work")}
  cs alias personal p me       ${c.dim("two aliases at once")}
  cs alias work                ${c.dim("show what work answers to")}
  cs alias                     ${c.dim("show every alias")}
  cs unalias w                 ${c.dim("remove one")}
  cs alias work --clear        ${c.dim("remove all of an account's aliases")}

Anywhere an account name is accepted, an alias works too:

  cs w                         cs use w
  cs run w -p "hi"             cs share w none
  cs which w                   cs login w

Aliases are only labels: they never move a directory and never touch
credentials. To change the canonical name — and the directory under
~/.claudeswitch/accounts — use ${c.cyan("cs rename <old> <new>")} instead.

An alias cannot collide with an account name, with another alias, or with a
claudeswitch command, because ${c.cyan("cs <word>")} has to stay unambiguous.
`,
  isolation: () => `
${c.bold("How isolation works")}

Claude Code reads all of its state from one directory. Point CLAUDE_CONFIG_DIR at
a different directory and you get a completely separate installation: its own
credentials, its own conversation history, its own trusted folders.

  ~/.claudeswitch/accounts/work/       ← one account
  ~/.claudeswitch/accounts/personal/   ← another

Environment variables belong to a process, not to the machine, so \`cs use work\`
in one terminal cannot affect a terminal that ran \`cs use personal\`. Both can run
Claude Code at the same time, indefinitely, with no file contention: they never
touch the same credential file, session store, or history.

That is the whole trick, and it is why this tool does not copy credentials around
the way most switchers do. Nothing is swapped in place, so nothing can be
corrupted by switching while another session is live.

${c.bold("Kept private per account")}
  .credentials.json   OAuth tokens
  .claude.json        identity, trusted folders, MCP servers, onboarding state
  projects/ sessions/ history.jsonl todos/ file-history/

${c.dim("\`cs doctor\` fails loudly if any of these ever becomes a symlink.")}
`,
  sharing: () => `
${c.bold("Sharing configuration between accounts")}

Isolation is about identity, not about your settings. Your skills and hooks are
yours no matter which account pays for the tokens, so they can be shared:

  ~/.claudeswitch/shared/settings.json   ← one real file
  ~/.claudeswitch/accounts/work/settings.json      → symlink
  ~/.claudeswitch/accounts/personal/settings.json  → symlink

Shareable: settings.json, CLAUDE.md, keybindings.json, skills/, plugins/,
agents/, commands/, hooks/, output-styles/

Each account chooses its own policy:

  cs share work none                 fully isolated sandbox
  cs share personal all              everything shared
  cs share client-a skills,plugins   just those two

Claude Code occasionally rewrites settings.json by replacing the file, which
breaks a symlink. Every ${c.cyan("cs use")} re-checks the links and repairs them, and it
never throws your edits away: a newer real file is promoted into shared/, an
older one is copied into ~/.claudeswitch/archive/ first.

MCP servers live inside .claude.json and are therefore per-account by design.
`,
  shell: () => `
${c.bold("Shell integration")}

A program cannot change its parent shell's environment, so ${c.cyan("cs")} is a shell
function that evaluates what the binary prints:

  eval "$(claudeswitch init)"

${c.cyan("cs init --install")} appends that line to your rc file between markers.

  --shell zsh|bash|fish   pick the shell (default: $SHELL)
  --alias cs              name for the short alias
  --auto                  activate the default account in every new shell

Show the active account in your prompt (zsh):

  setopt PROMPT_SUBST
  RPROMPT='%F{cyan}$(claudeswitch_prompt)%f'

${c.dim("claudeswitch_prompt reads a variable — it starts no subprocess.")}

Without the hook, everything still works:

  cs run work                    launch claude as that account
  cs exec work -- npm test       any command
  cs shell work                  a pinned subshell
`,
  handoff: () => `
${c.bold("Continuing a session on another account")}

  cs handoff <account>              hand this project's chat to that account

Run it from inside the project, in the same terminal the session ran in — the
common case is the account you were just using hit a rate limit. It finds the
Claude Code session for the current directory, copies its transcript into the
target account, switches this terminal to it, and opens ${c.cyan("claude --resume")} right
there — one command to get back to exactly where you left off, on an account
that still has quota.

That last step works even though this process's own output is normally
swallowed by \`eval "$(...)"\`: the launch line rides along with the exported
variables and only actually runs once the shell's \`eval\` gets to it, in the
caller's real shell — by which point the capture around this process has
already finished. Pass ${c.cyan("--no-open")} to only switch and print the command instead.

${c.bold("How it finds the right session")}

Claude Code stamps every line of a transcript with the directory it was run
from. ${c.cyan("cs handoff")} reads that instead of guessing at Claude Code's own naming
scheme for the projects/ directory, and copies the transcript into the target
account under the identical directory name — the one Claude Code already
chose for this project — so ${c.cyan("claude --resume")} finds it in the new account exactly
where it would have found it in the old one.

  --from <account>   read the session from there instead of this terminal's
                      current account (or ~/.claude if neither is set)
  --session <id>      which one, if more than one session matches this
                      directory — a prefix is enough
  --move               remove it from the source once copied
  --yes                 skip the confirmation prompt
  --no-open             switch and print the resume command, but don't run it
  --stay                copy only; do not switch this terminal, and don't open

${c.bold("Why it asks first")}

Every other command in this tool protects account isolation — projects/ is
deliberately private, listed in ${c.cyan("cs help isolation")}. ${c.cyan("cs handoff")} is the one
command that deliberately crosses that boundary, copying a conversation's
content to a different identity. That is the entire point, but it is still
worth a confirmation: anyone signed into the target account can read it.

${c.bold("What does not come along")}

Only the transcript moves. Claude Code's per-message file-edit snapshots (used
by /rewind) and its shell/session bookkeeping stay behind — neither is needed
to keep talking, and reconstructing them would mean guessing at storage
formats this tool has not verified.
`,
};

/**
 * `process.exitCode` rather than `process.exit`: writes to a piped stdout are
 * buffered, and exiting immediately can truncate them — `cs ls --json | jq`
 * would lose its tail. Nothing here keeps the event loop alive, so the process
 * still ends as soon as main returns.
 */
process.exitCode = (() => {
  try {
    return main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UserError) {
      fail(err.message);
      if (err.hint) {
        for (const line of err.hint.split("\n")) out(`  ${c.dim(line)}`);
      }
      return 1;
    }
    // Nothing useful can be reported once the output is gone; the reader
    // (`| head -1`) has already got what it asked for.
    if (outputClosed()) return 0;
    fail(err instanceof Error ? err.message : String(err));
    if (process.env.CLAUDESWITCH_DEBUG) out(String((err as Error)?.stack ?? ""));
    return 1;
  }
})();
