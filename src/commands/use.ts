import { type Args, flagBool } from "../core/args.ts";
import { authStatus, conflictingEnvVars } from "../core/claude.ts";
import {
  RENEW_WARNING_DAYS, daysUntilLoginRequired, knownLoginState, needsLiveProbe, needsLogin,
  readCredentialInfo, readLongLivedToken,
} from "../core/creds.ts";
import { accountDir } from "../core/paths.ts";
import { getAccount, listAccounts, loadRegistry, touchAccount } from "../core/registry.ts";
import { securestorageKey } from "../core/securestorage.ts";
import { syncShare, type SyncAction } from "../core/share.ts";
import { pathExists, relTime, UserError } from "../core/util.ts";
import { ENV_VARS, detectShell, exportCode, unsetCode } from "../shell/hook.ts";
import { c, emit, info, isEmitMode, out, success, warn } from "../ui/io.ts";
import { pick, ttyAvailable } from "../ui/picker.ts";

/**
 * `extra`: shell code lines to run after the exports, only when a hook is
 * active to eval them — used by `cs handoff --open` to launch `claude
 * --resume` in the same breath as switching, still connected to the real
 * terminal because `eval` runs it in the caller's shell, after the capturing
 * `$(...)` around this process's own stdout has already finished.
 */
export function cmdUse(args: Args, extra: string[] = []): number {
  const reg = loadRegistry();
  const quiet = flagBool(args, "quiet");
  let slug = args.positionals[0];

  if (flagBool(args, "default")) {
    if (!reg.defaultAccount) {
      if (quiet) return 0;
      throw new UserError("No default account is set.", "Set one: claudeswitch default <name>");
    }
    slug = reg.defaultAccount;
  }

  if (!slug) {
    const chosen = choose(reg);
    if (!chosen) {
      if (!quiet) info("Cancelled — nothing changed.");
      return 0;
    }
    slug = chosen;
  }

  const acc = getAccount(reg, slug);
  const dir = accountDir(acc.slug);
  if (!pathExists(dir)) {
    throw new UserError(
      `Account "${acc.slug}" is registered but its directory is missing.`,
      `Recreate it: claudeswitch add ${acc.slug}   ·   or drop it: claudeswitch rm ${acc.slug}`,
    );
  }

  const actions = syncShare(acc.slug, acc.share);
  if (!quiet) reportShare(actions);

  // One probe, for the account being switched to. It makes the warning below
  // accurate for a Keychain-backed credential, and leaves the answer cached so
  // the picker — which must stay instant — has something true to show. Skipped
  // under --quiet, which is the shell-startup path.
  const creds = readCredentialInfo(acc.slug);
  if (!quiet && needsLiveProbe(creds)) {
    const live = authStatus(acc.slug);
    if (!live.loggedIn) {
      warn(`"${acc.slug}" is not logged in.`);
      info(`Log in now: claudeswitch login ${acc.slug}`);
    }
  } else if (!creds.present) {
    warn(`No credentials stored for "${acc.slug}" — Claude Code will ask you to log in.`);
    info(`Log in now: claudeswitch login ${acc.slug}`);
  } else if (needsLogin(creds)) {
    warn(`The login for "${acc.slug}" has expired — it sat unused past its 30-day window.`);
    info(`Re-authenticate: claudeswitch login ${acc.slug}`);
  } else if (!quiet) {
    const daysLeft = daysUntilLoginRequired(creds);
    if (daysLeft !== undefined && daysLeft <= RENEW_WARNING_DAYS) {
      warn(`This login expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"} if left unused.`);
      info(`Roll it forward now: claudeswitch refresh ${acc.slug}`);
    }
  }

  touchAccount(acc.slug);

  const shell = detectShell();
  const vars: Record<string, string> = {
    CLAUDE_CONFIG_DIR: dir,
    // Pins the macOS Keychain entry to a value that never moves, so a rename or
    // a relocated ~/.claudeswitch cannot orphan this account's credentials.
    CLAUDE_SECURESTORAGE_CONFIG_DIR: securestorageKey(acc),
    CLAUDESWITCH_ACCOUNT: acc.slug,
    CLAUDESWITCH_EMAIL: acc.email ?? "",
    CLAUDESWITCH_PLAN: acc.subscriptionType ?? "",
  };

  // Claude Code reads a long-lived token from the environment only.
  const longLived = readLongLivedToken(acc.slug);
  if (longLived) vars.CLAUDE_CODE_OAUTH_TOKEN = longLived;

  const conflicts = conflictingEnvVars();
  const keepEnv = flagBool(args, "keepEnv");
  const code: string[] = [exportCode(vars, shell)];
  if (!longLived && process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    // Left over from an account that does use one; it would override this login.
    code.push(unsetCode(["CLAUDE_CODE_OAUTH_TOKEN"], shell));
  }
  if (conflicts.length && !keepEnv) {
    code.push(unsetCode(conflicts, shell));
  }

  if (isEmitMode()) {
    if (!quiet) {
      success(`${c.bold(acc.slug)} ${c.dim("·")} ${acc.email ?? c.dim("not logged in")}${planTag(acc.subscriptionType)}`);
      if (conflicts.length && !keepEnv) {
        info(`Cleared provider override${conflicts.length > 1 ? "s" : ""}: ${conflicts.join(", ")}`);
      } else if (conflicts.length) {
        warn(`Kept ${conflicts.join(", ")} — these override OAuth, so Claude Code may not use this account.`);
      }
    }
    // `extra` runs after the exports above, in the same eval — the exports
    // land in the caller's shell first, so a launched `claude` picks them up.
    emit([...code, ...extra].join("\n"));
    return 0;
  }

  // No shell hook: this process cannot change its parent's environment.
  warn("Shell integration is not active, so this terminal was not switched.");
  out();
  out(`  ${c.bold("Switch this terminal now:")}`);
  out(`    ${c.cyan(`eval "$(claudeswitch use ${acc.slug} --emit-shell)"`)}`);
  out();
  out(`  ${c.bold("Or install the hook once (recommended):")}`);
  out(`    ${c.cyan("claudeswitch init --install")}`);
  out();
  return 1;
}

