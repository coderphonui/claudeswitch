/** Which shared assets an account links to `~/.claudeswitch/shared`. */
export type SharePolicy = "all" | "none" | string[];

export interface AccountRecord {
  slug: string;
  /** Optional friendly name shown in listings. */
  label?: string;
  /** Extra names this account answers to, e.g. ["w"] for "work". */
  aliases?: string[];
  email?: string;
  orgName?: string;
  orgId?: string;
  /** "team" | "pro" | "max" | "enterprise" ... as reported by `claude auth status`. */
  subscriptionType?: string;
  /** "claude.ai" | "console" ... as reported by `claude auth status`. */
  authMethod?: string;
  share: SharePolicy;
  /**
   * Fixed at creation and never changed. Claude Code derives the macOS Keychain
   * entry for an account from this path, so letting it drift — by renaming the
   * account, or moving ~/.claudeswitch — would orphan its credentials.
   */
  securestorageKey?: string;
  createdAt: string;
  /** Set by `claudeswitch refresh`, to estimate the idle window on macOS. */
  lastRefreshedAt?: string;
  /**
   * Last known answer from `claude auth status`, cached because on macOS the
   * credential lives in the Keychain and only Claude Code can read it — and
   * asking costs ~200ms per account, which the account picker cannot afford.
   */
  authState?: "ok" | "logged-out";
  authCheckedAt?: string;
  lastUsedAt?: string;
  notes?: string;
}

export interface Registry {
  version: number;
  accounts: Record<string, AccountRecord>;
  /** Used by `claudeswitch init --auto` to activate an account in new shells. */
  defaultAccount?: string;
  /** Applied to newly created accounts. */
  shareDefault: SharePolicy;
}

export interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
  subscriptionType?: string;
}

/**
 * How an account authenticates.
 *
 * "oauth": a normal `claude auth login`, with a refresh token that rotates.
 * "long-lived": an inference-only token from `claude setup-token`, which never
 * expires on a schedule but carries fewer scopes.
 */
export type CredentialKind = "oauth" | "long-lived" | "unknown";

/**
 * Where the credential actually lives. "keychain" is the macOS default and is
 * opaque to claudeswitch: only `claude auth status` can report on it.
 */
export type CredentialStorage = "file" | "keychain" | "long-lived-file";

/** Non-secret view of an account's stored credentials. Never holds a token. */
export interface CredentialInfo {
  present: boolean;
  kind: CredentialKind;
  storage: CredentialStorage;
  /** Truncated SHA-256 of the refresh token: identifies it without exposing it. */
  fingerprint?: string;
  /** epoch ms; undefined when the file has no access-token expiry. */
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  subscriptionType?: string;
  rateLimitTier?: string;
  scopes?: string[];
}

export type ShellFamily = "zsh" | "bash" | "fish";
