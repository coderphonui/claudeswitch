import { renameSync } from "node:fs";
import { join } from "node:path";
import { type Args, flagBool, flagString } from "../core/args.ts";
import { authLogin, authLogout, authStatus, authStatusDefault, requireClaudeBin } from "../core/claude.ts";
import { readCredentialInfo } from "../core/creds.ts";
import {
  ACCOUNTS_DIR, ARCHIVE_DIR, DEFAULT_CLAUDE_DIR, DEFAULT_CLAUDE_JSON,
  SHARED_DIR, accountConfigJson, accountCredentials, accountDir,
} from "../core/paths.ts";
import {
  findByEmail, getAccount, listAccounts, loadRegistry, mutateRegistry, upsertAccount,
} from "../core/registry.ts";
import { SHAREABLE, describeShare, parseSharePolicy, resolveShare, syncShare } from "../core/share.ts";
import type { AccountRecord, AuthStatus, SharePolicy } from "../core/types.ts";
import {
  assertSlug, copyPath, type CopySkip, ensureDir, pathExists, readJson, removePath, slugify,
  timestamp, UserError, writeJsonAtomic,
} from "../core/util.ts";
import { c, info, out, success, warn } from "../ui/io.ts";
import { confirm, prompt, ttyAvailable } from "../ui/picker.ts";

/** Private per-account state that must never be shared between identities. */
const PRIVATE_PATHS = [
  ".credentials.json",
  "projects",
  "sessions",
  "history.jsonl",
  "todos",
  "file-history",
  "shell-snapshots",
  "statsig",
  "session-env",
  "tasks",
];

export function cmdAdd(args: Args): number {
  requireClaudeBin();
  const reg = loadRegistry();
  let slug = args.positionals[0];
  if (!slug) {
    if (!ttyAvailable()) throw new UserError("Usage: claudeswitch add <name> [--email you@example.com]");
    slug = prompt(`${c.bold("Account name")} ${c.dim("(e.g. work, personal, client-a):")} `) ?? "";
    slug = slug.trim();
  }
  assertSlug(slug);
  if (reg.accounts[slug]) {
    throw new UserError(`Account "${slug}" already exists.`, `Log in again with: claudeswitch login ${slug}`);
  }

  const share = resolvePolicyFlag(args, reg.shareDefault);
  const dir = accountDir(slug);
  if (pathExists(dir)) {
    warn(`Reusing the existing directory ${dir}`);
  }
  ensureDir(dir);
  seedConfigJson(slug, flagBool(args, "inheritTrust"));
  syncShare(slug, share);
  info(`Created ${c.bold(dir)} ${c.dim(`(shared: ${describeShare(share)})`)}`);

  const record: AccountRecord = {
    slug,
    label: flagString(args, "label"),
    share,
    // Pinned now, before anything can rename the directory out from under the
    // Keychain entry Claude Code is about to create.
    securestorageKey: dir,
    createdAt: new Date().toISOString(),
    notes: flagString(args, "notes"),
  };

  if (flagBool(args, "login", true)) {
    out();
    info(`Opening the Claude login flow for ${c.bold(slug)}…`);
    out(c.dim("  A browser window opens. Sign in with the account you want to store here."));
    out();
    const code = authLogin(slug, {
      email: flagString(args, "email"),
      console: flagBool(args, "console"),
    });
    if (code !== 0) {
      warn("Login did not complete. The account directory was kept, so you can retry:");
      out(`  ${c.cyan(`claudeswitch login ${slug}`)}`);
    }
    applyStatus(record, authStatus(slug));
    const dupe = record.email ? findByEmail(reg, record.email) : undefined;
    if (dupe && dupe.slug !== slug) {
      warn(`${record.email} is already stored as "${dupe.slug}".`);
      out(c.dim("  Two directories holding the same identity is allowed but rarely what you want."));
    }
  } else {
    info(`Skipped login. Run ${c.cyan(`claudeswitch login ${slug}`)} when you are ready.`);
  }

  mutateRegistry((fresh) => {
    if (fresh.accounts[record.slug]) {
      throw new UserError(`Another process registered "${record.slug}" while this login was in progress.`);
    }
    upsertAccount(fresh, record);
    if (!fresh.defaultAccount) fresh.defaultAccount = record.slug;
  });

  out();
  success(`Added ${c.bold(slug)}${record.email ? ` ${c.dim("·")} ${record.email}` : ""}`);
  out(`  ${c.dim("Use it in this terminal:")} ${c.cyan(`cs use ${slug}`)}`);
  return 0;
}

