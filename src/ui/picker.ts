import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { c, sym } from "./io.ts";

export interface PickerRow<T> {
  value: T;
  /** Plain, unstyled text. The picker aligns these into columns and styles them. */
  cells: string[];
  /** Marked as the account this terminal is currently using. */
  active?: boolean;
  /** Draws attention to a row that needs the user's attention (e.g. logged out). */
  tone?: "warn";
  /** Extra text the filter should match on, beyond the cells. */
  search?: string;
}

export interface PickerOptions {
  title: string;
  /** One styling function per column; missing entries render dim. */
  styles?: ((s: string) => string)[];
  /** Row to start on. Defaults to the active row, then the first row. */
  initial?: number;
}

/** Longest to shortest; the widest one that fits the terminal wins. */
const HINTS = [
  "↑↓ move · 1-9 jump · type to filter · ⏎ select · esc cancel",
  "↑↓ move · type to filter · ⏎ select · esc cancel",
  "↑↓ · type to filter · ⏎ select · esc",
  "↑↓ · ⏎ select · esc",
];

function hintFor(cols: number, numbered: boolean): string {
  const usable = numbered ? HINTS : HINTS.slice(1);
  return usable.find((h) => h.length + 4 <= cols) ?? HINTS[HINTS.length - 1]!;
}

/**
 * A dependency-free single-select picker.
 *
 * It talks to /dev/tty directly so it still works when stdout is captured by
 * `eval "$(claudeswitch use …)"`, and every line ends with CRLF: `stty raw`
 * turns off ONLCR, so a bare "\n" moves down without returning to column one
 * and the whole frame walks off to the right.
 */
export function pick<T>(rows: PickerRow<T>[], opts: PickerOptions): T | null {
  if (!rows.length) return null;

  let tty: { r: number; w: number };
  try {
    tty = { r: openSync("/dev/tty", "r"), w: openSync("/dev/tty", "w") };
  } catch {
    return null;
  }

  const saved = ttyState();
  rawMode(true);
  const write = (s: string) => writeSync(tty.w, s);
  const { cols, lines: termLines } = ttySize();
  const maxVisible = Math.max(3, Math.min(rows.length, termLines - 5));

  const widths = columnWidths(rows);
  let index = opts.initial ?? rows.findIndex((r) => r.active);
  if (index < 0 || index >= rows.length) index = 0;
  let query = "";
  let offset = 0;
  let painted = 0;
  let result: T | null = null;

  const matching = (): PickerRow<T>[] => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => [...row.cells, row.search ?? ""].join(" ").toLowerCase().includes(q));
  };

  const render = () => {
    if (painted) write(`\x1b[${painted}A\r\x1b[0J`);
    const list = matching();
    if (index >= list.length) index = Math.max(0, list.length - 1);
    if (index < offset) offset = index;
    if (index >= offset + maxVisible) offset = index - maxVisible + 1;
    if (offset > Math.max(0, list.length - maxVisible)) offset = Math.max(0, list.length - maxVisible);

    const window = list.slice(offset, offset + maxVisible);
    const counter =
      list.length > maxVisible
        ? `${offset + 1}-${offset + window.length} of ${list.length}`
        : `${list.length} account${list.length === 1 ? "" : "s"}`;

    const out: string[] = [];
    out.push(
      "  " +
        c.bold(opts.title) +
        (query ? "  " + c.cyan(`/${query}`) : "") +
        "   " +
        c.dim(counter),
    );
    out.push("");

    if (!window.length) {
      out.push("  " + c.dim("nothing matches that filter"));
    }
    window.forEach((row, i) => {
      out.push(renderRow(row, offset + i === index, i + 1, widths, opts.styles ?? [], cols));
    });

    out.push("");
    out.push("  " + c.dim(hintFor(cols, window.length > 1 && window.length <= 9)));

    write(out.join("\r\n") + "\r\n");
    painted = out.length;
  };

  const buf = Buffer.alloc(16);
  try {
    write("\x1b[?25l"); // hide the cursor: it would sit in the middle of the frame
    render();
    while (true) {
      const n = readSync(tty.r, buf, 0, buf.length, null);
      if (n <= 0) break;
      const seq = buf.subarray(0, n).toString("utf8");
      const list = matching();

      if (seq === "\r" || seq === "\n") {
        result = list[index]?.value ?? null;
        break;
      }
      if (seq === "\x03" || seq === "\x1b" || (seq === "q" && !query)) break; // ctrl-c, esc, q
      if (seq === "\x1b[A" || seq === "\x10") { index = index > 0 ? index - 1 : Math.max(0, list.length - 1); render(); continue; }
      if (seq === "\x1b[B" || seq === "\x0e" || seq === "\t") { index = list.length ? (index + 1) % list.length : 0; render(); continue; }
      if (seq === "\x7f" || seq === "\b") { query = query.slice(0, -1); index = 0; offset = 0; render(); continue; }
      if (seq === "\x15") { query = ""; index = 0; offset = 0; render(); continue; } // ctrl-u
      if (/^[1-9]$/.test(seq) && !query) {
        // Numbers address the visible window, which is what the labels show.
        const target = offset + Number(seq) - 1;
        if (target < list.length) { result = list[target]!.value; break; }
        continue;
      }
      if (seq.length === 1 && seq >= " " && seq <= "~") { query += seq; index = 0; offset = 0; render(); continue; }
    }
  } finally {
    if (painted) write(`\x1b[${painted}A\r\x1b[0J`);
    write("\x1b[?25h");
    rawMode(false, saved);
    closeSync(tty.r);
    closeSync(tty.w);
  }
  return result;
}

