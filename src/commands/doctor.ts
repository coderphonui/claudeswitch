import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Args, flagBool } from "../core/args.ts";
import { authStatus, claudeVersion, conflictingEnvVars, findClaudeBin } from "../core/claude.ts";
import {
  IDLE_WINDOW_DAYS, RENEW_WARNING_DAYS, daysUntilLoginRequired, defaultDirFingerprint,
  estimatedIdleDaysLeft, needsLiveProbe, needsLogin, readCredentialInfo,
} from "../core/creds.ts";
import {
  ACCOUNTS_DIR, DEFAULT_CLAUDE_DIR, HOME, ROOT, SHARED_DIR, accountConfigJson, accountDir,
} from "../core/paths.ts";
import { listAccounts, loadRegistry, mutateRegistry, orphanDirs, upsertAccount } from "../core/registry.ts";
import { keyIsDetached, securestorageKey } from "../core/securestorage.ts";
import { SHAREABLE_NAMES, describeShare, shareHealth, syncShare } from "../core/share.ts";
import type { AccountRecord, AuthStatus } from "../core/types.ts";
import { lstatSafe, pathExists, relTime, UserError } from "../core/util.ts";
import { HOOK_VERSION, detectShell, rcFileFor } from "../shell/hook.ts";
import { c, out, sym } from "../ui/io.ts";
import { applyStatus } from "./manage.ts";

/** State that would break account isolation if it were ever shared. */
const MUST_BE_PRIVATE = [
  ".credentials.json",
  ".long-lived-token",
  ".claude.json",
  "projects",
  "sessions",
  "history.jsonl",
  "todos",
];

type Level = "ok" | "warn" | "bad" | "note";

interface Check {
  level: Level;
  text: string;
  hint?: string;
}

