import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { accountCredentials, accountLongLivedToken } from "./paths.ts";
import type { CredentialInfo } from "./types.ts";
import { pathExists, readJson } from "./util.ts";

interface RawCreds {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    refreshTokenExpiresAt?: number;
    subscriptionType?: string;
    rateLimitTier?: string;
    scopes?: string[];
  };
}

const DAY = 86_400_000;

/**
 * Read what can be learned about an account's credentials from disk.
 *
 * On macOS, Claude Code stores OAuth credentials in the login Keychain and
 * leaves no `.credentials.json` behind, so an absent file means "look
 * elsewhere", not "logged out". Reading the Keychain would need the `security`
 * tool and would pop an authorisation dialog, so instead `storage: "keychain"`
 * is reported and the live state comes from `claude auth status`.
 *
 * Token values never leave this function: what escapes is a truncated SHA-256
 * of the refresh token, enough to tell whether two accounts hold the same
 * credential without ever exposing it.
 */
export function readCredentialInfo(slug: string): CredentialInfo {
  if (pathExists(accountLongLivedToken(slug))) {
    return { present: true, kind: "long-lived", storage: "long-lived-file" };
  }

  const raw = readJson<RawCreds>(accountCredentials(slug));
  if (!raw) {
    return { present: false, kind: "unknown", storage: "keychain" };
  }
  const oauth = raw.claudeAiOauth;

  return {
    present: true,
    storage: "file",
    // An inference-only token from `claude setup-token` has no refresh token
    // and no expiry: it is static until revoked.
    kind: oauth?.refreshToken ? "oauth" : "long-lived",
    expiresAt: typeof oauth?.expiresAt === "number" ? oauth.expiresAt : undefined,
    refreshTokenExpiresAt:
      typeof oauth?.refreshTokenExpiresAt === "number" ? oauth.refreshTokenExpiresAt : undefined,
    subscriptionType: oauth?.subscriptionType,
    rateLimitTier: oauth?.rateLimitTier,
    scopes: Array.isArray(oauth?.scopes) ? oauth.scopes : undefined,
    fingerprint: oauth?.refreshToken ? fingerprint(oauth.refreshToken) : undefined,
  };
}

/** Identifies a credential without revealing it. */
function fingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 16);
}

/** Fingerprint of whatever credential Claude Code's own ~/.claude holds. */
export function defaultDirFingerprint(credentialsPath: string): string | undefined {
  const raw = readJson<RawCreds>(credentialsPath);
  const token = raw?.claudeAiOauth?.refreshToken;
  return token ? fingerprint(token) : undefined;
}

export function accessTokenExpired(info: CredentialInfo): boolean {
  return info.present && typeof info.expiresAt === "number" && info.expiresAt <= Date.now();
}

/** True when only `claude auth status` can say whether this account works. */
export function needsLiveProbe(info: CredentialInfo): boolean {
  return info.storage === "keychain";
}

/** How long a cached `claude auth status` answer is worth showing. */
const CACHE_GOOD_FOR_MS = 7 * DAY;

export type LoginState = "ok" | "logged-out" | "expired" | "unknown";

/**
 * What to display without spending 200ms on a probe.
 *
 * The distinction that matters is between "known to be logged out" and "not
 * knowable from here". A Keychain-backed credential is invisible to us, so
 * guessing "not logged in" would libel a perfectly good account — which is
 * exactly what the account picker used to do.
 */
export function knownLoginState(
  info: CredentialInfo,
  cached?: { authState?: "ok" | "logged-out"; authCheckedAt?: string },
): LoginState {
  if (info.kind === "long-lived") return "ok";

  if (info.storage === "file") {
    if (!info.present) return "logged-out";
    return needsLogin(info) ? "expired" : "ok";
  }

  if (cached?.authState && cached.authCheckedAt) {
    const age = Date.now() - Date.parse(cached.authCheckedAt);
    if (Number.isFinite(age) && age >= 0 && age < CACHE_GOOD_FOR_MS) return cached.authState;
  }
  return "unknown";
}

/**
 * An expired access token is normal — Claude Code refreshes it silently on the
 * next request. Only an expired *refresh* token actually requires a new login.
 */
export function needsLogin(info: CredentialInfo): boolean {
  // A Keychain-backed account tells us nothing from disk; never guess "expired".
  if (info.storage === "keychain") return false;
  if (!info.present) return true;
  if (info.kind === "long-lived") return false;
  if (typeof info.refreshTokenExpiresAt === "number" && info.refreshTokenExpiresAt <= Date.now()) {
    return true;
  }
  return false;
}

/**
 * Whole days until this account would need an interactive login.
 *
 * Claude Code issues refresh tokens with a 30-day life and mints a fresh one
 * every time it refreshes, so this is a deadline for *idleness*, not for use:
 * anything touched inside the window keeps rolling forward. `undefined` means
 * there is no deadline to track (a long-lived token, or nothing stored).
 */
export function daysUntilLoginRequired(info: CredentialInfo): number | undefined {
  if (!info.present || info.kind === "long-lived") return undefined;
  if (typeof info.refreshTokenExpiresAt !== "number") return undefined;
  return Math.ceil((info.refreshTokenExpiresAt - Date.now()) / DAY);
}

/** How long Claude Code lets an account sit unused before demanding a login. */
export const IDLE_WINDOW_DAYS = 30;

/**
 * Estimated idle days remaining for a Keychain-backed account.
 *
 * The exact deadline lives inside the Keychain entry, so it is derived instead
 * from the last time this account was used or refreshed. Uses that bypassed
 * claudeswitch are invisible here, which makes the estimate pessimistic — the
 * safe direction for something that decides when to renew.
 */
export function estimatedIdleDaysLeft(lastActivityIso?: string): number | undefined {
  if (!lastActivityIso) return undefined;
  const last = Date.parse(lastActivityIso);
  if (!Number.isFinite(last)) return undefined;
  return Math.ceil((last + IDLE_WINDOW_DAYS * DAY - Date.now()) / DAY);
}

/** Claude Code starts warning the user at three days left; so do we. */
export const RENEW_WARNING_DAYS = 3;

/**
 * The long-lived token stored for an account, if any. Read only where it is
 * about to be handed to Claude Code; never logged, never printed.
 */
export function readLongLivedToken(slug: string): string | undefined {
  const path = accountLongLivedToken(slug);
  if (!pathExists(path)) return undefined;
  try {
    const value = readFileSync(path, "utf8").trim();
    return value.length ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when a refresh is worth attempting: the access token has expired, so the
 * next authenticated request will exchange the refresh token and reset the
 * 30-day window. While the access token is still valid, nothing would happen.
 */
export function refreshWouldRun(info: CredentialInfo): boolean {
  // Without the file there is no expiry to inspect, so let the request decide.
  if (info.storage === "keychain") return true;
  return info.present && info.kind === "oauth" && accessTokenExpired(info);
}
