import type { Writable } from "node:stream";

let emitMode = false;
let colorEnabled = true;

export function configureIo(opts: { emit: boolean; color?: boolean }): void {
  emitMode = opts.emit;
  const stream = human();
  const forced = process.env.FORCE_COLOR;
  const disabled = process.env.NO_COLOR !== undefined || opts.color === false;
  colorEnabled = !disabled && (forced ? forced !== "0" : Boolean((stream as any).isTTY));
}

export function isEmitMode(): boolean {
  return emitMode;
}

/**
 * Where human-readable text goes. In shell-hook mode stdout is captured by
 * `eval "$(...)"`, so everything except shell code must go to stderr.
 */
export function human(): Writable {
  return emitMode ? process.stderr : process.stdout;
}

/**
 * True once the destination has gone away — `cs usage | head -1`, or a pipe whose
 * reader failed to start. A command-line tool should fall silent at that point,
 * not print a stack trace about a broken pipe.
 */
let pipeClosed = false;

export function outputClosed(): boolean {
  return pipeClosed;
}

function writeSafely(stream: Writable, text: string): void {
  if (pipeClosed) return;
  try {
    stream.write(text);
  } catch (err) {
    if (isBrokenPipe(err)) pipeClosed = true;
    else throw err;
  }
}

function isBrokenPipe(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ERR_STREAM_WRITE_AFTER_END";
}

/**
 * Install guards for the asynchronous case: a stream can also report EPIPE via
 * an "error" event, well after the write that caused it returned.
 */
export function guardBrokenPipes(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (err: unknown) => {
      if (isBrokenPipe(err)) pipeClosed = true;
      else throw err;
    });
  }
}

export function out(line = ""): void {
  writeSafely(human(), line + "\n");
}

/** Shell code for the parent shell to eval. Always stdout, never decorated. */
export function emit(code: string): void {
  writeSafely(process.stdout, code.endsWith("\n") ? code : code + "\n");
}

export function data(text: string): void {
  writeSafely(process.stdout, text.endsWith("\n") ? text : text + "\n");
}

const CODES = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", italic: "\x1b[3m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[34m",
  magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m", white: "\x1b[37m",
} as const;

function wrap(code: string) {
  return (s: string) => (colorEnabled ? code + s + CODES.reset : s);
}

export const c = {
  bold: wrap(CODES.bold), dim: wrap(CODES.dim), italic: wrap(CODES.italic),
  red: wrap(CODES.red), green: wrap(CODES.green), yellow: wrap(CODES.yellow),
  blue: wrap(CODES.blue), magenta: wrap(CODES.magenta), cyan: wrap(CODES.cyan),
  gray: wrap(CODES.gray),
};

export const sym = {
  active: "●",
  idle: "○",
  ok: "✓",
  warn: "!",
  bad: "✗",
  arrow: "❯",
};

export function success(msg: string): void {
  out(`${c.green(sym.ok)} ${msg}`);
}

export function warn(msg: string): void {
  out(`${c.yellow(sym.warn)} ${msg}`);
}

export function fail(msg: string): void {
  out(`${c.red(sym.bad)} ${msg}`);
}

export function info(msg: string): void {
  out(`${c.gray("→")} ${msg}`);
}

/**
 * A compact meter: `████░░░░░░ 42%`.
 *
 * Coloured by how close the limit is rather than by which limit it is, because
 * what a reader wants at a glance is "am I about to be cut off".
 */
export function meter(percent: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const paint = clamped >= 95 ? c.red : clamped >= 80 ? c.yellow : c.green;
  return paint("█".repeat(filled)) + c.dim("░".repeat(Math.max(0, width - filled)));
}

/** `42%`, coloured on the same scale as the meter. */
export function percentText(percent: number): string {
  const rounded = Math.round(percent);
  const paint = percent >= 95 ? c.red : percent >= 80 ? c.yellow : (s: string) => s;
  return paint(`${rounded}%`);
}

/**
 * A short duration: `1h 28m`, `3d 4h`, `45s`. Deliberately not `relTime`, which
 * rounds to a single unit — for a quota reset the reader wants the minutes.
 */
export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes) return `${minutes}m`;
  return `${total}s`;
}

/** Visible width, ignoring ANSI escapes. */
export function width(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function pad(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - width(s)));
}

function truncate(s: string, limit: number): string {
  if (width(s) <= limit) return s;
  // Colour codes carry no width, so walk the string and keep the escapes.
  let visible = 0;
  let result = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\x1b") {
      const end = s.indexOf("m", i);
      if (end !== -1) {
        result += s.slice(i, end + 1);
        i = end;
        continue;
      }
    }
    if (visible >= limit - 1) break;
    result += s[i];
    visible++;
  }
  return result + "…" + (s.includes("\x1b") ? "\x1b[0m" : "");
}

/**
 * Aligned columns that shrink to fit the terminal instead of wrapping. The
 * widest column gives up space first, so identifying columns stay readable.
 */
export function table(headers: string[], rows: string[][], maxWidth?: number): string {
  const widths = headers.map((h, i) =>
    Math.max(width(h), ...rows.map((r) => width(r[i] ?? ""))),
  );

  const limit = maxWidth ?? terminalWidth();
  let keep = widths.length;
  const measure = () => widths.slice(0, keep).reduce((a, b) => a + b, 0) + 2 * Math.max(0, keep - 1);

  // Give space back from the widest column first, down to a floor where text is
  // still recognisable. Only when that is not enough does a trailing column go:
  // squeezing every column into six characters helps nobody.
  while (measure() > limit && keep > 1) {
    let shrank = false;
    while (measure() > limit) {
      let widest = 0;
      for (let i = 1; i < keep; i++) {
        if ((widths[i] ?? 0) > (widths[widest] ?? 0)) widest = i;
      }
      if ((widths[widest] ?? 0) <= 8) break;
      widths[widest] = (widths[widest] ?? 0) - 1;
      shrank = true;
    }
    if (measure() <= limit) break;
    keep--;
    if (!shrank && keep <= 1) break;
  }

  const cell = (text: string, i: number) => pad(truncate(text, widths[i] ?? 0), widths[i] ?? 0);
  const head = headers.slice(0, keep).map((h, i) => c.dim(cell(h.toUpperCase(), i))).join("  ");
  const body = rows.map((r) =>
    r.slice(0, keep).map((text, i) => cell(text ?? "", i)).join("  ").trimEnd(),
  );
  return [head, ...body].join("\n");
}

export function terminalWidth(): number {
  const stream = (human() as any).columns ?? process.stdout.columns;
  if (typeof stream === "number" && stream > 20) return stream;
  // Piped or redirected: honour COLUMNS so output stays predictable in scripts.
  const env = Number(process.env.COLUMNS);
  return Number.isFinite(env) && env > 20 ? env : 100;
}
