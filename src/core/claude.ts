import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { readLongLivedToken } from "./creds.ts";
import { accountDir } from "./paths.ts";
import { loadRegistry, mutateRegistry, storageKeyFor } from "./registry.ts";
import type { AuthStatus } from "./types.ts";
import { UserError } from "./util.ts";

let cachedBin: string | null | undefined;

/**
 * Where Claude Code installs itself, in the order we prefer them.
 *
 * PATH alone is not enough: a launchd agent inherits only
 * /usr/bin:/bin:/usr/sbin:/sbin, so the scheduled refresh would never find a
 * `claude` living under ~/.local/bin. Found the hard way — the first real
 * keep-warm run failed with "claude not found".
 */
function claudeCandidates(): string[] {
  const home = process.env.HOME ?? "";
  return [
    join(home, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    join(home, ".claude", "local", "claude"),
    join(home, ".bun", "bin", "claude"),
    join(home, ".npm-global", "bin", "claude"),
  ].filter((p) => p && !p.startsWith("/.local"));
}

export function findClaudeBin(): string | null {
  if (cachedBin !== undefined) return cachedBin;

  const fromPath = spawnSync("/usr/bin/env", ["sh", "-c", "command -v claude"], { encoding: "utf8" });
  const onPath = fromPath.stdout?.trim().split("\n")[0]?.trim();
  if (onPath) {
    cachedBin = onPath;
    return cachedBin;
  }

  for (const candidate of claudeCandidates()) {
    try {
      accessSync(candidate, constants.X_OK);
      cachedBin = candidate;
      return cachedBin;
    } catch {
      /* keep looking */
    }
  }

  cachedBin = null;
  return cachedBin;
}

export function requireClaudeBin(): string {
  const bin = findClaudeBin();
  if (!bin) {
    throw new UserError(
      "The `claude` CLI could not be found.",
      "Install Claude Code first: https://claude.com/product/claude-code",
    );
  }
  return bin;
}

export function claudeVersion(): string | null {
  const bin = findClaudeBin();
  if (!bin) return null;
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000 });
  return r.stdout?.trim() || null;
}

/**
 * Environment for running `claude` against one account's config dir.
 *
 * ANTHROPIC_* overrides are stripped: if they leak in, Claude Code uses them
 * instead of the account's stored OAuth credentials, so both auth probes and
 * launched sessions would silently run as the wrong identity.
 */
/**
 * Environment for running `claude` as one account.
 *
 * The Keychain namespace is resolved from the registry here rather than passed
 * in by callers: getting it wrong silently logs an account out, and a single
 * forgotten call site would be enough to do it.
 */
export function accountEnv(
  slug: string,
  base: NodeJS.ProcessEnv = process.env,
  storageKey = storageKeyFor(loadRegistry(), slug),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  ]) {
    delete env[key];
  }
  env.CLAUDE_CONFIG_DIR = accountDir(slug);
  env.CLAUDESWITCH_ACCOUNT = slug;
  // Pins the macOS Keychain entry so it survives renames and moves.
  env.CLAUDE_SECURESTORAGE_CONFIG_DIR = storageKey;

  // A long-lived token from `claude setup-token` is only readable from the
  // environment, so it has to be injected here for run/exec/refresh as well.
  const longLived = readLongLivedToken(slug);
  if (longLived) env.CLAUDE_CODE_OAUTH_TOKEN = longLived;
  else delete env.CLAUDE_CODE_OAUTH_TOKEN;

  return env;
}

/** The ANTHROPIC_* / provider vars currently set in this shell, if any. */
export function conflictingEnvVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
  ].filter((k) => (env[k] ?? "").length > 0);
}

export function authStatus(slug: string): AuthStatus {
  const bin = findClaudeBin();
  if (!bin) return { loggedIn: false };
  const r = spawnSync(bin, ["auth", "status", "--json"], {
    encoding: "utf8",
    env: accountEnv(slug),
    timeout: 30_000,
  });
  const text = (r.stdout ?? "").trim();
  const start = text.indexOf("{");
  if (start === -1) return { loggedIn: false };
  try {
    const status = JSON.parse(text.slice(start)) as AuthStatus;
    cacheAuthState(slug, status);
    return status;
  } catch {
    return { loggedIn: false };
  }
}

/**
 * Remember what the probe said, so the account picker can show login state
 * without paying for a probe of its own. Written only when something changed.
 */
function cacheAuthState(slug: string, status: AuthStatus): void {
  const state = status.loggedIn ? "ok" : "logged-out";
  try {
    const current = loadRegistry().accounts[slug];
    if (!current) return;
    const sameState = current.authState === state;
    const sameEmail = !status.email || current.email === status.email;
    const fresh = current.authCheckedAt
      ? Date.now() - Date.parse(current.authCheckedAt) < 60_000
      : false;
    if (sameState && sameEmail && fresh) return;

    mutateRegistry((reg) => {
      const acc = reg.accounts[slug];
      if (!acc) return;
      acc.authState = state;
      acc.authCheckedAt = new Date().toISOString();
      if (status.loggedIn) {
        acc.email = status.email ?? acc.email;
        acc.orgName = status.orgName ?? acc.orgName;
        acc.orgId = status.orgId ?? acc.orgId;
        acc.subscriptionType = status.subscriptionType ?? acc.subscriptionType;
        acc.authMethod = status.authMethod ?? acc.authMethod;
      }
    });
  } catch {
    // Caching is an optimisation; never let it break the probe it decorates.
  }
}

/** Interactive: opens a browser and takes over the terminal until done. */
export function authLogin(slug: string, opts: { email?: string; console?: boolean } = {}): number {
  const bin = requireClaudeBin();
  const args = ["auth", "login"];
  if (opts.console) args.push("--console");
  if (opts.email) args.push("--email", opts.email);
  const r = spawnSync(bin, args, { stdio: "inherit", env: accountEnv(slug) });
  return r.status ?? 1;
}

export function authLogout(slug: string): number {
  const bin = requireClaudeBin();
  const r = spawnSync(bin, ["auth", "logout"], { stdio: "inherit", env: accountEnv(slug) });
  return r.status ?? 1;
}

/** Auth status of Claude Code's *default* (unmanaged) config dir. */
export function authStatusDefault(): AuthStatus {
  const bin = findClaudeBin();
  if (!bin) return { loggedIn: false };
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR;
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) delete env[key];
  const r = spawnSync(bin, ["auth", "status", "--json"], { encoding: "utf8", env, timeout: 30_000 });
  const text = (r.stdout ?? "").trim();
  const start = text.indexOf("{");
  if (start === -1) return { loggedIn: false };
  try {
    return JSON.parse(text.slice(start)) as AuthStatus;
  } catch {
    return { loggedIn: false };
  }
}
