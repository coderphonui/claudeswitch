import { spawnSync } from "node:child_process";
import { type Args } from "../core/args.ts";
import { accountEnv, requireClaudeBin } from "../core/claude.ts";
import { accountDir } from "../core/paths.ts";
import { getAccount, loadRegistry, touchAccount } from "../core/registry.ts";
import { syncShare } from "../core/share.ts";
import { pathExists, UserError } from "../core/util.ts";
import { c, info, out } from "../ui/io.ts";

/**
 * Run an arbitrary command under one account without touching the current
 * shell — the safe way to use a second account inside a terminal that is
 * already switched to a different one.
 */
export function cmdExec(args: Args): number {
  const slug = args.positionals[0];
  if (!slug) throw new UserError("Usage: claudeswitch exec <account> -- <command> [args…]");
  const command = args.passthrough.length ? args.passthrough : args.positionals.slice(1);
  if (!command.length) {
    throw new UserError(
      "No command given.",
      `Example: claudeswitch exec ${slug} -- claude -p "hello"`,
    );
  }
  const acc = prepare(slug);
  const r = spawnSync(command[0]!, command.slice(1), {
    stdio: "inherit",
    env: accountEnv(acc),
  });
  if (r.error) throw new UserError(`Could not run ${command[0]}: ${r.error.message}`);
  return r.status ?? 1;
}

/** Shorthand for `exec <account> -- claude …`. */
export function cmdRun(args: Args): number {
  const slug = args.positionals[0];
  if (!slug) throw new UserError("Usage: claudeswitch run <account> [claude args…]");
  const acc = prepare(slug);
  const bin = requireClaudeBin();
  const claudeArgs = [...args.positionals.slice(1), ...args.passthrough];
  const r = spawnSync(bin, claudeArgs, { stdio: "inherit", env: accountEnv(acc) });
  return r.status ?? 1;
}

/** A subshell pinned to one account — works without any shell integration. */
export function cmdShell(args: Args): number {
  const slug = args.positionals[0];
  if (!slug) throw new UserError("Usage: claudeswitch shell <account>");
  const acc = prepare(slug);
  const shell = process.env.SHELL || "/bin/zsh";
  info(`Subshell for ${c.bold(acc)} — type ${c.cyan("exit")} to return.`);
  out(c.dim(`  CLAUDE_CONFIG_DIR=${accountDir(acc)}`));
  const env = accountEnv(acc);
  env.CLAUDESWITCH_SUBSHELL = "1";
  const r = spawnSync(shell, ["-i"], { stdio: "inherit", env });
  return r.status ?? 0;
}

function prepare(slug: string): string {
  const reg = loadRegistry();
  const acc = getAccount(reg, slug);
  if (!pathExists(accountDir(acc.slug))) {
    throw new UserError(`Account "${acc.slug}" has no config directory.`, `Run: claudeswitch add ${acc.slug}`);
  }
  syncShare(acc.slug, acc.share);
  touchAccount(acc.slug);
  return acc.slug;
}