export function cmdImport(args: Args): number {
  const reg = loadRegistry();
  if (!pathExists(DEFAULT_CLAUDE_DIR)) {
    throw new UserError(`No default Claude Code config found at ${DEFAULT_CLAUDE_DIR}.`);
  }

  const live = authStatusDefault();
  let slug = args.positionals[0];
  if (!slug) {
    const guess = live.email ? slugify(live.email.split("@")[0] ?? "main") : "main";
    slug = guess;
  }
  assertSlug(slug);
  if (reg.accounts[slug]) throw new UserError(`Account "${slug}" already exists.`);

  const share = resolvePolicyFlag(args, reg.shareDefault);
  const dir = accountDir(slug);
  ensureDir(dir);
  const skipped: CopySkip[] = [];

  // Seed shared/ from the existing setup so every account inherits it.
  const seedShared = flagBool(args, "seedShared", isEmptyShared());
  if (seedShared) {
    for (const asset of resolveShare(share)) {
      const from = join(DEFAULT_CLAUDE_DIR, asset.name);
      const to = join(SHARED_DIR, asset.name);
      if (pathExists(from) && !pathExists(to)) {
        copyPath(from, to, skipped);
        info(`Seeded shared/${asset.name} from ~/.claude`);
      }
    }
  }

  // Credentials are deliberately NOT copied. Claude Code's refresh tokens
  // rotate: the first copy to refresh invalidates every other copy, and the
  // losers have their credentials cleared and demand an interactive login. Two
  // directories must never hold one token lineage, so each account logs in for
  // itself. `--take-credentials` moves them instead, which is also safe.
  const credsFrom = join(DEFAULT_CLAUDE_DIR, ".credentials.json");
  const take = flagBool(args, "takeCredentials");
  let credentialsMoved = false;
  if (take && pathExists(credsFrom)) {
    copyPath(credsFrom, accountCredentials(slug), skipped);
    removePath(credsFrom);
    credentialsMoved = true;
    info(`Moved credentials into ${slug} — ~/.claude is now logged out.`);
  }

  if (pathExists(DEFAULT_CLAUDE_JSON)) {
    copyPath(DEFAULT_CLAUDE_JSON, accountConfigJson(slug), skipped);
    info("Copied ~/.claude.json (onboarding state, trusted folders, MCP servers).");
  }

  if (flagBool(args, "withSessions")) {
    for (const name of ["projects", "sessions", "history.jsonl", "todos", "file-history"]) {
      const from = join(DEFAULT_CLAUDE_DIR, name);
      if (pathExists(from)) {
        copyPath(from, join(dir, name), skipped);
        info(`Copied ${name}`);
      }
    }
  }

  syncShare(slug, share);
  reportSkips(skipped);

  const record: AccountRecord = {
    slug,
    label: flagString(args, "label") ?? "imported from ~/.claude",
    share,
    securestorageKey: dir,
    createdAt: new Date().toISOString(),
  };
  applyStatus(record, credentialsMoved ? authStatus(slug) : live);
  mutateRegistry((fresh) => {
    upsertAccount(fresh, record);
    if (!fresh.defaultAccount) fresh.defaultAccount = record.slug;
  });

  out();
  success(`Imported settings as ${c.bold(slug)}`);
  if (!flagBool(args, "withSessions")) {
    out(`  ${c.dim("Want its chat history too? Re-run with")} ${c.cyan("--with-sessions")}`);
  }

  if (credentialsMoved) {
    out(c.dim("  Credentials were moved, so ~/.claude no longer has a login of its own."));
    out(`  ${c.dim("Use it:")} ${c.cyan(`cs use ${slug}`)}`);
    return 0;
  }

  out();
  out(`  ${c.bold("This account still needs its own login:")} ${c.cyan(`cs login ${slug}`)}`);
  out(c.dim("  Credentials are not copied on purpose. Claude Code rotates refresh tokens, so"));
  out(c.dim("  two directories sharing one token would invalidate each other and force"));
  out(c.dim(`  repeated logins. ${"cs help tokens"} explains it.`));
  return 0;
}