export function cmdDoctor(args: Args): number {
  const reg = loadRegistry();
  const checks: Check[] = [];
  const deep = flagBool(args, "deep");

  // --- Environment -------------------------------------------------------
  const bin = findClaudeBin();
  if (!bin) {
    checks.push({ level: "bad", text: "`claude` is not on PATH", hint: "Install Claude Code first." });
  } else {
    checks.push({ level: "ok", text: `claude found at ${bin} ${c.dim(claudeVersion() ?? "")}` });
  }

  const shell = detectShell();
  const rc = rcFileFor(shell, HOME);
  const rcText = safeRead(rc);
  if (!rcText.includes("claudeswitch")) {
    checks.push({
      level: "warn",
      text: `no claudeswitch hook found in ${rc}`,
      hint: "Install it: claudeswitch init --install",
    });
  } else {
    const loaded = Number(process.env.CLAUDESWITCH_HOOK_VERSION ?? 0);
    if (loaded === 0) {
      checks.push({
        level: "warn",
        text: `hook is in ${rc} but not loaded in this shell`,
        hint: `Load it: source ${rc}`,
      });
    } else if (loaded < HOOK_VERSION) {
      checks.push({
        level: "warn",
        text: `this shell loaded hook v${loaded}; the binary ships v${HOOK_VERSION}`,
        hint: `Refresh this shell: source ${rc}  (new shells already get the current hook)`,
      });
    } else {
      checks.push({ level: "ok", text: `shell integration active (hook v${loaded})` });
    }
  }

  const conflicts = conflictingEnvVars();
  if (conflicts.length) {
    checks.push({
      level: "warn",
      text: `provider overrides set in this shell: ${conflicts.join(", ")}`,
      hint: "These take precedence over account OAuth. `cs use <account>` clears them.",
    });
  } else {
    checks.push({ level: "ok", text: "no ANTHROPIC_* overrides in this shell" });
  }

  const activeDir = process.env.CLAUDE_CONFIG_DIR;
  const activeSlug = process.env.CLAUDESWITCH_ACCOUNT;
  if (!activeDir) {
    checks.push({ level: "note", text: "this terminal uses Claude Code's default account (~/.claude)" });
  } else if (activeSlug && reg.accounts[activeSlug] && activeDir === accountDir(activeSlug)) {
    checks.push({ level: "ok", text: `this terminal is switched to ${c.bold(activeSlug)}` });
  } else {
    checks.push({
      level: "warn",
      text: `CLAUDE_CONFIG_DIR=${activeDir} is not a claudeswitch account`,
      hint: "Run `cs off` then `cs use <account>`.",
    });
  }

  // --- Layout ------------------------------------------------------------
  for (const [label, p] of [["root", ROOT], ["accounts", ACCOUNTS_DIR], ["shared", SHARED_DIR]] as const) {
    if (pathExists(p)) checks.push({ level: "ok", text: `${label} directory ${c.dim(p)}` });
    else checks.push({ level: "warn", text: `${label} directory missing ${c.dim(p)}`, hint: "Run: claudeswitch repair" });
  }

  const accounts = listAccounts(reg);
  if (!accounts.length) {
    checks.push({ level: "note", text: "no accounts registered", hint: "claudeswitch import  ·  claudeswitch add <name>" });
  }

  // --- Duplicate identities ---------------------------------------------
  const byEmail = new Map<string, string[]>();
  for (const a of accounts) {
    if (!a.email) continue;
    const key = a.email.toLowerCase();
    byEmail.set(key, [...(byEmail.get(key) ?? []), a.slug]);
  }
  for (const [email, slugs] of byEmail) {
    if (slugs.length > 1) {
      checks.push({
        level: "warn",
        text: `${email} is stored in ${slugs.length} accounts: ${slugs.join(", ")}`,
        hint: "Sessions stay separate, but rate limits are shared by the identity.",
      });
    }
  }

  // The failure that forces repeated logins: one credential in two places.
  // Claude Code rotates refresh tokens, so the first directory to refresh
  // invalidates the others, and the losers have their credentials cleared.
  const byFingerprint = new Map<string, string[]>();
  for (const a of accounts) {
    const fp = readCredentialInfo(a.slug).fingerprint;
    if (fp) byFingerprint.set(fp, [...(byFingerprint.get(fp) ?? []), a.slug]);
  }
  let sharedCredentials = false;
  for (const [, slugs] of byFingerprint) {
    if (slugs.length > 1) {
      sharedCredentials = true;
      checks.push({
        level: "bad",
        text: `${slugs.join(" and ")} hold the same credential`,
        hint: "They will invalidate each other on refresh. Give one its own login: claudeswitch login <name>",
      });
    }
  }
  const defaultFp = defaultDirFingerprint(join(DEFAULT_CLAUDE_DIR, ".credentials.json"));
  if (defaultFp) {
    const shared = [...byFingerprint.get(defaultFp) ?? []];
    if (shared.length) {
      sharedCredentials = true;
      checks.push({
        level: "bad",
        text: `${shared.join(", ")} share a credential with Claude Code's own ~/.claude`,
        hint: `Give the account its own login so the two stop competing: claudeswitch login ${shared[0]}`,
      });
    }
  }
  if (accounts.length && !sharedCredentials) {
    checks.push({ level: "ok", text: "every account has its own credential lineage" });
  }

  const orphans = orphanDirs(reg);
  if (orphans.length) {
    checks.push({
      level: "warn",
      text: `directories not in the registry: ${orphans.join(", ")}`,
      hint: "Adopt them: claudeswitch repair --adopt",
    });
  }

  render(checks);

  // --- Per account -------------------------------------------------------
  for (const acc of accounts) {
    out();
    out(`${c.bold(acc.slug)}${acc.label ? "  " + c.dim(acc.label) : ""}  ${c.dim(accountDir(acc.slug))}`);
    render(accountChecks(acc, deep), "  ");
  }

  const worst = checks.some((c2) => c2.level === "bad") ? 2 : 0;
  out();
  out(
    worst
      ? c.red("Some checks failed.")
      : c.dim("Tip: `claudeswitch repair` fixes links and directories; add --deep here to query the API for each account."),
  );
  return worst;
}

