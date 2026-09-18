/**
 * One raw line in, one entry out — never zero.
 *
 * The daemon's stdout is not pure NDJSON: `watch/sweep.ts` writes `↳` report lines through
 * `deps.report` onto the same descriptor, and a crash writes a stack trace there too. A parser that
 * dropped what it could not parse would eat both, and the trace is the line an operator most needs.
 * So anything that is not a log object becomes a `raw` entry and is displayed verbatim.
 */

import type { LogLevel } from "../logger.ts";

export interface LogEntry {
  readonly kind: "log";
  /** The original text, kept so the viewer can show the line it actually received. */
  readonly text: string;
  readonly mark: string;
  readonly level: LogLevel;
  readonly src: string;
  readonly message: string;
  readonly ts: string;
  /** Everything after `message`, in the order the logger wrote it. */
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface RawEntry {
  readonly kind: "raw";
  readonly text: string;
}

export type Entry = LogEntry | RawEntry;

const LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

/** The keys the logger writes itself; everything else on the object is a field. */
const OWN_KEYS: ReadonlySet<string> = new Set(["q", "ts", "level", "src", "message"]);

function isLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && LEVELS.has(value);
}

/**
 * A log object needs `level`, `src` and `message` to be filterable and placeable in columns.
 *
 * `q` and `ts` are read when present but do not disqualify a line, so a log written by an older
 * build still shows rather than falling through to `raw`.
 */
export function parseLine(text: string): Entry {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    return { kind: "raw", text };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "raw", text };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "raw", text };
  }

  const record = parsed as Record<string, unknown>;
  const { level, src, message } = record;
  if (!isLevel(level) || typeof src !== "string" || typeof message !== "string") {
    return { kind: "raw", text };
  }

  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!OWN_KEYS.has(key)) {
      fields[key] = value;
    }
  }

  return {
    kind: "log",
    text,
    mark: typeof record["q"] === "string" ? record["q"] : "",
    level,
    src,
    message,
    ts: typeof record["ts"] === "string" ? record["ts"] : "",
    fields,
  };
}

/**
 * `HH:MM:SS` from an ISO timestamp, or blanks of the same width.
 *
 * Fixed width whatever arrives: a shorter cell here would move every column to its right on one
 * line only, which is the shear the whole viewer is arranged to avoid.
 */
export function clockOf(ts: string): string {
  const at = ts.indexOf("T");
  if (at === -1 || ts.length < at + 9) {
    return "        ";
  }
  return ts.slice(at + 1, at + 9);
}
