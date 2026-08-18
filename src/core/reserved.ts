/** Subcommands that change the current shell's environment. */
export const ENV_COMMANDS = ["use", "switch", "off", "unuse"] as const;

/**
 * Every other subcommand. The shell hook runs these directly and leaves their
 * stdout alone, so piping (`cs ls --json | jq`) keeps working; anything not in
 * this list is treated as environment-changing, which is what lets a bare
 * account name or alias (`cs w`) switch the terminal.
 */
export const PASSTHROUGH_COMMANDS = [
  "ls", "list", "current", "status",
  "add", "new", "import", "login", "logout",
  "rm", "remove", "delete", "rename", "mv",
  "share", "default", "which", "label", "alias", "unalias",
  "exec", "run", "shell",
  "refresh", "keepwarm", "token", "usage",
  "doctor", "repair", "init", "help", "version",
] as const;

/**
 * Words that cannot be an account name or alias, because `cs <word>` has to
 * keep meaning the subcommand.
 */
export const RESERVED_NAMES = new Set<string>([
  ...ENV_COMMANDS,
  ...PASSTHROUGH_COMMANDS,
  // Directory names inside ~/.claudeswitch.
  "shared", "archive", "accounts",
]);
