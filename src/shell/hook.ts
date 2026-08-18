import { PASSTHROUGH_COMMANDS } from "../core/reserved.ts";
import type { ShellFamily } from "../core/types.ts";
import { shQuote } from "../core/util.ts";

/**
 * Bumped whenever the generated hook gains behaviour the binary depends on.
 * The rc file re-generates the hook from the installed binary at every shell
 * start, so a mismatch means only *this* shell is stale and needs a re-source.
 */
export const HOOK_VERSION = 3;

export const ENV_VARS = [
  "CLAUDE_CONFIG_DIR",
  "CLAUDESWITCH_ACCOUNT",
  "CLAUDESWITCH_EMAIL",
  "CLAUDESWITCH_PLAN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
] as const;

export function detectShell(): ShellFamily {
  const explicit = process.env.CLAUDESWITCH_SHELL?.trim().toLowerCase();
  if (explicit === "zsh" || explicit === "bash" || explicit === "fish") return explicit;
  const shell = (process.env.SHELL ?? "").toLowerCase();
  if (shell.includes("fish")) return "fish";
  if (shell.includes("bash")) return "bash";
  return "zsh";
}

export function exportCode(vars: Record<string, string>, shell: ShellFamily): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(vars)) {
    lines.push(shell === "fish" ? `set -gx ${k} ${shQuote(v)};` : `export ${k}=${shQuote(v)};`);
  }
  return lines.join("\n");
}

export function unsetCode(names: readonly string[], shell: ShellFamily): string {
  if (shell === "fish") return names.map((n) => `set -e ${n};`).join("\n");
  return `unset ${names.join(" ")};`;
}

/**
 * The `eval "$(claudeswitch init)"` payload.
 *
 * `binCmd` is a ready-to-run, already-quoted command (an absolute binary path,
 * or `bun run /path/to/cli.ts` during development).
 */
export function hookScript(binCmd: string, shell: ShellFamily, opts: { alias: string; auto: boolean }): string {
  const bin = binCmd;
  const alias = opts.alias;

  if (shell === "fish") {
    return `# claudeswitch shell integration (fish)
function claudeswitch --description 'Switch Claude Code accounts per terminal'
    switch "$argv[1]"
        case ${PASSTHROUGH_COMMANDS.join(" ")} -h --help -V --version
            env CLAUDESWITCH_SHELL=fish ${bin} $argv
        case '*'
            # use/off, or a bare account name or alias: capture and apply.
            set -l __cs_code (env CLAUDESWITCH_SHELL_HOOK=1 CLAUDESWITCH_SHELL=fish ${bin} $argv)
            set -l __cs_status $status
            if test $__cs_status -ne 0
                return $__cs_status
            end
            if test -n "$__cs_code"
                eval (string join \\n $__cs_code)
            end
    end
end

function claudeswitch_prompt --description 'Print the active Claude account'
    if set -q CLAUDESWITCH_ACCOUNT
        echo -n $CLAUDESWITCH_ACCOUNT
    end
end

set -gx CLAUDESWITCH_HOOK_VERSION ${HOOK_VERSION}
alias ${alias} claudeswitch
${opts.auto ? `if not set -q CLAUDE_CONFIG_DIR\n    claudeswitch use --default --quiet 2>/dev/null\nend\n` : ""}`;
  }

  const localKw = shell === "bash" ? "local" : "local";
  return `# claudeswitch shell integration (${shell})
claudeswitch() {
  case "\${1-}" in
    ${PASSTHROUGH_COMMANDS.join("|")}|-h|--help|-V|--version)
      CLAUDESWITCH_SHELL=${shell} ${bin} "$@"
      ;;
    *)
      # use/off, or a bare account name or alias: capture and apply the exports.
      ${localKw} __cs_code __cs_status
      __cs_code="$(CLAUDESWITCH_SHELL_HOOK=1 CLAUDESWITCH_SHELL=${shell} ${bin} "$@")"
      __cs_status=$?
      if [ $__cs_status -ne 0 ]; then
        return $__cs_status
      fi
      if [ -n "$__cs_code" ]; then
        eval "$__cs_code"
      fi
      ;;
  esac
}

# Print the active account, for use in PS1/RPROMPT. Reads a variable only: no subprocess.
claudeswitch_prompt() {
  [ -n "\${CLAUDESWITCH_ACCOUNT-}" ] && printf '%s' "$CLAUDESWITCH_ACCOUNT"
}

export CLAUDESWITCH_HOOK_VERSION=${HOOK_VERSION}
alias ${alias}='claudeswitch'
${opts.auto ? `if [ -z "\${CLAUDE_CONFIG_DIR-}" ]; then claudeswitch use --default --quiet 2>/dev/null; fi\n` : ""}`;
}

export function rcFileFor(shell: ShellFamily, home: string): string {
  if (shell === "fish") return `${home}/.config/fish/config.fish`;
  if (shell === "bash") return `${home}/.bashrc`;
  return `${home}/.zshrc`;
}