function accountChecks(acc: AccountRecord, deep: boolean): Check[] {
  const checks: Check[] = [];
  const dir = accountDir(acc.slug);

  if (!pathExists(dir)) {
    checks.push({ level: "bad", text: "config directory is missing", hint: `claudeswitch add ${acc.slug}` });
    return checks;
  }

  // Isolation is the whole point: private state must never be a link.
  for (const name of MUST_BE_PRIVATE) {
    const st = lstatSafe(join(dir, name));
    if (st?.isSymbolicLink()) {
      checks.push({
        level: "bad",
        text: `${name} is a symlink — this account is NOT isolated`,
        hint: "Delete the link and restore a real copy before using this account.",
      });
    }
  }

  if (pathExists(accountConfigJson(acc.slug))) checks.push({ level: "ok", text: ".claude.json present" });
  else checks.push({ level: "note", text: ".claude.json not created yet (Claude Code writes it on first run)" });

  if (keyIsDetached(acc)) {
    checks.push({
      level: "ok",
      text: "Keychain entry pinned to its original path",
      hint: `${securestorageKey(acc)} — kept deliberately, so the rename did not orphan the credential.`,
    });
  }

  if (acc.aliases?.length) {
    checks.push({ level: "note", text: `also answers to: ${acc.aliases.join(", ")}` });
  }

  const creds = readCredentialInfo(acc.slug);
  if (needsLiveProbe(creds)) {
    // macOS keeps the credential in the Keychain, so only Claude Code can say.
    const live = authStatus(acc.slug);
    if (live.loggedIn) {
      const days = estimatedIdleDaysLeft(acc.lastRefreshedAt ?? acc.lastUsedAt);
      checks.push({
        level: "ok",
        text:
          `logged in via the macOS Keychain${live.email ? c.dim(` · ${live.email}`) : ""}` +
          c.dim(` · about ${days === undefined ? IDLE_WINDOW_DAYS : Math.max(0, days)}d of idleness left`),
      });
    } else {
      checks.push({
        level: "bad",
        text: "not logged in",
        hint: `claudeswitch login ${acc.slug}`,
      });
    }
  } else if (!creds.present) {
    checks.push({ level: "bad", text: "no credentials stored", hint: `claudeswitch login ${acc.slug}` });
  } else if (creds.kind === "long-lived") {
    checks.push({
      level: "ok",
      text: "long-lived token — no expiry to manage",
      hint: "Inference-only scope; run `claudeswitch token <name> --clear` to go back to a full login.",
    });
  } else if (needsLogin(creds)) {
    checks.push({
      level: "bad",
      text: "login expired — it sat unused past its 30-day window",
      hint: `claudeswitch login ${acc.slug}`,
    });
  } else {
    const days = daysUntilLoginRequired(creds);
    const exp = creds.expiresAt ? c.dim(` · access token ${relTime(creds.expiresAt)}`) : "";
    if (days !== undefined && days <= RENEW_WARNING_DAYS) {
      checks.push({
        level: "warn",
        text: `login expires in ${days} day${days === 1 ? "" : "s"} if unused${exp}`,
        hint: `Roll it forward: claudeswitch refresh ${acc.slug}`,
      });
    } else {
      checks.push({
        level: "ok",
        text: `logged in${days !== undefined ? c.dim(` · ${days} days of idleness allowed`) : ""}${exp}`,
      });
    }
  }

  const links = shareHealth(acc.slug, acc.share);
  if (links.ok) {
    checks.push({ level: "ok", text: `shared links healthy ${c.dim(`(${describeShare(acc.share)})`)}` });
  } else {
    checks.push({
      level: "warn",
      text: `broken shared links: ${links.broken.join(", ")}`,
      hint: `claudeswitch repair ${acc.slug}`,
    });
  }

  // Unshared assets that exist locally are fine, but flag surprises.
  const unexpected = SHAREABLE_NAMES.filter((name) => {
    const st = lstatSafe(join(dir, name));
    return st?.isSymbolicLink() && !shareIncludes(acc, name);
  });
  if (unexpected.length) {
    checks.push({
      level: "warn",
      text: `linked but not in the share policy: ${unexpected.join(", ")}`,
      hint: `claudeswitch repair ${acc.slug}`,
    });
  }

  if (deep) {
    const live = authStatus(acc.slug);
    if (live.loggedIn) {
      checks.push({
        level: "ok",
        text: `API says: ${live.email} ${c.dim(`· ${live.orgName ?? "—"} · ${live.subscriptionType ?? "—"}`)}`,
      });
      if (acc.email && live.email && acc.email.toLowerCase() !== live.email.toLowerCase()) {
        checks.push({ level: "warn", text: `registry says ${acc.email} — run repair to refresh metadata` });
      }
    } else {
      checks.push({ level: "bad", text: "API says: not logged in", hint: `claudeswitch login ${acc.slug}` });
    }
  }

  return checks;
}

