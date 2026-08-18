import { type Args, flagBool, flagString } from "../core/args.ts";
import { authLogin, authLogout, authStatus, requireClaudeBin } from "../core/claude.ts";
import { accountDir } from "../core/paths.ts";
import { findByEmail, getAccount, loadRegistry, mutateRegistry } from "../core/registry.ts";
import { syncShare } from "../core/share.ts";
import { ensureDir, UserError } from "../core/util.ts";
import { c, fail, info, out, success, warn } from "../ui/io.ts";
import { applyStatus } from "./manage.ts";

export function cmdLogin(args: Args): number {
  requireClaudeBin();
  const reg = loadRegistry();
  const slug = args.positionals[0] ?? process.env.CLAUDESWITCH_ACCOUNT;
  if (!slug) throw new UserError("Usage: claudeswitch login <account>");
  const acc = getAccount(reg, slug);

  ensureDir(accountDir(acc.slug));
  syncShare(acc.slug, acc.share);

  info(`Signing in to ${c.bold(acc.slug)}${acc.email ? c.dim(` (was ${acc.email})`) : ""}…`);
  const code = authLogin(acc.slug, {
    email: flagString(args, "email") ?? acc.email,
    console: flagBool(args, "console"),
  });

  const status = authStatus(acc.slug);
  if (!status.loggedIn) {
    fail("Still not logged in.");
    return code || 1;
  }

  const previousEmail = acc.email;
  applyStatus(acc, status);
  mutateRegistry((fresh) => {
    const target = fresh.accounts[acc.slug];
    if (target) applyStatus(target, status);
  });

  if (previousEmail && acc.email && previousEmail !== acc.email) {
    warn(`This account now holds ${acc.email} (was ${previousEmail}).`);
  }
  const dupe = acc.email ? findByEmail(reg, acc.email) : undefined;
  if (dupe && dupe.slug !== acc.slug) {
    warn(`${acc.email} is also stored as "${dupe.slug}".`);
  }
  success(`${c.bold(acc.slug)} ${c.dim("·")} ${acc.email}${acc.subscriptionType ? c.dim(` (${acc.subscriptionType})`) : ""}`);
  return 0;
}

export function cmdLogout(args: Args): number {
  const reg = loadRegistry();
  const slug = args.positionals[0] ?? process.env.CLAUDESWITCH_ACCOUNT;
  if (!slug) throw new UserError("Usage: claudeswitch logout <account>");
  const acc = getAccount(reg, slug);
  const code = authLogout(acc.slug);
  if (code === 0) {
    success(`Logged out of ${c.bold(acc.slug)}`);
    out(c.dim(`  The directory and its history are kept. Log back in with: cs login ${acc.slug}`));
  }
  return code;
}