export function cmdRemove(args: Args): number {
  const reg = loadRegistry();
  const slug = args.positionals[0];
  if (!slug) throw new UserError("Usage: claudeswitch rm <name> [--purge]");
  const acc = getAccount(reg, slug);
  const purge = flagBool(args, "purge");
  const dir = accountDir(slug);

  if (!flagBool(args, "yes") && ttyAvailable()) {
    const what = purge ? c.red("permanently delete") : "archive";
    if (!confirm(`${what} account ${c.bold(slug)}${acc.email ? ` (${acc.email})` : ""}?`)) {
      info("Cancelled.");
      return 1;
    }
  }

  // Removing the directory does not remove the credential: on macOS it lives in
  // the login Keychain under a service name derived from this account's pinned
  // key, and would otherwise sit there indefinitely with nothing pointing at it.
  const loggedIn = authStatus(acc.slug).loggedIn;
  if (loggedIn) {
    const alsoLogout = flagBool(args, "keepCredentials")
      ? false
      : flagBool(args, "logout")
        ? true
        : ttyAvailable()
          ? confirm(`  Also sign it out, clearing its credential from the Keychain?`, true)
          : true;
    if (alsoLogout) {
      const code = authLogout(acc.slug);
      if (code === 0) info("Signed out; its Keychain entry is gone.");
      else warn("Could not sign it out — its credential may remain in the Keychain.");
    } else {
      warn("Its credential stays in the Keychain, unreferenced.");
      out(c.dim(`  Remove it later with:  claude auth logout  (run under cs shell ${acc.slug})`));
    }
  }

  if (pathExists(dir)) {
    if (purge) {
      removePath(dir);
      info(`Deleted ${dir}`);
    } else {
      const dest = join(ARCHIVE_DIR, "removed", `${slug}-${timestamp()}`);
      copyPath(dir, dest);
      removePath(dir);
      info(`Archived to ${dest}`);
    }
  }

  mutateRegistry((fresh) => {
    delete fresh.accounts[slug];
    if (fresh.defaultAccount === slug) fresh.defaultAccount = listAccounts(fresh)[0]?.slug;
  });
  success(`Removed ${c.bold(slug)}`);
  if (process.env.CLAUDESWITCH_ACCOUNT === slug) {
    warn("This terminal still points at the removed account.");
    out(`  ${c.dim("Run")} ${c.cyan("cs off")} ${c.dim("or switch to another account.")}`);
  }
  return 0;
}

export function cmdRename(args: Args): number {
  const reg = loadRegistry();
  const [from, to] = args.positionals;
  if (!from || !to) throw new UserError("Usage: claudeswitch rename <old-name> <new-name>");
  const acc = getAccount(reg, from);
  assertSlug(to);
  if (reg.accounts[to]) throw new UserError(`Account "${to}" already exists.`);

  const fromDir = accountDir(from);
  const toDir = accountDir(to);
  if (pathExists(fromDir)) {
    if (pathExists(toDir)) throw new UserError(`${toDir} already exists on disk.`);
    ensureDir(ACCOUNTS_DIR);
    renameSync(fromDir, toDir);
  }

  // acc.securestorageKey deliberately keeps its old value: the Keychain entry
  // is keyed on it, and rewriting it here would log the account out.
  acc.slug = to;
  mutateRegistry((fresh) => {
    delete fresh.accounts[from];
    upsertAccount(fresh, acc);
    if (fresh.defaultAccount === from) fresh.defaultAccount = to;
  });
  syncShare(to, acc.share);

  success(`Renamed ${c.bold(from)} → ${c.bold(to)}`);
  if (process.env.CLAUDESWITCH_ACCOUNT === from) {
    warn(`This terminal still points at the old path. Run ${c.cyan(`cs use ${to}`)}.`);
  }
  return 0;
}

export function cmdShare(args: Args): number {
  const reg = loadRegistry();
  const slug = args.positionals[0];

  if (flagBool(args, "default")) {
    const value = args.positionals[0];
    if (!value) throw new UserError("Usage: claudeswitch share --default <all|none|asset,asset>");
    const policy = parseSharePolicy(value);
    mutateRegistry((fresh) => { fresh.shareDefault = policy; });
    success(`New accounts will share: ${describeShare(policy)}`);
    return 0;
  }

  if (!slug) {
    out(c.bold("Shareable assets") + c.dim("  (everything else stays private per account)"));
    const w = Math.max(...SHAREABLE.map((s) => s.name.length));
    for (const s of SHAREABLE) out(`  ${s.name.padEnd(w)}  ${c.dim(s.what)}`);
    out();
    out(c.bold("Always private") + c.dim("  (this is what makes accounts independent)"));
    for (const p of PRIVATE_PATHS) out(`  ${c.dim("·")} ${p}`);
    out(`  ${c.dim("·")} .claude.json ${c.dim("(identity, trusted folders, MCP servers)")}`);
    out();
    out(c.bold("Per-account policy"));
    for (const a of listAccounts(reg)) out(`  ${a.slug.padEnd(16)}  ${describeShare(a.share)}`);
    out();
    out(c.dim("Set one:  ") + c.cyan("cs share work none") + c.dim("   ·   ") + c.cyan("cs share personal skills,plugins"));
    out(c.dim("Default for new accounts: ") + describeShare(reg.shareDefault) + c.dim("  (change with cs share --default <policy>)"));
    return 0;
  }

  const acc = getAccount(reg, slug);
  const value = args.positionals[1];
  if (!value) {
    out(`${c.bold(acc.slug)} shares: ${describeShare(acc.share)}`);
    for (const s of resolveShare(acc.share)) out(`  ${c.dim("·")} ${s.name}`);
    return 0;
  }

  acc.share = parseSharePolicy(value);
  const actions = syncShare(acc.slug, acc.share);
  mutateRegistry((fresh) => {
    const target = fresh.accounts[acc.slug];
    if (target) target.share = acc.share;
  });
  success(`${c.bold(acc.slug)} now shares: ${describeShare(acc.share)}`);
  for (const a of actions) {
    if (a.kind === "unshared") info(`${a.asset} → own copy in this account`);
    if (a.kind === "linked" || a.kind === "relinked") info(`${a.asset} → shared/`);
    if (a.kind === "archived") warn(`${a.asset}: local copy archived to ${a.backup}`);
    if (a.kind === "seeded") info(`${a.asset}: local copy moved into shared/`);
  }
  return 0;
}

