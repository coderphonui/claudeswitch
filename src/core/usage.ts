import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNTS_DIR, DEFAULT_CLAUDE_JSON, accountConfigJson } from "./paths.ts";
import { readJson } from "./util.ts";

/**
 * Quota usage for one account, as last seen by Claude Code.
 *
 * Claude Code fetches `GET /api/oauth/usage` and caches the result in
 * `<config dir>/.claude.json` under `cachedUsageUtilization`. claudeswitch only
 * reads that cache: fetching it directly would mean reading the account's access
 * token out of the macOS Keychain, which this tool deliberately never does.
 *
 * The consequence is that usage appears once Claude Code has had a reason to ask
 * for it — opening `/usage`, or an extra-usage prompt. A plain `claude -p` run
 * does not fetch it (verified), so a freshly created account shows nothing until
 * you look at usage inside a session.
 */
export interface UsageBucket {
  key: string;
  label: string;
  /** Percentage of the limit consumed, 0-100, as of the reading. */
  utilization: number;
  /** When the window rolls over, if the API said. */
  resetsAt?: number;
  /**
   * The window rolled over after this reading was taken, so the percentage is
   * known to be obsolete rather than merely old. Showing a stale "100%" for a
   * window that has since reset would be actively misleading.
   */
  rolledOver: boolean;
}

export interface ExtraUsage {
  enabled: boolean;
  utilization: number;
  usedCredits: number;
  monthlyLimit: number;
  currency: string;
  decimalPlaces: number;
  spendLimitReached: boolean;
  disabledReason?: string;
}

export interface UsageSnapshot {
  fetchedAt: number;
  ageMs: number;
  /** The identity this reading belongs to. */
  identity?: string;
  /**
   * Set when the reading was recorded by a different config directory than the
   * account being asked about. Quota belongs to the identity on Anthropic's
   * side, not to a directory, so any reading for the same identity is valid —
   * and using the freshest one across directories is strictly better than
   * showing nothing.
   */
  source?: string;
  /**
   * Claude Code itself ignores a cache older than an hour (`hzb = 3600000`), so
   * anything past that is reported as a historical reading rather than as the
   * current quota.
   */
  stale: boolean;
  buckets: UsageBucket[];
  extraUsage?: ExtraUsage;
}

/** Claude Code's own cutoff for trusting the cache. */
export const USAGE_FRESH_FOR_MS = 60 * 60 * 1000;

/**
 * Labels for the buckets the API returns. Anything not listed is still shown,
 * with its key humanised — new limit types should surface rather than vanish.
 */
const LABELS: Record<string, string> = {
  five_hour: "5-hour session",
  seven_day: "week",
  seven_day_opus: "week · Opus",
  seven_day_sonnet: "week · Sonnet",
  seven_day_cowork: "week · Cowork",
  seven_day_oauth_apps: "week · apps",
  seven_day_overage_included: "week · included overage",
};

/** Buckets whose names are internal codenames rather than user-facing limits. */
const HIDE_WHEN_EMPTY = new Set([
  "tangelo", "iguana_necktie", "omelette_promotional", "nimbus_quill",
  "cinder_cove", "amber_ladder", "seven_day_omelette",
]);

interface RawBucket {
  utilization?: unknown;
  resets_at?: unknown;
}

interface RawConfig {
  oauthAccount?: { accountUuid?: unknown };
  cachedUsageUtilization?: {
    fetchedAtMs?: unknown;
    accountUuid?: unknown;
    utilization?: Record<string, unknown>;
  };
}

/**
 * The best available reading for an account's quota.
 *
 * Claude Code records usage per config directory, but the limits it describes
 * belong to the identity. So if the same account is signed in somewhere else
 * claudeswitch knows about — another managed account, or Claude Code's own
 * ~/.claude — the freshest reading for that identity is used, and its origin is
 * reported.
 */
export function readUsage(slug: string, now = Date.now()): UsageSnapshot | null {
  const identity = accountIdentity(slug);
  const own = parseReading(accountConfigJson(slug), identity, now);

  if (!identity) return own;

  let best = own;
  for (const candidate of otherReadings(slug, identity, now)) {
    if (!best || candidate.fetchedAt > best.fetchedAt) best = candidate;
  }
  if (best && own && best.fetchedAt === own.fetchedAt) return own;
  return best;
}

/** The identity a config directory is signed in as. */
export function accountIdentity(slug: string): string | undefined {
  const uuid = readJson<RawConfig>(accountConfigJson(slug))?.oauthAccount?.accountUuid;
  return typeof uuid === "string" ? uuid : undefined;
}

