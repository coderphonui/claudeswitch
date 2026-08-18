import { readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ARCHIVE_DIR, SHARED_DIR, accountDir } from "./paths.ts";
import type { SharePolicy } from "./types.ts";
import {
  copyPath, ensureDir, lstatSafe, pathExists, removePath, statSafe, timestamp, UserError,
} from "./util.ts";

export interface Shareable {
  name: string;
  kind: "file" | "dir";
  what: string;
}

/**
 * Assets that are safe to share between accounts: static configuration that
 * carries no identity. Everything else (.credentials.json, .claude.json,
 * projects/, sessions/, history.jsonl) stays private to each account.
 */
export const SHAREABLE: Shareable[] = [
  { name: "settings.json", kind: "file", what: "global settings" },
  { name: "CLAUDE.md", kind: "file", what: "global memory" },
  { name: "keybindings.json", kind: "file", what: "key bindings" },
  { name: "skills", kind: "dir", what: "skills" },
  { name: "plugins", kind: "dir", what: "plugins & marketplaces" },
  { name: "agents", kind: "dir", what: "subagents" },
  { name: "commands", kind: "dir", what: "slash commands" },
  { name: "hooks", kind: "dir", what: "hooks" },
  { name: "output-styles", kind: "dir", what: "output styles" },
];

export const SHAREABLE_NAMES = SHAREABLE.map((s) => s.name);

export function resolveShare(policy: SharePolicy): Shareable[] {
  if (policy === "none") return [];
  if (policy === "all") return SHAREABLE;
  return SHAREABLE.filter((s) => policy.includes(s.name));
}

export function parseSharePolicy(input: string): SharePolicy {
  const raw = input.trim().toLowerCase();
  if (raw === "all" || raw === "*") return "all";
  if (raw === "none" || raw === "-") return "none";
  const items = raw.split(/[,\s]+/).filter(Boolean);
  const unknown = items.filter((i) => !SHAREABLE_NAMES.includes(i));
  if (unknown.length) {
    throw new UserError(
      `Not shareable: ${unknown.join(", ")}`,
      `Shareable assets: ${SHAREABLE_NAMES.join(", ")} (or "all" / "none")`,
    );
  }
  return items.length ? [...new Set(items)].sort() : "none";
}

export function describeShare(policy: SharePolicy): string {
  if (policy === "all") return "all";
  if (policy === "none") return "none";
  return policy.join(",");
}

export type SyncAction =
  | { kind: "linked"; asset: string }
  | { kind: "ok"; asset: string }
  | { kind: "relinked"; asset: string }
  | { kind: "seeded"; asset: string }
  | { kind: "promoted"; asset: string; backup: string }
  | { kind: "archived"; asset: string; backup: string }
  | { kind: "unshared"; asset: string };

function seedSharedTarget(asset: Shareable): void {
  const target = join(SHARED_DIR, asset.name);
  if (pathExists(target)) return;
  ensureDir(SHARED_DIR);
  if (asset.kind === "dir") ensureDir(target);
  else writeFileSync(target, asset.name.endsWith(".json") ? "{}\n" : "", { mode: 0o600, flag: "wx" });
}

function archive(slug: string, name: string, from: string): string {
  const dest = join(ARCHIVE_DIR, slug, timestamp(), name);
  copyPath(from, dest);
  removePath(from);
  return dest;
}

/**
 * Make an account's shared assets point at `~/.claudeswitch/shared`.
 *
 * Claude Code sometimes rewrites `settings.json` by replacing the file rather
 * than writing through it, which silently breaks a symlink. Every `use` runs
 * this, and a real file found where a link should be is never discarded: it is
 * promoted into `shared/` when it is newer, otherwise copied into `archive/`.
 */