function renderRow<T>(
  row: PickerRow<T>,
  selected: boolean,
  number: number,
  widths: number[],
  styles: ((s: string) => string)[],
  cols: number,
): string {
  const cursor = selected ? c.cyan(sym.arrow) : " ";
  const index = c.dim(String(number));
  const mark = row.active
    ? c.green(sym.active)
    : row.tone === "warn"
      ? c.yellow(sym.warn)
      : c.dim(sym.idle);
  let used = 6; // cursor + space + number + space + mark + space
  const parts: string[] = [];

  for (let i = 0; i < widths.length; i++) {
    const width = widths[i] ?? 0;
    if (!width) continue;
    const gap = parts.length ? 2 : 0;
    const room = cols - 1 - used - gap;
    if (room <= 2) break;

    const plain = row.cells[i] ?? "";
    const budget = Math.min(width, room);
    const text = plain.length > budget ? plain.slice(0, Math.max(1, budget - 1)) + "…" : plain.padEnd(budget);
    const style = styles[i] ?? c.dim;
    parts.push((gap ? "  " : "") + (selected && i === 0 ? c.bold(style(text)) : style(text)));
    used += gap + budget;
  }

  return `${cursor} ${index} ${mark} ${parts.join("")}`.trimEnd();
}

function columnWidths<T>(rows: PickerRow<T>[]): number[] {
  const count = Math.max(...rows.map((r) => r.cells.length));
  const widths: number[] = [];
  for (let i = 0; i < count; i++) {
    widths.push(Math.max(...rows.map((r) => (r.cells[i] ?? "").length)));
  }
  return widths;
}

export function ttyAvailable(): boolean {
  try {
    const fd = openSync("/dev/tty", "r");
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/** Yes/no prompt on /dev/tty. */
export function confirm(question: string, defaultYes = false): boolean {
  let tty: { r: number; w: number };
  try {
    tty = { r: openSync("/dev/tty", "r"), w: openSync("/dev/tty", "w") };
  } catch {
    return defaultYes;
  }
  const saved = ttyState();
  rawMode(true);
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  writeSync(tty.w, `${question} ${c.dim(hint)} `);
  const buf = Buffer.alloc(8);
  let answer = defaultYes;
  try {
    const n = readSync(tty.r, buf, 0, buf.length, null);
    const key = n > 0 ? buf.subarray(0, n).toString("utf8").toLowerCase() : "";
    if (key === "y") answer = true;
    else if (key === "\r" || key === "\n") answer = defaultYes;
    else answer = false;
    writeSync(tty.w, (answer ? c.green("yes") : c.dim("no")) + "\r\n");
  } finally {
    rawMode(false, saved);
    closeSync(tty.r);
    closeSync(tty.w);
  }
  return answer;
}

/**
 * Read a line from /dev/tty without echoing it, for pasting a secret.
 * Falls back to the echoing prompt if the terminal cannot be reconfigured.
 */
export function promptSecret(question: string): string | null {
  const saved = ttyState();
  const off = spawnSync("/bin/sh", ["-c", "stty -echo < /dev/tty"], { stdio: "ignore" });
  if (off.status !== 0) return prompt(question);
  try {
    const value = prompt(question);
    return value;
  } finally {
    spawnSync("/bin/sh", ["-c", saved ? `stty ${saved} < /dev/tty` : "stty sane < /dev/tty"], {
      stdio: "ignore",
    });
    try {
      const w = openSync("/dev/tty", "w");
      writeSync(w, "\n");
      closeSync(w);
    } catch {
      /* the newline is cosmetic */
    }
  }
}

/** Read a line of text from /dev/tty (echoed by the terminal). */
export function prompt(question: string): string | null {
  let tty: { r: number; w: number };
  try {
    tty = { r: openSync("/dev/tty", "r"), w: openSync("/dev/tty", "w") };
  } catch {
    return null;
  }
  writeSync(tty.w, question);
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(1);
  try {
    while (true) {
      const n = readSync(tty.r, buf, 0, 1, null);
      if (n <= 0) break;
      if (buf[0] === 0x0a || buf[0] === 0x0d) break;
      chunks.push(Buffer.from(buf.subarray(0, 1)));
    }
  } finally {
    closeSync(tty.r);
    closeSync(tty.w);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function ttyState(): string | null {
  const r = spawnSync("/bin/sh", ["-c", "stty -g < /dev/tty"], { encoding: "utf8" });
  const s = r.stdout?.trim();
  return s && s.length ? s : null;
}

function ttySize(): { cols: number; lines: number } {
  const r = spawnSync("/bin/sh", ["-c", "stty size < /dev/tty"], { encoding: "utf8" });
  const [lines, cols] = (r.stdout ?? "").trim().split(/\s+/).map(Number);
  return {
    cols: Number.isFinite(cols) && cols! > 20 ? cols! : 100,
    lines: Number.isFinite(lines) && lines! > 6 ? lines! : 24,
  };
}

function rawMode(on: boolean, saved?: string | null): void {
  const cmd = on ? "stty raw -echo < /dev/tty" : saved ? `stty ${saved} < /dev/tty` : "stty sane < /dev/tty";
  spawnSync("/bin/sh", ["-c", cmd], { stdio: "ignore" });
}