export function cmdOff(args: Args): number {
  const shell = detectShell();
  const quiet = flagBool(args, "quiet");
  const active = process.env.CLAUDESWITCH_ACCOUNT;

  if (isEmitMode()) {
    emit(unsetCode(ENV_VARS, shell));
    if (!quiet) {
      success(
        active
          ? `Left ${c.bold(active)} — back to Claude Code's default account.`
          : "Back to Claude Code's default account.",
      );
    }
    return 0;
  }

  warn("Shell integration is not active, so this terminal was not changed.");
  out(`  Run: ${c.cyan(`eval "$(claudeswitch off --emit-shell)"`)}`);
  return 1;
}


function choose(reg: ReturnType<typeof loadRegistry>): string | null {
  const accounts = listAccounts(reg);
  if (!accounts.length) {
    throw new UserError(
      "No accounts yet.",
      "Import the one you are already using: claudeswitch import\nThen add more:            claudeswitch add <name>",
    );
  }
  if (!ttyAvailable()) {
    throw new UserError(
      "An account name is required when there is no terminal to prompt on.",
      `Available: ${accounts.map((a) => a.slug).join(", ")}`,
    );
  }
  const activeSlug = process.env.CLAUDESWITCH_ACCOUNT;
  // Most recently used first: switching back to the account you just left is
  // the common case, so put the cursor there rather than on an alphabetical
  // first row that may be one you never touch.
  const ordered = [...accounts].sort((a, b) => {
    const ta = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0;
    const tb = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0;
    return tb !== ta ? tb - ta : a.slug.localeCompare(b.slug);
  });

  return pick(
    ordered.map((a) => {
      // Deliberately no probe here: `cs` is the command typed most often, and
      // `claude auth status` costs ~200ms per account. What is known cheaply is
      // shown; what is not is left blank rather than guessed at.
      const state = knownLoginState(readCredentialInfo(a.slug), a);
      return {
        value: a.slug,
        active: a.slug === activeSlug,
        tone: state === "logged-out" || state === "expired" ? ("warn" as const) : undefined,
        cells: [
          a.slug,
          a.aliases?.length ? a.aliases.join(", ") : "",
          state === "logged-out" ? "needs login" : state === "expired" ? "login expired" : (a.email ?? "—"),
          a.subscriptionType ?? "",
          a.lastUsedAt ? relTime(Date.parse(a.lastUsedAt)) : "never used",
          a.label ?? "",
        ],
      };
    }),
    {
      title: "Switch Claude account",
      styles: [(s) => s, c.cyan, (s) => s, c.dim, c.dim, c.dim],
      initial: ordered.findIndex((a) => a.slug !== activeSlug),
    },
  );
}

function planTag(plan?: string): string {
  return plan ? " " + c.dim(`(${plan})`) : "";
}

function reportShare(actions: SyncAction[]): void {
  for (const a of actions) {
    switch (a.kind) {
      case "promoted":
        warn(`${a.asset} had been replaced by a real file; promoted it into shared/ (old copy: ${a.backup}).`);
        break;
      case "archived":
        warn(`${a.asset} was not a link; moved the local copy to ${a.backup} and relinked to shared/.`);
        break;
      case "seeded":
        info(`Moved this account's ${a.asset} into shared/ and linked it.`);
        break;
      case "relinked":
        info(`Repaired the shared link for ${a.asset}.`);
        break;
      case "unshared":
        info(`${a.asset} is no longer shared; this account now has its own copy.`);
        break;
      default:
        break;
    }
  }
}

