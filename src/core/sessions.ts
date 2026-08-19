import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { copyPath, type CopySkip, ensureDir, removePath } from "./util.ts";

const PROJECTS_SUBDIR = "projects";

/**
 * Bytes of a transcript to read looking for its `cwd` and a preview line.
 *
 * Claude Code stamps `cwd` and `sessionId` on every line of a transcript, so
 * they always show up within the first few lines — reading a bounded prefix
 * avoids loading a long-running session's multi-megabyte transcript in full
 * just to answer "which project is this for".
 */
const PEEK_BYTES = 65_536;

export interface SessionInfo {
  sessionId: string;
  /** `<accountDir>/projects/<name>` — the directory Claude Code itself chose for this cwd. */
  projectDir: string;
  file: string;
  cwd: string;
  mtimeMs: number;
  /** First line of the first real user message, for disambiguating a picker. */
  preview?: string;
}

/**
 * Every session transcript under `accountDir` whose recorded `cwd` matches.
 *
 * Deliberately does not recompute Claude Code's own project-directory naming
 * scheme — that would be a guess this project's own rules warn against.
 * Instead each transcript is read for the `cwd` it already stamped on its own
 * lines, which is exactly what `claude --resume` would need to match too.
 */
export function findSessionsForCwd(accountDir: string, cwd: string): SessionInfo[] {
  const projectsDir = join(accountDir, PROJECTS_SUBDIR);
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const sessions: SessionInfo[] = [];
  for (const name of projectDirs) {
    const projectDir = join(projectsDir, name);
    let files: string[];
    try {
      files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const full = join(projectDir, file);
      const meta = peekTranscript(full);
      if (!meta || meta.cwd !== cwd) continue;
      sessions.push({
        // The filename is the session id Claude Code itself uses for --resume;
        // trusted over the in-file value so a truncated peek never matters.
        sessionId: file.slice(0, -".jsonl".length),
        projectDir,
        file: full,
        cwd: meta.cwd,
        mtimeMs: mtimeOf(full),
        preview: meta.preview,
      });
    }
  }

  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export interface CopySessionResult {
  destFile: string;
  skipped: CopySkip[];
}

/**
 * Copy (or move) one session's transcript into another account's directory,
 * under the same project-directory name it already had — so a `claude
 * --resume` run from the same cwd finds it exactly where Claude Code expects.
 */
export function copySession(
  session: SessionInfo,
  targetAccountDir: string,
  opts: { move: boolean },
): CopySessionResult {
  const destDir = join(targetAccountDir, PROJECTS_SUBDIR, basename(session.projectDir));
  ensureDir(destDir);
  const destFile = join(destDir, `${session.sessionId}.jsonl`);
  const skipped: CopySkip[] = [];
  copyPath(session.file, destFile, skipped);
  if (opts.move && !skipped.length) removePath(session.file);
  return { destFile, skipped };
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

interface TranscriptMeta {
  cwd: string;
  preview?: string;
}

function peekTranscript(file: string): TranscriptMeta | null {
  const text = readPrefix(file, PEEK_BYTES);
  if (text === null) return null;

  let cwd: string | undefined;
  let preview: string | undefined;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      // The byte cap can cut the last line mid-way through; earlier lines are whole.
      continue;
    }
    if (cwd === undefined && typeof entry.cwd === "string") cwd = entry.cwd;
    if (preview === undefined && isRealUserLine(entry)) {
      preview = firstText((entry.message as { content?: unknown } | undefined)?.content);
    }
    if (cwd !== undefined && preview !== undefined) break;
  }

  return cwd === undefined ? null : { cwd, preview };
}

/** A user turn typed in the session, not a synthetic local-command wrapper. */
function isRealUserLine(entry: Record<string, unknown>): boolean {
  if (entry.type !== "user" || entry.isMeta === true) return false;
  const message = entry.message as { role?: string } | undefined;
  return message?.role === "user";
}

function firstText(content: unknown): string | undefined {
  if (typeof content === "string") return truncatePreview(content);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block && typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return truncatePreview((block as { text: string }).text);
      }
    }
  }
  return undefined;
}

function truncatePreview(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length) ?? text;
  const trimmed = line.trim();
  return trimmed.length > 60 ? trimmed.slice(0, 57) + "…" : trimmed;
}

function readPrefix(file: string, maxBytes: number): string | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString("utf8", 0, bytesRead);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
