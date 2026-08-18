import { type Args, flagBool } from "../core/args.ts";
import { accountConfigJson } from "../core/paths.ts";
import { getAccount, listAccounts, loadRegistry } from "../core/registry.ts";
import type { AccountRecord } from "../core/types.ts";
import {
  USAGE_FRESH_FOR_MS, formatCredits, readUsage, tightestBucket, type UsageSnapshot,
} from "../core/usage.ts";
import { UserError } from "../core/util.ts";
import { c, data, duration, meter, out, percentText, sym } from "../ui/io.ts";

/**
 * Show each account's quota: the 5-hour session window, the weekly windows, any
 * per-model weekly limits, and extra usage credits — with the time each one
 * resets.
 *
 * The numbers come from the cache Claude Code keeps per config directory. See
 * `src/core/usage.ts` for why claudeswitch reads rather than fetches them, and
 * what that costs in coverage.
 */
export function cmdUsage(args: Args): number {
  const reg = loadRegistry();
  const explicit = args.positionals[0];
  const accounts = explicit ? [getAccount(reg, explicit)] : listAccounts(reg);
  if (!accounts.length) {
    throw new UserError("No accounts yet.", "Add one: claudeswitch add <name>");
  }

  const now = Date.now();
  const snapshots = accounts.map((acc) => ({ acc, usage: readUsage(acc.slug, now) }));

  if (flagBool(args, "json")) {
    data(
      JSON.stringify(
        {
          accounts: snapshots.map(({ acc, usage }) => ({
            slug: acc.slug,
            email: acc.email ?? null,
            plan: acc.subscriptionType ?? null,
            usage: usage
              ? {
                  ...usage,
                  fetchedAt: new Date(usage.fetchedAt).toISOString(),
                  buckets: usage.buckets.map((b) => ({
                    ...b,
                    resetsAt: b.resetsAt ? new Date(b.resetsAt).toISOString() : null,
                  })),
                }
              : null,
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const active = process.env.CLAUDESWITCH_ACCOUNT;
  let anyData = false;

  snapshots.forEach(({ acc, usage }, index) => {
    if (index) out();
    printAccount(acc, usage, acc.slug === active, now);
    if (usage) anyData = true;
  });

  if (!anyData) {
    out();
    explainMissing();
  }
  return 0;
}

function printAccount(acc: AccountRecord, usage: UsageSnapshot | null, isActive: boolean, now: number): void {
  const name = isActive ? c.bold(c.green(acc.slug)) : c.bold(acc.slug);
  const mark = isActive ? c.green(sym.active) : c.dim(sym.idle);
  const meta = [acc.email, acc.subscriptionType].filter(Boolean).join(" · ");
  out(`${mark} ${name}${meta ? "  " + c.dim(meta) : ""}`);

  if (!usage) {
    out(`  ${c.dim("no usage data recorded for this account")}`);
    return;
  }

  const width = Math.max(...usage.buckets.map((b) => b.label.length), 14);
  for (const bucket of usage.buckets) {
    // A window that has rolled over since the reading: the percentage describes
    // a window that no longer exists, so it is not shown as if it were current.
    if (bucket.rolledOver) {
      out(
        `  ${bucket.label.padEnd(width)}  ${c.dim("— ".repeat(5))} ` +
          `${c.dim("  ?")}  ${c.dim(`window reset ${duration(now - bucket.resetsAt!)} ago, after this reading`)}`,
      );
      continue;
    }
    const reset = bucket.resetsAt ? c.dim(`resets in ${duration(bucket.resetsAt - now)}`) : "";
    out(
      `  ${bucket.label.padEnd(width)}  ${meter(bucket.utilization)} ` +
        `${percentText(bucket.utilization).padStart(4)}  ${reset}`,
    );
  }

  const extra = usage.extraUsage;
  if (extra?.enabled) {
    const used = formatCredits(extra.usedCredits, extra.decimalPlaces);
    const limit = formatCredits(extra.monthlyLimit, extra.decimalPlaces);
    out(
      `  ${"extra usage".padEnd(width)}  ${meter(extra.utilization)} ` +
        `${percentText(extra.utilization).padStart(4)}  ` +
        c.dim(`${used} of ${limit} ${extra.currency} this month`),
    );
    if (extra.spendLimitReached) out(`  ${" ".repeat(width)}  ${c.red("spend limit reached")}`);
  }

  const origin = usage.source ? c.dim(`, recorded by ${usage.source}`) : "";
  const asOf = c.dim(`as of ${duration(usage.ageMs)} ago`) + origin;
  out(
    usage.stale
      ? `  ${c.yellow(sym.warn)} ${asOf} ${c.dim(`— Claude Code itself ignores readings older than ${duration(USAGE_FRESH_FOR_MS)}`)}`
      : `  ${asOf}`,
  );
}

/** A compact cell for `cs ls --usage`: the limit closest to biting. */
export function usageCell(slug: string, now = Date.now()): string {
  const usage = readUsage(slug, now);
  if (!usage) return c.dim("—");
  const worst = tightestBucket(usage);
  if (!worst) return c.dim("?");

  const label = worst.key === "five_hour" ? "5h" : worst.key === "seven_day" ? "7d" : worst.label;
  const text = `${label} ${percentText(worst.utilization)}`;
  const reset = worst.resetsAt && worst.resetsAt > now ? c.dim(` ${duration(worst.resetsAt - now)}`) : "";
  return (usage.stale ? c.dim("~") : "") + text + reset;
}

export function explainMissing(): void {
  out(c.dim("  Claude Code records usage when its own interface needs it — opening /usage"));
  out(c.dim("  does it, and so does hitting a limit. An account shows nothing until then:"));
  out();
  out(`    ${c.cyan("cs use <account>")}   ${c.dim("then run")} ${c.cyan("/usage")} ${c.dim("in Claude Code")}`);
  out();
  out(c.dim("  claudeswitch reads that recording rather than fetching it, because fetching"));
  out(c.dim("  would mean reading the account's token out of the Keychain. See cs help usage."));
}

/** Where the reading is kept, for `cs current`. */
export function usageSource(slug: string): string {
  return accountConfigJson(slug);
}
