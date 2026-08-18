import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Args, flagBool, flagString } from "../core/args.ts";
import { HOME, ROOT } from "../core/paths.ts";
import { ensureDir, pathExists, removePath, UserError } from "../core/util.ts";
import { c, info, out, success, warn } from "../ui/io.ts";

const LABEL = "com.claudeswitch.keepwarm";
const PLIST = join(HOME, "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG = join(ROOT, "keepwarm.log");

/** Default cadence: weekly, comfortably inside the 30-day idleness window. */
const DEFAULT_INTERVAL_DAYS = 7;

/**
 * Install a launchd agent that runs `claudeswitch refresh` on a schedule.
 *
 * Claude Code's refresh tokens live 30 days from their last use, so an account
 * you leave alone for a month has to be logged in again by hand. A weekly
 * refresh keeps every account inside that window indefinitely.
 */
export function cmdKeepwarm(args: Args): number {
  if (flagBool(args, "uninstall")) return uninstall();
  if (flagBool(args, "install")) return install(args);
  return status();
}

function install(args: Args): number {
  const days = Number(flagString(args, "everyDays") ?? DEFAULT_INTERVAL_DAYS);
  if (!Number.isFinite(days) || days < 1 || days > 25) {
    throw new UserError(
      `--every-days must be between 1 and 25 (got ${flagString(args, "everyDays")}).`,
      "The refresh window is 30 days, so a longer gap would defeat the purpose.",
    );
  }

  const bin = selfBinary();
  if (!bin) {
    throw new UserError(
      "Could not locate the claudeswitch binary to schedule.",
      "Install it first: ./install.sh, then re-run this from ~/.local/bin/claudeswitch.",
    );
  }

  ensureDir(join(HOME, "Library", "LaunchAgents"));
  ensureDir(ROOT);
  if (pathExists(PLIST)) {
    info("Replacing the existing agent.");
    bootout();
  }

  writeFileSync(PLIST, plist(bin, days), { mode: 0o644 });
  const domain = guiDomain();
  const load = domain
    ? spawnSync("/bin/launchctl", ["bootstrap", domain, PLIST], { encoding: "utf8" })
    : { status: 1, stderr: "no GUI domain available" };
  if (load.status !== 0) {
    // `bootstrap` is unavailable on older macOS; `load` still works there.
    const legacy = spawnSync("/bin/launchctl", ["load", "-w", PLIST], { encoding: "utf8" });
    if (legacy.status !== 0) {
      warn("The plist was written but launchctl refused to load it.");
      out(c.dim(`  ${(load.stderr || legacy.stderr || "").trim()}`));
      out(`  ${c.dim("Load it yourself:")} ${c.cyan(`launchctl load -w ${PLIST}`)}`);
      return 1;
    }
  }

  success(`Scheduled: every ${days} day${days === 1 ? "" : "s"}, all accounts refreshed`);
  out(`  ${c.dim("agent")}  ${PLIST}`);
  out(`  ${c.dim("log")}    ${LOG}`);
  out();
  out(c.dim("  Each run costs one short prompt per account that has been idle over an hour;"));
  out(c.dim("  accounts you are actively using are left alone."));
  out(`  ${c.dim("Check it:")} ${c.cyan("cs keepwarm")}   ${c.dim("·")}   ${c.dim("Remove it:")} ${c.cyan("cs keepwarm --uninstall")}`);
  return 0;
}

function uninstall(): number {
  if (!pathExists(PLIST)) {
    out(c.dim("No keep-warm agent is installed."));
    return 0;
  }
  bootout();
  removePath(PLIST);
  success("Removed the keep-warm agent.");
  out(c.dim(`  The log is kept at ${LOG}`));
  return 0;
}

function status(): number {
  if (!pathExists(PLIST)) {
    out(`${c.dim("·")} keep-warm is ${c.bold("not installed")}`);
    out();
    out(c.dim("  Claude Code needs an interactive login again once an account sits unused"));
    out(c.dim("  for 30 days. A scheduled refresh keeps every account inside that window."));
    out(`  ${c.dim("Install:")} ${c.cyan("cs keepwarm --install")}   ${c.dim("(weekly; --every-days N to change)")}`);
    return 0;
  }

  const listed = spawnSync("/bin/launchctl", ["list", LABEL], { encoding: "utf8" });
  const loaded = listed.status === 0;
  out(`${loaded ? c.green("●") : c.yellow("!")} keep-warm ${loaded ? "is running" : "is installed but not loaded"}`);
  out(`  ${c.dim("agent")}  ${PLIST}`);

  const interval = readInterval();
  if (interval) out(`  ${c.dim("every")}  ${interval / 86_400} day${interval === 86_400 ? "" : "s"}`);

  if (pathExists(LOG)) {
    const lines = readFileSync(LOG, "utf8").trimEnd().split("\n");
    out(`  ${c.dim("log")}    ${LOG}`);
    for (const line of lines.slice(-6)) out(`         ${c.dim(line)}`);
  } else {
    out(`  ${c.dim("log")}    ${c.dim("nothing written yet")}`);
  }
  if (!loaded) out(`  ${c.dim("Load it:")} ${c.cyan(`launchctl load -w ${PLIST}`)}`);
  return 0;
}

function bootout(): void {
  const domain = guiDomain();
  if (domain) {
    spawnSync("/bin/launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });
  }
  spawnSync("/bin/launchctl", ["unload", "-w", PLIST], { stdio: "ignore" });
}

/** `gui/<uid>`, or undefined where the uid cannot be determined. */
function guiDomain(): string | undefined {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return typeof uid === "number" ? `gui/${uid}` : undefined;
}

function readInterval(): number | undefined {
  try {
    const m = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(readFileSync(PLIST, "utf8"));
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The installed binary, not the development entry point: a scheduled job must
 * keep working after this checkout moves or `bun` is upgraded.
 */
function selfBinary(): string | null {
  const script = process.argv[1];
  const isDev = script && /\.(ts|tsx|js|mjs)$/.test(script);
  const candidates = [
    ...(isDev ? [] : [process.execPath]),
    join(HOME, ".local", "bin", "claudeswitch"),
    "/usr/local/bin/claudeswitch",
    "/opt/homebrew/bin/claudeswitch",
  ];
  for (const candidate of candidates) {
    try {
      if (pathExists(candidate)) return realpathSync(candidate);
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function plist(bin: string, days: number): string {
  const xml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const escaped = xml(bin);
  // launchd would otherwise hand the job only /usr/bin:/bin:/usr/sbin:/sbin.
  const escapedPath = xml(
    [join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escaped}</string>
    <string>refresh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDESWITCH_KEEPWARM</key>
    <string>1</string>
    <key>PATH</key>
    <string>${escapedPath}</string>
  </dict>
  <key>StartInterval</key>
  <integer>${days * 86_400}</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${LOG}</string>
  <key>StandardErrorPath</key>
  <string>${LOG}</string>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
</dict>
</plist>
`;
}
