import { spawnSync } from "node:child_process";
import { type Args, flagBool, flagString } from "../core/args.ts";
import { accountEnv, findClaudeBin } from "../core/claude.ts";
import { DEFAULT_CLAUDE_DIR, accountDir } from "../core/paths.ts";
import { getAccount, loadRegistry } from "../core/registry.ts";
import { copySession, findSessionsForCwd, type SessionInfo } from "../core/sessions.ts";
import { syncShare } from "../core/share.ts";
import { pathExists, relTime, shQuote, UserError } from "../core/util.ts";
import { c, info, isEmitMode, out, success, warn } from "../ui/io.ts";
import { confirm, pick, ttyAvailable } from "../ui/picker.ts";
import { cmdUse } from "./use.ts";

/**
 * Copy the Claude Code session for the current directory into another
 * account, so a conversation can carry on under a different identity once the
 * one it started on runs out of quota.
 *
 * Deliberately crosses the isolation boundary that every other command
 * protects (`projects/` is private per account) — that is the entire point,
 * so it asks for confirmation unless told not to, and copies rather than
 * moves unless `--move` is given.
 */
export function cmdHandoff(args: Args): number {
  const targetSlug = args.positionals[0];
  if (!targetSlug) {
    throw new UserError(
      "Usage: claudeswitch handoff <target-account> [--session <id>] [--from <account>]",
      "Copies this project's current Claude Code conversation to another account, then switches this terminal to it.",
    );
  }

  const reg = loadRegistry();
  const target = getAccount(reg, targetSlug);
  const targetDir = accountDir(target.slug);
  if (!pathExists(targetDir)) {
    throw new UserError(`Account "${target.slug}" has no config directory.`, `Run: claudeswitch add ${target.slug}`);
  }

  const fromSlug = flagString(args, "from") ?? process.env.CLAUDESWITCH_ACCOUNT;
  if (fromSlug && fromSlug === target.slug) {
    throw new UserError(`"${target.slug}" is both the source and the target.`);
  }
  const sourceDir = fromSlug ? accountDir(getAccount(reg, fromSlug).slug) : DEFAULT_CLAUDE_DIR;
  const sourceLabel = fromSlug ?? `${DEFAULT_CLAUDE_DIR} (unmanaged)`;
  if (!pathExists(sourceDir)) {
    throw new UserError(`No Claude Code config found at ${sourceDir}.`);
  }

  const cwd = process.cwd();
  const sessions = findSessionsForCwd(sourceDir, cwd);
  if (!sessions.length) {
    throw new UserError(
      `No Claude Code session for ${cwd} found under ${sourceLabel}.`,
      fromSlug
        ? "Run `claude` in this directory under that account at least once, or pass a different --from."
        : "Pass --from <account> if the session you want lives in a claudeswitch-managed account instead.",
    );
  }

  const session = pickSession(sessions, args, target.slug, sourceLabel);
  if (!session) {
    info("Cancelled — nothing changed.");
    return 0;
  }

  if (!flagBool(args, "yes")) {
    const question = `Copy this conversation from ${c.bold(sourceLabel)} to ${c.bold(target.slug)}` +
      `${target.email ? ` (${target.email})` : ""}?`;
    if (!ttyAvailable()) {
      throw new UserError(
        "Refusing to copy a conversation between accounts without confirmation.",
        "Pass --yes to skip the prompt — this is a deliberate crossing of account isolation.",
      );
    }
    if (!confirm(question)) {
      info("Cancelled — nothing changed.");
      return 0;
    }
  }

  const move = flagBool(args, "move");
  const result = copySession(session, targetDir, { move });
  if (result.skipped.length) {
    warn(`Could not copy: ${result.skipped[0]!.reason}`);
    return 1;
  }
  syncShare(target.slug, target.share);

  const shortId = session.sessionId.slice(0, 8);
  success(`${move ? "Moved" : "Copied"} session ${c.bold(shortId)} to ${c.bold(target.slug)}.`);
  out();
  out(`  ${c.bold("Continue it:")} ${c.cyan(`claude --resume ${session.sessionId}`)}`);
  out(c.dim("  (or just `claude` — it offers to resume the most recent session in this directory)"));

  const stay = flagBool(args, "stay");
  if (stay) return 0;

  const asUse: Args = { ...args, cmd: "use", positionals: [target.slug] };
  const wantsOpen = flagBool(args, "open", true);
  const bin = wantsOpen ? findClaudeBin() : null;
  if (!bin) {
    if (wantsOpen) warn("Could not find the claude CLI — switching only.");
    out();
    return cmdUse(asUse);
  }
  out();
  if (isEmitMode()) {
    // Runs in the caller's real shell, in the eval that applies the exports
    // above — this process's own stdout is the one being captured, not theirs.
    return cmdUse(asUse, [`${shQuote(bin)} --resume ${shQuote(session.sessionId)}`]);
  }

  // No shell hook to eval anything in: this process still owns the real
  // terminal (nothing captured its stdout), so open the conversation directly
  // instead of only switching. The switch itself still can't reach the parent
  // shell — cmdUse says so — but the immediate goal is met either way.
  cmdUse(asUse);
  info(`Opening it directly, since this terminal was not switched: claude --resume ${shortId}…`);
  const r = spawnSync(bin, ["--resume", session.sessionId], { stdio: "inherit", env: accountEnv(target.slug) });
  return r.status ?? 1;
}

function pickSession(
  sessions: SessionInfo[],
  args: Args,
  targetSlug: string,
  sourceLabel: string,
): SessionInfo | null {
  const requestedId = flagString(args, "session");
  if (requestedId) {
    const match = sessions.find((s) => s.sessionId === requestedId || s.sessionId.startsWith(requestedId));
    if (!match) {
      throw new UserError(
        `No session "${requestedId}" for this project under ${sourceLabel}.`,
        `Available: ${sessions.map((s) => s.sessionId).join(", ")}`,
      );
    }
    return match;
  }

  if (sessions.length === 1) return sessions[0]!;

  if (!ttyAvailable()) {
    throw new UserError(
      `${sessions.length} sessions found for this project under ${sourceLabel}.`,
      [
        "Pick one with --session <id>:",
        ...sessions.map((s) => `  ${s.sessionId}  ${relTime(s.mtimeMs)}${s.preview ? `  ${s.preview}` : ""}`),
      ].join("\n"),
    );
  }

  return pick(
    sessions.map((s) => ({
      value: s,
      cells: [s.sessionId.slice(0, 8), relTime(s.mtimeMs), s.preview ?? ""],
    })),
    {
      title: `Which session to hand off to ${targetSlug}?`,
      styles: [c.cyan, c.dim, (t) => t],
    },
  );
}
