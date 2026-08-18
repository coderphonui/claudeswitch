import { appendFileSync, readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { type Args, flagBool, flagString } from "../core/args.ts";
import { HOME } from "../core/paths.ts";
import { ensureState } from "../core/registry.ts";
import { shQuote, UserError } from "../core/util.ts";
import { detectShell, hookScript, rcFileFor } from "../shell/hook.ts";
import type { ShellFamily } from "../core/types.ts";
import { c, data, out, success, warn } from "../ui/io.ts";

const MARK_START = "# >>> claudeswitch >>>";
const MARK_END = "# <<< claudeswitch <<<";

export function cmdInit(args: Args): number {
  const shell = (flagString(args, "shell") as ShellFamily | undefined) ?? detectShell();
  if (!["zsh", "bash", "fish"].includes(shell)) {
    throw new UserError(`Unsupported shell: ${shell}`, "Supported: zsh, bash, fish");
  }
  const alias = flagString(args, "alias") ?? "cs";
  const auto = flagBool(args, "auto");
  const bin = selfPath();
  const script = hookScript(bin, shell, { alias, auto });

  if (!flagBool(args, "install")) {
    // Printed on stdout so `eval "$(claudeswitch init)"` works.
    data(script);
    return 0;
  }

  const rc = rcFileFor(shell, HOME);
  const existing = safeRead(rc);
  if (existing.includes(MARK_START)) {
    warn(`${rc} already contains a claudeswitch block — leaving it alone.`);
    out(c.dim("  Remove the block between the markers and re-run to reinstall."));
    return 0;
  }

  const block = [
    "",
    MARK_START,
    `eval "$(${bin} init --shell ${shell} --alias ${alias}${auto ? " --auto" : ""})"`,
    MARK_END,
    "",
  ].join("\n");

  appendFileSync(rc, block);
  ensureState(); // make sure the state layout exists before the hook runs

  success(`Installed the shell hook into ${rc}`);
  out();
  out(`  ${c.bold("Activate it in this terminal:")}`);
  out(`    ${c.cyan(`source ${rc}`)}`);
  out();
  out(`  ${c.bold("Then:")}`);
  out(`    ${c.cyan(`${alias} import`)}      ${c.dim("bring your current account under management")}`);
  out(`    ${c.cyan(`${alias} add work`)}    ${c.dim("log in to another account")}`);
  out(`    ${c.cyan(`${alias}`)}             ${c.dim("pick an account for this terminal")}`);
  return 0;
}

/**
 * A ready-to-run command for this executable, quoted for the shell, so the hook
 * never depends on PATH. Falls back to `bun run <script>` in development.
 */
function selfPath(): string {
  const exec = process.execPath;
  const script = process.argv[1];
  try {
    if (script && /\.(ts|tsx|js|mjs)$/.test(script)) {
      return `${shQuote(realpathSync(exec))} run ${shQuote(realpathSync(script))}`;
    }
    return shQuote(realpathSync(exec));
  } catch {
    return "claudeswitch";
  }
}

function safeRead(p: string): string {
  try { return readFileSync(p, "utf8"); } catch { return ""; }
}
