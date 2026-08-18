import { createHash } from "node:crypto";
import { accountDir } from "./paths.ts";
import type { AccountRecord } from "./types.ts";

/**
 * On macOS, Claude Code keeps OAuth credentials in the login Keychain rather
 * than in `<config dir>/.credentials.json`, and it namespaces the entry:
 *
 *   service = "Claude Code-credentials" + "-" + sha256(dir).slice(0, 8)
 *   account = $USER
 *
 * where `dir` is CLAUDE_SECURESTORAGE_CONFIG_DIR when that is set, otherwise
 * CLAUDE_CONFIG_DIR. With neither set, the service has no suffix at all — that
 * is the entry Claude Code's own ~/.claude uses.
 *
 * Two consequences drive the design here. The good one: per-directory entries
 * are what makes several accounts usable at once, and the secret sits in the
 * Keychain instead of a plaintext file. The dangerous one: the entry is keyed by
 * the directory *path*, so renaming an account or moving ~/.claudeswitch would
 * orphan its credentials and silently log it out.
 *
 * So every account carries a `securestorageKey` that is fixed when the account
 * is created and never changes again, and claudeswitch exports it on every
 * switch. Renames and moves then leave the Keychain entry exactly where it is.
 */
export function securestorageKey(acc: AccountRecord): string {
  return acc.securestorageKey ?? accountDir(acc.slug);
}

/** The Keychain service name Claude Code would use for a given key. */
export function keychainService(key: string): string {
  const digest = createHash("sha256").update(key.normalize("NFC")).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${digest}`;
}

/** True when the account's stable key no longer matches its directory. */
export function keyIsDetached(acc: AccountRecord): boolean {
  return securestorageKey(acc) !== accountDir(acc.slug);
}
