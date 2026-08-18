import { type Args, flagBool } from "../core/args.ts";
import { authStatus, conflictingEnvVars } from "../core/claude.ts";
import {
  IDLE_WINDOW_DAYS, RENEW_WARNING_DAYS, accessTokenExpired, daysUntilLoginRequired,
  estimatedIdleDaysLeft, needsLiveProbe, needsLogin, readCredentialInfo,
} from "../core/creds.ts";
import { accountDir } from "../core/paths.ts";
import { listAccounts, loadRegistry, orphanDirs } from "../core/registry.ts";
import { keychainService, securestorageKey } from "../core/securestorage.ts";
import { readUsage, tightestBucket } from "../core/usage.ts";
import { describeShare, shareHealth } from "../core/share.ts";
import type { AccountRecord } from "../core/types.ts";
import { pathExists, relTime, UserError } from "../core/util.ts";
import { c, data, duration, out, percentText, sym, table, warn } from "../ui/io.ts";
import { usageCell } from "./usage.ts";

export function cmdList(args: Args): number {
  const reg = loadRegistry();
  const accounts = listAccounts(reg);
  const active = process.env.CLAUDESWITCH_ACCOUNT;
  const deep = flagBool(args, "deep");

  if (flagBool(args, "json")) {
    data(
      JSON.stringify(
        {
          active: active ?? null,
          default: reg.defaultAccount ?? null,
          shareDefault: reg.shareDefault,
          accounts: accounts.map((a) => ({
            ...a,
            configDir: accountDir(a.slug),
            credentials: readCredentialInfo(a.slug),
            daysUntilLoginRequired: daysUntilLoginRequired(readCredentialInfo(a.slug)) ?? null,
            usage: readUsage(a.slug),
            shareLinks: shareHealth(a.slug, a.share),
            live: deep ? authStatus(a.slug) : undefined,
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (!accounts.length) {
    out(c.dim("No Claude accounts registered yet."));
    out();
    out(`  ${c.bold("Import the account you already use:")}  ${c.cyan("claudeswitch import")}`);
    out(`  ${c.bold("Add another one:")}                     ${c.cyan("claudeswitch add work")}`);
    return 0;
  }

  // Columns that would be blank for every account do not earn their width.
  const showAliases = accounts.some((a) => a.aliases?.length);
  const wide = flagBool(args, "wide");
  const showUsage = flagBool(args, "usage");

  const rows = accounts.map((a) => {
    const isActive = a.slug === active;
    const creds = readCredentialInfo(a.slug);
    const links = shareHealth(a.slug, a.share);
    // A Keychain-backed account is unreadable from disk, so it has to be asked.
    const live = deep || needsLiveProbe(creds) ? authStatus(a.slug) : undefined;

    return [
      isActive ? c.green(sym.active) : c.dim(sym.idle),
      isActive ? c.bold(c.green(a.slug)) : a.slug,
      ...(showAliases ? [a.aliases?.length ? c.cyan(a.aliases.join(", ")) : ""] : []),
      live?.email ?? a.email ?? c.dim("—"),
      live?.subscriptionType ?? a.subscriptionType ?? c.dim("—"),
      statusCell(creds, links, live),
      ...(showUsage ? [usageCell(a.slug)] : []),
      idleCell(creds, a.lastRefreshedAt ?? a.lastUsedAt, live),
      a.lastUsedAt ? c.dim(relTime(Date.parse(a.lastUsedAt))) : c.dim("never"),
      ...(wide
        ? [
            a.orgName ?? c.dim("—"),
            describeShare(a.share),
            a.label ? c.dim(a.label) : "",
          ]
        : []),
    ];
  });

  out(
    table(
      [
        "",
        "account",
        ...(showAliases ? ["alias"] : []),
        "email",
        "plan",
        "status",
        ...(showUsage ? ["quota"] : []),
        "idle budget",
        "last used",
        ...(wide ? ["org", "shared", "label"] : []),
      ],
      rows,
    ),
  );

  const orphans = orphanDirs(reg);
  if (orphans.length) {
    out();
    warn(`Unregistered directories in accounts/: ${orphans.join(", ")}`);
    out(`  ${c.dim("Adopt or clean them up with")} ${c.cyan("claudeswitch doctor")}`);
  }
  if (!active) {
    out();
    out(c.dim("This terminal uses Claude Code's default account."));
  }
  return 0;
}

export function cmdCurrent(args: Args): number {
  const reg = loadRegistry();
  const slug = process.env.CLAUDESWITCH_ACCOUNT;
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const probe = flagBool(args, "probe", true);

  if (flagBool(args, "json")) {
    const acc = slug ? reg.accounts[slug] : undefined;
    data(
      JSON.stringify(
        {
          active: slug ?? null,
          configDir: configDir ?? null,
          managed: Boolean(acc),
          account: acc ?? null,
          credentials: slug ? readCredentialInfo(slug) : null,
          live: slug && probe ? authStatus(slug) : null,
          conflictingEnv: conflictingEnvVars(),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (!slug) {
    if (configDir) {
      out(`${c.yellow(sym.warn)} This terminal uses ${c.bold("CLAUDE_CONFIG_DIR")}=${configDir}`);
      out(c.dim("  It was not set by claudeswitch, so no account metadata is available."));
    } else {
      out(`${c.dim(sym.idle)} ${c.bold("default")} ${c.dim("— Claude Code's own account (~/.claude)")}`);
      out(`  ${c.dim("Switch with")} ${c.cyan("cs use <account>")}`);
    }
    reportEnvConflicts();
    return 0;
  }

  const acc = reg.accounts[slug];
  if (!acc) {
    throw new UserError(
      `This terminal claims account "${slug}" but the registry has no such entry.`,
      "Run `claudeswitch off` and then switch again.",
    );
  }

  const creds = readCredentialInfo(slug);
  const links = shareHealth(slug, acc.share);
  const live = probe || needsLiveProbe(creds) ? authStatus(slug) : undefined;

  out(`${c.green(sym.active)} ${c.bold(c.green(acc.slug))}${acc.label ? "  " + c.dim(acc.label) : ""}`);
  const rows: [string, string][] = [
    ...(acc.aliases?.length
      ? ([["aliases", acc.aliases.map((a) => c.cyan(a)).join(", ")]] as [string, string][])
      : []),
    ["email", live?.email ?? acc.email ?? c.dim("—")],
    ["org", [live?.orgName ?? acc.orgName, live?.orgId ?? acc.orgId].filter(Boolean).join("  ") || c.dim("—")],
    ["plan", live?.subscriptionType ?? acc.subscriptionType ?? c.dim("—")],
    ["auth method", live?.authMethod ?? acc.authMethod ?? c.dim("—")],
    ["logged in", live ? (live.loggedIn ? c.green("yes") : c.red("no")) : c.dim("(not probed)")],
    ["config dir", accountDir(acc.slug)],
    ["shared", describeShare(acc.share)],
    ["links", links.ok ? c.green(`${sym.ok} healthy`) : c.yellow(`${sym.warn} broken: ${links.broken.join(", ")}`)],
    // Suppressed for a Keychain-backed account: the file is absent by design
    // there, and "missing" would read as a fault.
    ...(creds.storage === "keychain"
      ? []
      : ([
          [
            "access token",
            creds.present
              ? creds.expiresAt
                ? accessTokenExpired(creds)
                  ? c.dim(`expired ${relTime(creds.expiresAt)} (auto-refreshes)`)
                  : `valid, expires ${relTime(creds.expiresAt)}`
                : c.dim("stored")
              : c.red("missing"),
          ],
        ] as [string, string][])),
  ];
  if (creds.kind === "long-lived") {
    rows.push(["login renewal", c.green("never needed") + c.dim(" · long-lived token, inference-only scope")]);
  } else if (creds.storage === "keychain") {
    const days = estimatedIdleDaysLeft(acc.lastRefreshedAt ?? acc.lastUsedAt);
    rows.push(["credentials", "macOS Keychain" + c.dim(` · ${keychainService(securestorageKey(acc))}`)]);
    rows.push([
      "idle budget",
      `about ${days === undefined ? IDLE_WINDOW_DAYS : Math.max(0, days)}d unused before a login is needed` +
        c.dim(" · estimated; the exact date is sealed in the Keychain"),
    ]);
  } else if (creds.refreshTokenExpiresAt) {
    const days = daysUntilLoginRequired(creds);
    rows.push([
      "idle budget",
      needsLogin(creds)
        ? c.red(`expired ${relTime(creds.refreshTokenExpiresAt)} — run cs login ${acc.slug}`)
        : `${days}d unused before a login is needed` +
          c.dim(` · resets on every use, or run cs refresh ${acc.slug}`),
    ]);
  }
  if (creds.rateLimitTier) rows.push(["rate limit tier", c.dim(creds.rateLimitTier)]);

  const usage = readUsage(acc.slug);
  if (usage) {
    const worst = tightestBucket(usage);
    if (worst) {
      const resets =
        worst.resetsAt && worst.resetsAt > Date.now()
          ? `, resets in ${duration(worst.resetsAt - Date.now())}`
          : "";
      rows.push([
        "quota",
        `${worst.label} at ${percentText(worst.utilization)}${resets}` +
          c.dim(`  · ${usage.stale ? "stale reading, " : ""}as of ${duration(usage.ageMs)} ago · cs usage for all windows`),
      ]);
    }
  }

  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) out(`  ${c.dim(k.padEnd(width))}  ${v}`);
  if (!pathExists(accountDir(acc.slug))) warn("The config directory is missing!");
  reportEnvConflicts();
  return 0;
}

/**
 * How long this account may sit untouched before it needs a login again. The
 * window rolls forward every time the account is used, so this is a budget for
 * neglect rather than a countdown to a fixed date.
 */
function idleCell(
  creds: ReturnType<typeof readCredentialInfo>,
  lastActivity: string | undefined,
  live?: ReturnType<typeof authStatus>,
): string {
  // A budget is meaningless for an account that is not logged in at all.
  if (live && !live.loggedIn) return c.dim("—");
  if (creds.kind === "long-lived") return c.dim("∞");

  // Keychain-backed: the real deadline is sealed away, so estimate it from the
  // last activity claudeswitch saw and mark the number as approximate.
  if (creds.storage === "keychain") {
    const days = estimatedIdleDaysLeft(lastActivity);
    if (days === undefined) return c.dim(`~${IDLE_WINDOW_DAYS}d`);
    if (days <= 0) return c.yellow("check");
    return days <= RENEW_WARNING_DAYS ? c.yellow(`~${days}d`) : c.dim(`~${days}d`);
  }

  if (!creds.present) return c.dim("—");
  const days = daysUntilLoginRequired(creds);
  if (days === undefined) return c.dim("—");
  if (days <= 0) return c.red("expired");
  return days <= RENEW_WARNING_DAYS ? c.yellow(`${days}d`) : c.dim(`${days}d`);
}

function reportEnvConflicts(): void {
  const conflicts = conflictingEnvVars();
  if (!conflicts.length) return;
  out();
  warn(`Provider overrides are set in this shell: ${conflicts.join(", ")}`);
  out(c.dim("  Claude Code prefers these over the account's OAuth credentials."));
  out(`  ${c.dim("Clear them by switching again:")} ${c.cyan("cs use <account>")}`);
}

/** One column for "is this account usable right now", worst problem first. */
function statusCell(
  creds: ReturnType<typeof readCredentialInfo>,
  links: ReturnType<typeof shareHealth>,
  live?: ReturnType<typeof authStatus>,
): string {
  if (live && !live.loggedIn) return c.red(`${sym.bad} logged out`);
  if (live?.loggedIn && creds.storage === "keychain") {
    return links.ok ? c.green(sym.ok) : c.yellow(`${sym.warn} ${links.broken.length} links`);
  }
  if (!creds.present) return c.red(`${sym.bad} no creds`);
  if (needsLogin(creds)) return c.red(`${sym.bad} login expired`);
  if (!links.ok) return c.yellow(`${sym.warn} ${links.broken.length} link${links.broken.length === 1 ? "" : "s"}`);
  if (creds.kind === "long-lived") return c.green(sym.ok) + c.dim(" long-lived");

  const days = daysUntilLoginRequired(creds);
  if (days !== undefined && days <= RENEW_WARNING_DAYS) {
    return c.yellow(`${sym.warn} renew (${days}d)`);
  }
  return c.green(sym.ok) + (accessTokenExpired(creds) ? c.dim(" refreshing") : "");
}
