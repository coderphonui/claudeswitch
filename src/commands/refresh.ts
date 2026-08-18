import { spawnSync } from "node:child_process";
import { type Args, flagBool } from "../core/args.ts";
import { accountEnv, authStatus, requireClaudeBin } from "../core/claude.ts";
import {
  IDLE_WINDOW_DAYS, RENEW_WARNING_DAYS, daysUntilLoginRequired, readCredentialInfo,
  refreshWouldRun,
} from "../core/creds.ts";
import { accountDir } from "../core/paths.ts";
import { getAccount, listAccounts, loadRegistry, mutateRegistry } from "../core/registry.ts";
import type { AccountRecord } from "../core/types.ts";
import { pathExists, relTime, UserError } from "../core/util.ts";
import { c, data, out, sym } from "../ui/io.ts";

export interface RefreshOutcome {
  slug: string;
  action: "renewed" | "already-fresh" | "skipped" | "failed";
  before?: number;
  after?: number;
  detail?: string;
}

/**
 * Roll an account's 30-day login deadline forward.
 *
 * Claude Code refreshes an expired access token on its next authenticated
 * request, and the token response carries a brand-new refresh token with a full
 * 30-day life. So a single cheap request is enough to reset the clock — which
 * means an account touched at least monthly never needs an interactive login.
 *
 * There is no way to make the request cheaper than one turn: `claude auth
 * status` reads the file without contacting the token endpoint (verified), so
 * it cannot renew anything.
 */
export function cmdRefresh(args: Args): number {
  // Stamp first: this also runs from a launchd job whose log would otherwise be
  // an undated pile of status lines, including any failure below.
  if (process.env.CLAUDESWITCH_KEEPWARM === "1") {
    out(`--- ${new Date().toISOString()} keep-warm run ---`);
  }
  requireClaudeBin();
  const reg = loadRegistry();
  const explicit = args.positionals[0];
  const force = flagBool(args, "force");
  const dueOnly = flagBool(args, "due");

  const targets: AccountRecord[] = explicit
    ? [getAccount(reg, explicit)]
    : listAccounts(reg);
  if (!targets.length) throw new UserError("No accounts to refresh.");

  const results: RefreshOutcome[] = [];
  for (const acc of targets) {
    results.push(refreshOne(acc, { force, dueOnly }));
  }

  if (flagBool(args, "json")) {
    data(JSON.stringify({ results }, null, 2));
    return 0;
  }

  for (const r of results) report(r);

  const failed = results.filter((r) => r.action === "failed");
  if (failed.length) {
    out();
    out(c.dim("  A failure here usually means the refresh token is already dead."));
    out(`  ${c.dim("Fix with:")} ${c.cyan(`cs login ${failed[0]!.slug}`)}`);
  }
  return failed.length ? 1 : 0;
}

function refreshOne(acc: AccountRecord, opts: { force: boolean; dueOnly: boolean }): RefreshOutcome {
  const slug = acc.slug;
  if (!pathExists(accountDir(slug))) {
    return { slug, action: "skipped", detail: "no config directory" };
  }

  const before = readCredentialInfo(slug);
  if (before.kind === "long-lived") {
    return { slug, action: "skipped", detail: "long-lived token — nothing to renew" };
  }
  if (before.storage === "keychain") {
    // Nothing to inspect: ask Claude Code whether this account works at all,
    // then let the request itself do the refresh.
    if (!authStatus(slug).loggedIn) {
      return { slug, action: "skipped", detail: "not logged in" };
    }
  } else if (!before.present) {
    return { slug, action: "skipped", detail: "not logged in" };
  }

  const daysLeft = daysUntilLoginRequired(before);
  if (daysLeft !== undefined && daysLeft <= 0) {
    return { slug, action: "failed", detail: "login already expired" };
  }
  if (opts.dueOnly && daysLeft !== undefined && daysLeft > RENEW_WARNING_DAYS * 3) {
    return { slug, action: "skipped", detail: `${daysLeft}d left` };
  }
  if (!refreshWouldRun(before) && !opts.force) {
    return {
      slug,
      action: "already-fresh",
      before: before.refreshTokenExpiresAt,
      detail: before.expiresAt ? `access token valid ${relTime(before.expiresAt)}` : undefined,
    };
  }

  // The cheapest authenticated turn available: one token in, one token out.
  const r = spawnSync(requireClaudeBin(), ["-p", "hi", "--max-turns", "1"], {
    env: accountEnv(slug),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });

  const after = readCredentialInfo(slug);
  if (after.storage !== "keychain" && !after.present) {
    return { slug, action: "failed", detail: "credentials were cleared — the refresh token was rejected" };
  }
  if (r.status !== 0) {
    const why = (r.stderr || r.stdout || "").trim().split("\n")[0];
    return { slug, action: "failed", detail: why || `claude exited ${r.status}` };
  }

  touchRefreshed(slug);

  // With a Keychain-backed credential there is no expiry on disk to compare, so
  // a successful authenticated request is the only evidence available — and it
  // is enough, because that request is exactly what renews the token.
  if (before.storage === "keychain") {
    return { slug, action: "renewed", detail: `${IDLE_WINDOW_DAYS} more idle days` };
  }

  const moved =
    (after.refreshTokenExpiresAt ?? 0) > (before.refreshTokenExpiresAt ?? 0) ||
    after.fingerprint !== before.fingerprint;

  return {
    slug,
    action: moved ? "renewed" : "already-fresh",
    before: before.refreshTokenExpiresAt,
    after: after.refreshTokenExpiresAt,
  };
}

/** Records when we last rolled an account's window forward. */
function touchRefreshed(slug: string): void {
  mutateRegistry((reg) => {
    const acc = reg.accounts[slug];
    if (acc) acc.lastRefreshedAt = new Date().toISOString();
  });
}

function report(r: RefreshOutcome): void {
  const name = c.bold(r.slug);
  switch (r.action) {
    case "renewed": {
      const days = r.after ? Math.ceil((r.after - Date.now()) / 86_400_000) : undefined;
      const detail = days !== undefined ? `good for ${days} more days` : r.detail;
      out(`${c.green(sym.ok)} ${name} renewed${detail ? c.dim(` — ${detail}`) : ""}`);
      break;
    }
    case "already-fresh":
      out(`${c.dim(sym.ok)} ${name} ${c.dim(r.detail ?? "already fresh")}`);
      break;
    case "skipped":
      out(`${c.dim("·")} ${name} ${c.dim(r.detail ?? "skipped")}`);
      break;
    case "failed":
      out(`${c.red(sym.bad)} ${name} ${r.detail ?? "failed"}`);
      break;
  }
}
