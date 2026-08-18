import {
  chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync,
  writeFileSync, writeSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { RESERVED_NAMES } from "./reserved.ts";

export class UserError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "UserError";
  }
}

export function lstatSafe(p: string) {
  try { return lstatSync(p); } catch { return null; }
}

export function statSafe(p: string) {
  try { return statSync(p); } catch { return null; }
}

export function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true, mode: 0o700 });
}

export function readJson<T>(p: string): T | null {
  try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return null; }
}

/**
 * Write via temp file + rename so a crash can never leave a half-written file.
 * The temp name carries the pid so two processes writing at the same instant
 * cannot rename each other's file away.
 */
export function writeJsonAtomic(p: string, value: unknown, mode = 0o600): void {
  ensureDir(dirname(p));
  const unique = `${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const tmp = join(dirname(p), `.${unique}.tmp`);
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode });
  try {
    renameSync(tmp, p);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

/** Block the current process for roughly `ms` without spinning the CPU. */
function sleepSync(ms: number): void {
  try {
    const view = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(view, 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* fallback busy wait */ }
  }
}

const STALE_LOCK_MS = 15_000;

/**
 * Advisory cross-process lock built on O_EXCL, so concurrent terminals cannot
 * interleave a read-modify-write of shared state. A lock older than
 * STALE_LOCK_MS is assumed to belong to a crashed process and is broken.
 */
export function withLock<T>(lockPath: string, fn: () => T, timeoutMs = 5_000): T {
  ensureDir(dirname(lockPath));
  const deadline = Date.now() + timeoutMs;
  let fd: number | null = null;

  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, `${process.pid}\n`);
    } catch {
      const st = statSafe(lockPath);
      if (st && Date.now() - st.mtimeMs > STALE_LOCK_MS) {
        try { unlinkSync(lockPath); } catch { /* another process won the race */ }
        continue;
      }
      if (Date.now() > deadline) {
        throw new UserError(
          "Timed out waiting for another claudeswitch process to finish.",
          `If nothing else is running, delete the stale lock: ${lockPath}`,
        );
      }
      sleepSync(30);
    }
  }

  try {
    return fn();
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  }
}

export function removePath(p: string): void {
  const st = lstatSafe(p);
  if (!st) return;
  if (st.isSymbolicLink() || st.isFile()) unlinkSync(p);
  else rmSync(p, { recursive: true, force: true });
}

export interface CopySkip {
  path: string;
  reason: string;
}

/**
 * Recursive copy that survives real-world config directories.
 *
 * `fs.cpSync` with `dereference` throws on a dangling symlink, and ~/.claude
 * legitimately contains them (a skill linked to a repo that has since moved).
 * Symlinks are therefore copied verbatim — which is also what you want for
 * skills and plugins linked out of a checkout — and anything unreadable is
 * reported instead of aborting the whole copy.
 */
export function copyPath(from: string, to: string, skipped: CopySkip[] = []): CopySkip[] {
  const st = lstatSafe(from);
  if (!st) {
    skipped.push({ path: from, reason: "does not exist" });
    return skipped;
  }
  ensureDir(dirname(to));

  if (st.isSymbolicLink()) {
    try {
      removePath(to);
      symlinkSync(readlinkSync(from), to);
    } catch (err) {
      skipped.push({ path: from, reason: `symlink: ${errText(err)}` });
    }
    return skipped;
  }

  if (st.isDirectory()) {
    // Fast path: on APFS, clonefile(2) copies a directory tree instantly and
    // shares its blocks until something is modified. ~/.claude/plugins is
    // routinely hundreds of megabytes, so this is the difference between an
    // import that feels instant and one that copies half a gigabyte.
    if (!pathExists(to) && cloneTree(from, to)) return skipped;

    ensureDir(to);
    let entries: string[] = [];
    try {
      entries = readdirSync(from);
    } catch (err) {
      skipped.push({ path: from, reason: `unreadable directory: ${errText(err)}` });
      return skipped;
    }
    for (const entry of entries) copyPath(join(from, entry), join(to, entry), skipped);
    return skipped;
  }

  if (st.isFile()) {
    try {
      copyFileSync(from, to);
      chmodSync(to, st.mode & 0o7777);
    } catch (err) {
      skipped.push({ path: from, reason: errText(err) });
    }
    return skipped;
  }

  skipped.push({ path: from, reason: "not a regular file" });
  return skipped;
}

/** APFS copy-on-write clone. Returns false when the platform cannot do it. */
function cloneTree(from: string, to: string): boolean {
  if (process.platform !== "darwin") return false;
  const r = spawnSync("/bin/cp", ["-Rc", from, to], { stdio: "ignore" });
  if (r.status === 0) return true;
  // A partial clone would be worse than none: start over with the walker.
  if (pathExists(to)) removePath(to);
  return false;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function pathExists(p: string): boolean {
  return existsSync(p);
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export function assertSlug(slug: string): string {
  if (!SLUG_RE.test(slug)) {
    throw new UserError(
      `Invalid account name: ${JSON.stringify(slug)}`,
      "Use 1-32 chars: lowercase letters, digits, dot, dash, underscore; must start with a letter or digit.",
    );
  }
  if (RESERVED_NAMES.has(slug)) {
    throw new UserError(
      `"${slug}" is a claudeswitch command, so it cannot be an account name.`,
      "Pick another name — `cs <name>` has to stay unambiguous.",
    );
  }
  return slug;
}

export function slugify(input: string): string {
  const s = input.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 32) || "account";
}

/** Single-quote a string for POSIX shells. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function relTime(ms: number): string {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [1000 * 60 * 60 * 24 * 365, "y"],
    [1000 * 60 * 60 * 24 * 30, "mo"],
    [1000 * 60 * 60 * 24, "d"],
    [1000 * 60 * 60, "h"],
    [1000 * 60, "m"],
    [1000, "s"],
  ];
  for (const [size, label] of units) {
    if (abs >= size) {
      const n = Math.floor(abs / size);
      return diff >= 0 ? `in ${n}${label}` : `${n}${label} ago`;
    }
  }
  return diff >= 0 ? "now" : "just now";
}