export function cmdRepair(args: Args): number {
  const reg = loadRegistry();
  const only = args.positionals[0];
  const adopt = flagBool(args, "adopt");
  const refresh = flagBool(args, "refresh");

  // Auth probes and filesystem work happen outside the registry lock: they can
  // take tens of seconds, and holding the lock would stall other terminals.
  const adopted: AccountRecord[] = [];
  if (adopt) {
    for (const slug of orphanDirs(reg)) {
      const record: AccountRecord = {
        slug,
        share: reg.shareDefault,
        createdAt: new Date().toISOString(),
        label: "adopted by repair",
      };
      applyStatus(record, authStatus(slug));
      adopted.push(record);
      reg.accounts[slug] = record;
      out(`${c.green(sym.ok)} adopted ${c.bold(slug)}${record.email ? c.dim(` · ${record.email}`) : ""}`);
    }
  }

  const targets = only ? [reg.accounts[only]].filter(Boolean) : listAccounts(reg);
  if (only && !targets.length) throw new UserError(`No account named "${only}".`);

  const probed = new Map<string, AuthStatus>();
  for (const acc of targets as AccountRecord[]) {
    if (!pathExists(accountDir(acc.slug))) {
      out(`${c.yellow(sym.warn)} ${acc.slug}: directory missing, skipped`);
      continue;
    }
    const actions = syncShare(acc.slug, acc.share);
    const changed = actions.filter((a) => a.kind !== "ok");
    if (refresh) probed.set(acc.slug, authStatus(acc.slug));
    out(
      changed.length
        ? `${c.green(sym.ok)} ${acc.slug}: ${changed.map((a) => `${a.asset} ${a.kind}`).join(", ")}`
        : `${c.dim(sym.ok)} ${acc.slug}: nothing to fix`,
    );
  }

  if (adopted.length || probed.size) {
    mutateRegistry((fresh) => {
      for (const record of adopted) {
        if (!fresh.accounts[record.slug]) upsertAccount(fresh, record);
      }
      for (const [slug, status] of probed) {
        const target = fresh.accounts[slug];
        if (target) applyStatus(target, status);
      }
    });
  }
  return 0;
}

function shareIncludes(acc: AccountRecord, name: string): boolean {
  if (acc.share === "all") return true;
  if (acc.share === "none") return false;
  return acc.share.includes(name);
}

function render(checks: Check[], indent = ""): void {
  for (const check of checks) {
    const badge =
      check.level === "ok" ? c.green(sym.ok)
      : check.level === "warn" ? c.yellow(sym.warn)
      : check.level === "bad" ? c.red(sym.bad)
      : c.dim("·");
    out(`${indent}${badge} ${check.text}`);
    if (check.hint) out(`${indent}  ${c.dim(check.hint)}`);
  }
}

function safeRead(p: string): string {
  try { return readFileSync(p, "utf8"); } catch { return ""; }
}
