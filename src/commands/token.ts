import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { type Args, flagBool } from "../core/args.ts";
import { accountEnv, requireClaudeBin } from "../core/claude.ts";
import { readCredentialInfo } from "../core/creds.ts";
import { accountDir, accountLongLivedToken } from "../core/paths.ts";
import { getAccount, loadRegistry } from "../core/registry.ts";
import { ensureDir, pathExists, removePath, UserError } from "../core/util.ts";
import { c, info, out, success, warn } from "../ui/io.ts";
import { confirm, promptSecret, ttyAvailable } from "../ui/picker.ts";

/** Claude Code hands these out via `claude setup-token`. */
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/-]{40,}$/;

/**
 * Attach a long-lived token to an account.
 *
 * `claude setup-token` mints a token that does not expire on a schedule, so the
 * account never asks for an interactive login again. Claude Code reads it from
 * CLAUDE_CODE_OAUTH_TOKEN rather than from disk, so claudeswitch stores it and
 * exports it when you switch.
 *
 * The trade-off is real and comes from Claude Code, not from here: these tokens
 * are inference-only. A normal login carries user:inference, user:profile,
 * user:file_upload, user:mcp_servers and user:sessions:claude_code; a long-lived
 * token is limited to inference, which rules out Remote Control among others.
 */
export function cmdToken(args: Args): number {
  const reg = loadRegistry();
  const slug = args.positionals[0] ?? process.env.CLAUDESWITCH_ACCOUNT;
  if (!slug) {
    throw new UserError(
      "Usage: claudeswitch token <account>",
      "Add --clear to go back to a normal login, or --show to check what is stored.",
    );
  }
  const acc = getAccount(reg, slug);
  const path = accountLongLivedToken(acc.slug);

  if (flagBool(args, "clear")) {
    if (!pathExists(path)) {
      out(c.dim(`${acc.slug} has no long-lived token.`));
      return 0;
    }
    removePath(path);
    success(`Removed the long-lived token from ${c.bold(acc.slug)}`);
    const creds = readCredentialInfo(acc.slug);
    if (creds.present && creds.kind === "oauth") {
      out(c.dim("  Its normal login is still stored, so it works again as before."));
    } else {
      out(`  ${c.dim("It has no login now:")} ${c.cyan(`cs login ${acc.slug}`)}`);
    }
    return 0;
  }

  if (flagBool(args, "show")) {
    if (!pathExists(path)) {
      out(`${acc.slug}: ${c.dim("no long-lived token")}`);
      return 0;
    }
    const bytes = readFileSync(path, "utf8").trim().length;
    out(`${c.bold(acc.slug)} has a long-lived token ${c.dim(`(${bytes} characters, stored at ${path})`)}`);
    out(c.dim("  It is exported as CLAUDE_CODE_OAUTH_TOKEN when you switch to this account."));
    return 0;
  }

  if (!ttyAvailable()) {
    throw new UserError("`claudeswitch token` needs a terminal: it runs an interactive login.");
  }

  out(c.bold(`Long-lived token for ${acc.slug}`));
  out();
  out(c.dim("  A long-lived token never expires on a schedule, so this account stops asking"));
  out(c.dim("  you to log in. Claude Code restricts these tokens to inference only, which"));
  out(c.dim("  means features needing broader scopes — Remote Control, for one — stop"));
  out(c.dim("  working on this account. A normal login keeps every scope, and `cs keepwarm`"));
  out(c.dim("  already prevents the 30-day expiry."));
  out();
  if (!confirm("  Continue?", false)) {
    info("Cancelled — nothing changed.");
    return 1;
  }
  out();

  if (!flagBool(args, "paste")) {
    requireClaudeBin();
    ensureDir(accountDir(acc.slug));
    info("Running `claude setup-token` — sign in, then copy the token it prints.");
    out();
    const r = spawnSync(requireClaudeBin(), ["setup-token"], {
      stdio: "inherit",
      env: accountEnv(acc.slug),
    });
    out();
    if (r.status !== 0) {
      warn("`claude setup-token` did not finish.");
      out(`  ${c.dim("If you already have a token, store it with:")} ${c.cyan(`cs token ${acc.slug} --paste`)}`);
      return r.status ?? 1;
    }
  }

  // Read it from the operator rather than scraping stdout: setup-token needs the
  // terminal for its own prompts, so its output is not ours to capture.
  const pasted = promptSecret(`  ${c.bold("Paste the token")} ${c.dim("(not echoed):")} `);
  if (!pasted) {
    warn("No token entered — nothing was stored.");
    return 1;
  }
  if (!TOKEN_SHAPE.test(pasted)) {
    throw new UserError(
      "That does not look like a Claude Code token.",
      "Expected the long opaque string printed by `claude setup-token`.",
    );
  }

  ensureDir(accountDir(acc.slug));
  writeFileSync(path, pasted + "\n", { mode: 0o600 });

  out();
  success(`${c.bold(acc.slug)} now uses a long-lived token`);
  out(c.dim(`  Stored at ${path} with owner-only permissions.`));
  out(`  ${c.dim("It takes effect on your next")} ${c.cyan(`cs use ${acc.slug}`)}`);
  out(`  ${c.dim("Undo with")} ${c.cyan(`cs token ${acc.slug} --clear`)}`);
  return 0;
}