export function syncShare(slug: string, policy: SharePolicy): SyncAction[] {
  const dir = accountDir(slug);
  ensureDir(dir);
  const wanted = resolveShare(policy);
  const wantedNames = new Set(wanted.map((s) => s.name));
  const actions: SyncAction[] = [];

  // Assets that are no longer shared: give the account its own copy.
  for (const asset of SHAREABLE) {
    if (wantedNames.has(asset.name)) continue;
    const link = join(dir, asset.name);
    const st = lstatSafe(link);
    if (!st?.isSymbolicLink()) continue;
    const target = resolveLink(link);
    removePath(link);
    if (target && pathExists(target)) copyPath(target, link);
    actions.push({ kind: "unshared", asset: asset.name });
  }

  for (const asset of wanted) {
    const link = join(dir, asset.name);
    const target = join(SHARED_DIR, asset.name);
    const st = lstatSafe(link);

    if (st?.isSymbolicLink()) {
      if (resolveLink(link) === target) {
        seedSharedTarget(asset);
        actions.push({ kind: "ok", asset: asset.name });
        continue;
      }
      removePath(link);
      seedSharedTarget(asset);
      linkTo(dir, asset.name, target);
      actions.push({ kind: "relinked", asset: asset.name });
      continue;
    }

    if (st) {
      // A real file or directory sits where the link belongs.
      if (!pathExists(target)) {
        ensureDir(SHARED_DIR);
        copyPath(link, target);
        removePath(link);
        linkTo(dir, asset.name, target);
        actions.push({ kind: "seeded", asset: asset.name });
        continue;
      }
      // Identical content: the link was clobbered but nothing actually changed.
      if (asset.kind === "file" && sameFile(link, target)) {
        removePath(link);
        linkTo(dir, asset.name, target);
        actions.push({ kind: "relinked", asset: asset.name });
        continue;
      }
      const localM = statSafe(link)?.mtimeMs ?? 0;
      const sharedM = statSafe(target)?.mtimeMs ?? 0;
      // `>=` favours the local file on a timestamp tie: it is the copy Claude
      // Code just wrote, and the losing side is archived either way.
      if (asset.kind === "file" && localM >= sharedM) {
        const backup = archiveShared(asset.name);
        copyPath(link, target);
        removePath(link);
        linkTo(dir, asset.name, target);
        actions.push({ kind: "promoted", asset: asset.name, backup });
      } else {
        const backup = archive(slug, asset.name, link);
        linkTo(dir, asset.name, target);
        actions.push({ kind: "archived", asset: asset.name, backup });
      }
      continue;
    }

    seedSharedTarget(asset);
    linkTo(dir, asset.name, target);
    actions.push({ kind: "linked", asset: asset.name });
  }

  return actions;
}

function sameFile(a: string, b: string): boolean {
  try {
    return readFileSync(a, "utf8") === readFileSync(b, "utf8");
  } catch {
    return false;
  }
}

function archiveShared(name: string): string {
  const dest = join(ARCHIVE_DIR, "shared", timestamp(), name);
  copyPath(join(SHARED_DIR, name), dest);
  return dest;
}

/** Relative symlinks keep the whole ~/.claudeswitch tree movable. */
function linkTo(dir: string, name: string, target: string): void {
  const rel = relative(dir, target);
  symlinkSync(rel, join(dir, name));
}

function resolveLink(link: string): string | null {
  try {
    const raw = readlinkSync(link);
    return isAbsolute(raw) ? resolve(raw) : resolve(join(link, "..", raw));
  } catch {
    return null;
  }
}

/** True when every shared asset for this policy is a correct symlink. */
export function shareHealth(slug: string, policy: SharePolicy): { ok: boolean; broken: string[] } {
  const dir = accountDir(slug);
  const broken: string[] = [];
  for (const asset of resolveShare(policy)) {
    const link = join(dir, asset.name);
    const st = lstatSafe(link);
    if (!st?.isSymbolicLink() || resolveLink(link) !== join(SHARED_DIR, asset.name)) {
      broken.push(asset.name);
    }
  }
  return { ok: broken.length === 0, broken };
}
