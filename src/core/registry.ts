import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNTS_DIR, REGISTRY_FILE, ROOT, SHARED_DIR } from "./paths.ts";
import type { AccountRecord, Registry, SharePolicy } from "./types.ts";
import { ensureDir, pathExists, readJson, UserError, withLock, writeJsonAtomic } from "./util.ts";

const LOCK_FILE = join(ROOT, ".registry.lock");

const EMPTY: Registry = { version: 1, accounts: {}, shareDefault: "all" };

export function loadRegistry(): Registry {
  // A corrupt registry must never look like an empty one: the next write would
  // then overwrite it, losing every account's metadata for good.
  if (pathExists(REGISTRY_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not a JSON object");
      }
    } catch (err) {
      throw new UserError(
        `${REGISTRY_FILE} is not readable as JSON: ${err instanceof Error ? err.message : String(err)}`,
        [
          "Nothing was changed. Your account directories are untouched — only this index is damaged.",
          `Inspect it, or move it aside and rebuild: mv ${REGISTRY_FILE} ${REGISTRY_FILE}.broken`,
          "then run: claudeswitch repair --adopt",
        ].join("\n"),
      );
    }
  }

  const raw = readJson<Partial<Registry>>(REGISTRY_FILE);
  if (!raw || typeof raw !== "object") return { ...EMPTY, accounts: {} };
  const accounts: Record<string, AccountRecord> = {};
  for (const [slug, rec] of Object.entries(raw.accounts ?? {})) {
    if (!rec || typeof rec !== "object") continue;
    accounts[slug] = {
      ...(rec as AccountRecord),
      slug,
      share: normalizeShare((rec as AccountRecord).share ?? raw.shareDefault ?? "all"),
      createdAt: (rec as AccountRecord).createdAt ?? new Date().toISOString(),
      aliases: cleanAliases((rec as AccountRecord).aliases, slug),
      // Legacy entries predate the key; their credentials live under the hash of
      // the directory they already occupy, so that is the correct value.
      securestorageKey: (rec as AccountRecord).securestorageKey ?? join(ACCOUNTS_DIR, slug),
    };
  }

  // A hand-edited registry could point one alias at two accounts, or shadow a
  // real account name. Resolution has to be unambiguous, so drop the strays.
  const claimed = new Set(Object.keys(accounts));
  for (const acc of Object.values(accounts)) {
    acc.aliases = acc.aliases?.filter((alias) => {
      if (claimed.has(alias)) return false;
      claimed.add(alias);
      return true;
    });
    if (!acc.aliases?.length) delete acc.aliases;
  }
  return {
    version: raw.version ?? 1,
    accounts,
    defaultAccount: raw.defaultAccount,
    shareDefault: normalizeShare(raw.shareDefault ?? "all"),
  };
}

/** Create the state layout. Safe to call repeatedly. */
export function ensureState(): void {
  ensureDir(ROOT);
  ensureDir(ACCOUNTS_DIR);
  ensureDir(SHARED_DIR);
}

/**
 * Read-modify-write the registry under a cross-process lock.
 *
 * Every mutation goes through here. Without it, two terminals switching or
 * adding accounts at the same moment would each save their own stale snapshot
 * and silently drop the other's changes.
 *
 * Keep `fn` short: it must not wait on a browser login or a network call.
 */
export function mutateRegistry<T>(fn: (reg: Registry) => T): T {
  ensureState();
  return withLock(LOCK_FILE, () => {
    const reg = loadRegistry();
    const result = fn(reg);
    writeJsonAtomic(REGISTRY_FILE, reg);
    return result;
  });
}

/** Record that an account was activated. */
export function touchAccount(slug: string): void {
  mutateRegistry((reg) => {
    const acc = reg.accounts[slug];
    if (acc) acc.lastUsedAt = new Date().toISOString();
  });
}

export function normalizeShare(value: SharePolicy | undefined): SharePolicy {
  if (value === "none" || value === "all") return value;
  if (Array.isArray(value)) {
    const list = [...new Set(value.filter((v) => typeof v === "string" && v.length))].sort();
    if (!list.length) return "none";
    return list;
  }
  return "all";
}

/**
 * The macOS Keychain namespace for an account, defaulting to its directory for
 * accounts created before the field existed. Backfilled on first write so the
 * value is pinned before anything can rename the directory.
 */
export function storageKeyFor(reg: Registry, slug: string): string {
  const acc = reg.accounts[slug];
  return acc?.securestorageKey ?? join(ACCOUNTS_DIR, slug);
}

/** Look up an account by its name or by any of its aliases. */
export function resolveName(reg: Registry, name: string): AccountRecord | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  const direct = reg.accounts[key];
  if (direct) return direct;
  return listAccounts(reg).find((acc) => acc.aliases?.includes(key));
}

export function getAccount(reg: Registry, name: string): AccountRecord {
  const acc = resolveName(reg, name);
  if (!acc) {
    const known = listAccounts(reg).map(describeName);
    throw new UserError(
      `No account named "${name}".`,
      known.length
        ? `Known accounts: ${known.join(", ")}`
        : `Add one first: claudeswitch add ${name}`,
    );
  }
  return acc;
}

/** "work (w, cty)" — the name plus its aliases, for messages and listings. */
export function describeName(acc: AccountRecord): string {
  return acc.aliases?.length ? `${acc.slug} (${acc.aliases.join(", ")})` : acc.slug;
}

function cleanAliases(value: unknown, slug: string): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = [
    ...new Set(
      value
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim().toLowerCase())
        .filter((v) => v.length > 0 && v !== slug),
    ),
  ].sort();
  return list.length ? list : undefined;
}

export function listAccounts(reg: Registry): AccountRecord[] {
  return Object.values(reg.accounts).sort((a, b) => a.slug.localeCompare(b.slug));
}

export function upsertAccount(reg: Registry, acc: AccountRecord): void {
  reg.accounts[acc.slug] = acc;
}

/** Account directories on disk that the registry does not know about. */
export function orphanDirs(reg: Registry): string[] {
  try {
    return readdirSync(ACCOUNTS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !reg.accounts[e.name])
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function findByEmail(reg: Registry, email: string): AccountRecord | undefined {
  const target = email.trim().toLowerCase();
  return listAccounts(reg).find((a) => a.email?.trim().toLowerCase() === target);
}