/** Readings recorded by other directories for the same identity. */
function otherReadings(slug: string, identity: string, now: number): UsageSnapshot[] {
  const found: UsageSnapshot[] = [];

  for (const dir of siblingAccountDirs(slug)) {
    const reading = parseReading(join(ACCOUNTS_DIR, dir, ".claude.json"), identity, now);
    if (reading) found.push({ ...reading, source: `account ${dir}` });
  }

  const fromDefault = parseReading(DEFAULT_CLAUDE_JSON, identity, now);
  if (fromDefault) found.push({ ...fromDefault, source: "~/.claude" });

  return found;
}

function siblingAccountDirs(slug: string): string[] {
  try {
    return readdirSync(ACCOUNTS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== slug)
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Parse one `.claude.json`'s cached reading.
 *
 * `wantIdentity` is required to match when both sides know it — Claude Code
 * discards a cache belonging to a different identity, and so must this, or a
 * re-login as somebody else would show the previous account's quota.
 */
function parseReading(configPath: string, wantIdentity: string | undefined, now: number): UsageSnapshot | null {
  const config = readJson<RawConfig>(configPath);
  const cached = config?.cachedUsageUtilization;
  if (!cached || typeof cached.fetchedAtMs !== "number") return null;

  const readingIdentity =
    typeof cached.accountUuid === "string" ? cached.accountUuid : undefined;
  const dirIdentity =
    typeof config?.oauthAccount?.accountUuid === "string" ? config.oauthAccount.accountUuid : undefined;

  if (readingIdentity && dirIdentity && readingIdentity !== dirIdentity) return null;
  if (wantIdentity && readingIdentity && readingIdentity !== wantIdentity) return null;
  if (wantIdentity && !readingIdentity && dirIdentity && dirIdentity !== wantIdentity) return null;

  const ageMs = now - cached.fetchedAtMs;
  if (ageMs < 0) return null;

  const buckets: UsageBucket[] = [];
  let extraUsage: ExtraUsage | undefined;

  for (const [key, value] of Object.entries(cached.utilization ?? {})) {
    if (key === "extra_usage") {
      extraUsage = parseExtraUsage(value);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const raw = value as RawBucket;
    if (typeof raw.utilization !== "number") continue;
    if (raw.utilization === 0 && HIDE_WHEN_EMPTY.has(key)) continue;

    const resetsAt = typeof raw.resets_at === "string" ? parseTime(raw.resets_at) : undefined;
    buckets.push({
      key,
      label: LABELS[key] ?? humanise(key),
      utilization: raw.utilization,
      resetsAt,
      rolledOver: resetsAt !== undefined && resetsAt <= now,
    });
  }

  buckets.sort((a, b) => order(a.key) - order(b.key) || a.key.localeCompare(b.key));

  return {
    fetchedAt: cached.fetchedAtMs,
    ageMs,
    identity: readingIdentity ?? dirIdentity,
    stale: ageMs > USAGE_FRESH_FOR_MS,
    buckets,
    extraUsage,
  };
}

/**
 * The tightest limit right now — the one that will actually stop you. Windows
 * that have rolled over since the reading are excluded: their number no longer
 * describes anything.
 */
export function tightestBucket(snapshot: UsageSnapshot): UsageBucket | undefined {
  return snapshot.buckets
    .filter((b) => !b.rolledOver)
    .reduce<UsageBucket | undefined>(
      (worst, b) => (!worst || b.utilization > worst.utilization ? b : worst),
      undefined,
    );
}

function parseExtraUsage(value: unknown): ExtraUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.utilization !== "number") return undefined;
  return {
    enabled: raw.is_enabled === true,
    utilization: raw.utilization,
    usedCredits: typeof raw.used_credits === "number" ? raw.used_credits : 0,
    monthlyLimit: typeof raw.monthly_limit === "number" ? raw.monthly_limit : 0,
    currency: typeof raw.currency === "string" ? raw.currency : "USD",
    // `used_credits` and `monthly_limit` are minor units; the API says how many
    // decimal places that is rather than assuming cents.
    decimalPlaces: typeof raw.decimal_places === "number" ? raw.decimal_places : 2,
    spendLimitReached: raw.spend_limit_reached === true,
    disabledReason: typeof raw.disabled_reason === "string" ? raw.disabled_reason : undefined,
  };
}

function order(key: string): number {
  if (key === "five_hour") return 0;
  if (key === "seven_day") return 1;
  if (key.startsWith("seven_day")) return 2;
  return 3;
}

function humanise(key: string): string {
  return key.replace(/_/g, " ");
}

function parseTime(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Minor units to a readable amount: 1143 with 2 places becomes "11.43". */
export function formatCredits(minorUnits: number, decimalPlaces: number): string {
  const divisor = 10 ** decimalPlaces;
  return (minorUnits / divisor).toFixed(decimalPlaces);
}
