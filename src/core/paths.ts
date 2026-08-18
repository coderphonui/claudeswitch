import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();

/** Root of all claudeswitch state. Overridable for tests. */
export const ROOT = process.env.CLAUDESWITCH_HOME?.trim()
  ? process.env.CLAUDESWITCH_HOME.trim()
  : join(HOME, ".claudeswitch");

export const ACCOUNTS_DIR = join(ROOT, "accounts");
export const SHARED_DIR = join(ROOT, "shared");
export const ARCHIVE_DIR = join(ROOT, "archive");
export const REGISTRY_FILE = join(ROOT, "registry.json");

/** Claude Code's own default locations (used when no CLAUDE_CONFIG_DIR is set). */
export const DEFAULT_CLAUDE_DIR = join(HOME, ".claude");
export const DEFAULT_CLAUDE_JSON = join(HOME, ".claude.json");

export function accountDir(slug: string): string {
  return join(ACCOUNTS_DIR, slug);
}

/**
 * Claude Code keeps its global config at `~/.claude.json` for the default dir,
 * but at `<CLAUDE_CONFIG_DIR>/.claude.json` for a custom one.
 */
export function accountConfigJson(slug: string): string {
  return join(accountDir(slug), ".claude.json");
}

export function accountCredentials(slug: string): string {
  return join(accountDir(slug), ".credentials.json");
}

/**
 * A long-lived token from `claude setup-token`. Claude Code reads it from the
 * environment rather than from disk, so claudeswitch stores it and exports it.
 */
export function accountLongLivedToken(slug: string): string {
  return join(accountDir(slug), ".long-lived-token");
}
