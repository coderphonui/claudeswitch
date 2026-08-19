import { UserError } from "./util.ts";

export interface Args {
  cmd: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
  /** Everything after a bare `--`. */
  passthrough: string[];
  raw: string[];
}

/**
 * Flags that consume the next argument. `--share skills` has to be told apart
 * from `--json accountname`, and there is no way to infer which is which.
 *
 * Every name read with `flagString` must appear here, or the value silently
 * becomes a positional and the caller silently falls back to its default. There
 * is a test that keeps the two in step.
 */
export const VALUE_FLAGS = new Set([
  "alias",
  "email",
  "everyDays",
  "from",
  "label",
  "notes",
  "session",
  "share",
  "shell",
]);

export function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const passthrough: string[] = [];
  let afterDashDash = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (afterDashDash) { passthrough.push(token); continue; }
    if (token === "--") { afterDashDash = true; continue; }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[normalize(body.slice(0, eq))] = body.slice(eq + 1);
        continue;
      }
      const name = normalize(body);
      if (body.startsWith("no-")) { flags[normalize(body.slice(3))] = false; continue; }
      if (VALUE_FLAGS.has(name) && i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) {
        flags[name] = argv[++i]!;
        continue;
      }
      flags[name] = true;
      continue;
    }

    if (token.startsWith("-") && token.length > 1 && token !== "-") {
      for (const ch of token.slice(1)) flags[ch] = true;
      continue;
    }

    positionals.push(token);
  }

  const cmd = positionals.shift() ?? "";
  return { cmd, positionals, flags, passthrough, raw: argv };
}

function normalize(name: string): string {
  return name.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

function dashed(name: string): string {
  return "--" + name.replace(/[A-Z]/g, (ch) => "-" + ch.toLowerCase());
}

/**
 * Read a flag's value.
 *
 * A flag present without a value is an error rather than a silent fallback to
 * the default: `--every-days` with the number left off used to schedule the
 * default interval and report success, which is worse than refusing.
 */
export function flagString(args: Args, name: string): string | undefined {
  const value = args.flags[name];
  if (value === undefined || value === false) return undefined;
  if (value === true) {
    throw new UserError(`${dashed(name)} needs a value.`, `For example: ${dashed(name)} <value>`);
  }
  return value;
}

export function flagBool(args: Args, name: string, fallback = false): boolean {
  const v = args.flags[name];
  return typeof v === "boolean" ? v : v === undefined ? fallback : v !== "false" && v !== "0";
}

/** Flags accepted everywhere. */
const GLOBAL_FLAGS = ["help", "h", "version", "V", "json", "color", "emitShell", "quiet"];

/**
 * Reject flags a command does not know.
 *
 * Without this, a typo is silently ignored — and on a destructive command that
 * is a real hazard: `cs rm work --purgee` archived the account and reported
 * success, giving no hint that the purge never happened.
 */
export function assertKnownFlags(args: Args, accepted: readonly string[]): void {
  const known = new Set([...GLOBAL_FLAGS, ...accepted]);
  const unknown = Object.keys(args.flags).filter((f) => !known.has(f));
  if (!unknown.length) return;

  const suggestion = closest(unknown[0]!, [...known]);
  throw new UserError(
    `Unknown option${unknown.length > 1 ? "s" : ""} for \`${args.cmd || "use"}\`: ${unknown.map(dashed).join(", ")}`,
    suggestion
      ? `Did you mean ${dashed(suggestion)}?`
      : accepted.length
        ? `Accepted here: ${accepted.map(dashed).join(", ")}`
        : "This command takes no options.",
  );
}

/** Cheap edit-distance pick, only to make a typo obvious. */
function closest(input: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const score = distance(input.toLowerCase(), candidate.toLowerCase());
    if (score < bestScore) { bestScore = score; best = candidate; }
  }
  return bestScore <= Math.max(2, Math.floor(input.length / 3)) ? best : undefined;
}

function distance(a: string, b: string): number {
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, i) => i)];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        (rows[i - 1]![j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (rows[i - 1]![j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    rows.push(row);
  }
  return rows[a.length]![b.length]!;
}