export function cmdDefault(args: Args): number {
  const reg = loadRegistry();
  if (flagBool(args, "clear")) {
    mutateRegistry((fresh) => { fresh.defaultAccount = undefined; });
    success("Cleared the default account.");
    return 0;
  }
  const slug = args.positionals[0];
  if (!slug) {
    out(reg.defaultAccount ? `Default account: ${c.bold(reg.defaultAccount)}` : c.dim("No default account set."));
    return 0;
  }
  const acc = getAccount(reg, slug);
  mutateRegistry((fresh) => { fresh.defaultAccount = acc.slug; });
  success(`Default account: ${c.bold(acc.slug)}`);
  out(c.dim("  New shells activate it when the hook was installed with --auto."));
  return 0;
}

export function cmdWhich(args: Args): number {
  const slug = args.positionals[0] ?? process.env.CLAUDESWITCH_ACCOUNT;
  if (!slug) {
    out(process.env.CLAUDE_CONFIG_DIR ?? DEFAULT_CLAUDE_DIR);
    return 0;
  }
  const reg = loadRegistry();
  out(accountDir(getAccount(reg, slug).slug));
  return 0;
}

export function cmdLabel(args: Args): number {
  const reg = loadRegistry();
  const [slug, ...rest] = args.positionals;
  if (!slug) throw new UserError("Usage: claudeswitch label <name> <text…>");
  const acc = getAccount(reg, slug);
  const text = rest.join(" ").trim();
  acc.label = text.length ? text : undefined;
  mutateRegistry((fresh) => {
    const target = fresh.accounts[acc.slug];
    if (target) target.label = acc.label;
  });
  success(text.length ? `${acc.slug}: ${text}` : `Cleared the label on ${acc.slug}`);
  return 0;
}

/** A dangling symlink or an unreadable file should not silently vanish. */
function reportSkips(skipped: CopySkip[]): void {
  if (!skipped.length) return;
  warn(`Skipped ${skipped.length} unreadable entr${skipped.length === 1 ? "y" : "ies"}:`);
  for (const s of skipped.slice(0, 8)) out(`  ${c.dim("·")} ${s.path} ${c.dim(`(${s.reason})`)}`);
  if (skipped.length > 8) out(`  ${c.dim(`… and ${skipped.length - 8} more`)}`);
}

function resolvePolicyFlag(args: Args, fallback: SharePolicy): SharePolicy {
  const raw = flagString(args, "share");
  if (raw === undefined) return args.flags.share === false ? "none" : fallback;
  return parseSharePolicy(raw);
}

function isEmptyShared(): boolean {
  return !SHAREABLE.some((s) => pathExists(join(SHARED_DIR, s.name)));
}

export function applyStatus(record: AccountRecord, status: AuthStatus): void {
  if (!status.loggedIn) return;
  record.email = status.email ?? record.email;
  record.orgName = status.orgName ?? record.orgName;
  record.orgId = status.orgId ?? record.orgId;
  record.subscriptionType = status.subscriptionType ?? record.subscriptionType;
  record.authMethod = status.authMethod ?? record.authMethod;
}

/**
 * A fresh config dir triggers Claude Code's onboarding wizard. Seeding the
 * minimum keeps a new account from re-asking for theme and welcome screens.
 */
function seedConfigJson(slug: string, inheritTrust: boolean): void {
  const target = accountConfigJson(slug);
  if (pathExists(target)) return;
  const existing = readJson<Record<string, unknown>>(DEFAULT_CLAUDE_JSON) ?? {};
  const seed: Record<string, unknown> = {
    hasCompletedOnboarding: true,
    theme: typeof existing.theme === "string" ? existing.theme : "dark",
  };
  if (inheritTrust && existing.projects && typeof existing.projects === "object") {
    const projects: Record<string, unknown> = {};
    for (const [dir, value] of Object.entries(existing.projects as Record<string, any>)) {
      if (value?.hasTrustDialogAccepted) projects[dir] = { hasTrustDialogAccepted: true };
    }
    if (Object.keys(projects).length) {
      seed.projects = projects;
      info(`Inherited ${Object.keys(projects).length} trusted folder(s) from ~/.claude.json`);
    }
  }
  writeJsonAtomic(target, seed);
}
