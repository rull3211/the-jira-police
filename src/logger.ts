/**
 * Minimal structured logger. Writes JSON lines to stdout/stderr.
 *
 * House lint config bans `console`, and a service wants machine-readable logs
 * anyway, so this goes straight to the streams.
 *
 * ## The `q` field, and why an emoji is in a machine-readable format
 *
 * Most of what this service writes is a heartbeat: a cycle looked at five pull
 * requests, none of them had said anything, and it will say so again in two
 * minutes. A line reporting an *event* is rarer and looks identical. A person
 * scanning a terminal has to read the fields of every line to find out which
 * one they are looking at, which in practice means they stop reading.
 *
 * So every line carries `q`, first in the object so it sits at a fixed column:
 * **⏳ nothing happened** and **🔧 something did**. It is a value on a stable
 * key rather than a decoration outside the braces, so the line is still one
 * `JSON.parse` and `jq 'select(.q=="🔧")'` is the machine-readable half of the
 * same fact. Nothing in this tree parses these logs today, but the header above
 * says machine-readable is the point, and a format is not a promise you keep
 * only while nobody is holding you to it.
 *
 * **🔧 is the default, and that direction is deliberate.** An unclassified line
 * reads as news, never as noise — the same fail-safe argument `FAIL_FIRST_CHECK`
 * makes in `settings.ts`: a line nobody has thought about must not disappear
 * into the quiet pile, because the failure of an unnoticed ⏳ is silence about
 * something that mattered, and the failure of a spurious 🔧 is one line read.
 *
 * ## Why it is an argument and not a field
 *
 * The obvious design is a reserved key in `fields`, the way `error` already is
 * below. It was rejected on a collision that exists right now:
 * `WatchSweepOutcome` has a numeric member named `quiet` — a count of quiet
 * tickets — and `watch-loop.ts` spreads that whole outcome into its fields. A
 * reserved key would read `quiet: 0` as "this is news" and `quiet: 3` as "this
 * is nothing", inverting the marker and swallowing the real field, in the one
 * channel a person uses to find out what happened. That is this project's
 * defect class with a logger attached, so the marker is a third argument, where
 * no payload can reach it.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Per-call rendering options. Not fields — see the header.
 *
 * `quiet` is optional and its absence means 🔧. Do not give it a default of
 * `true` anywhere: the whole point is that silence about a line's character is
 * read as news.
 */
export interface LogOptions {
  readonly quiet?: boolean;
}

/** `silent` is not a log level, only a threshold — nothing can be emitted at it. */
export type LogThreshold = LogLevel | "silent";

const LEVEL_ORDER: Record<LogThreshold, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function activeLevel(): LogThreshold {
  const raw = process.env["LOG_LEVEL"]?.trim().toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error" || raw === "silent") {
    return raw;
  }
  return "info";
}

function serialiseError(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

/** ⏳ nothing happened, 🔧 something did. See the header for why 🔧 is default. */
export const QUIET_MARK = "⏳";
export const NEWS_MARK = "🔧";

function emit(
  level: LogLevel,
  message: string,
  fields: Record<string, unknown>,
  options: LogOptions,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel()]) {
    return;
  }

  const payload: Record<string, unknown> = {
    // First, so it lands in the same column on every line and the eye can run
    // down it. `JSON.stringify` preserves insertion order for string keys.
    q: options.quiet === true ? QUIET_MARK : NEWS_MARK,
    ts: new Date().toISOString(),
    level,
    message,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (key === "q") {
      // No caller passes this today. One could arrive the way `quiet` already
      // does — spread in from an outcome object nobody thought of as log fields
      // — and then the marker would silently become whatever that field held.
      // The marker wins, because a reader trusts the column; the field is kept
      // under `_q` rather than dropped, because swallowing a real value in the
      // one channel used to find out what happened is the bug this guards.
      payload["_q"] = value;
      continue;
    }
    payload[key] = key === "error" ? serialiseError(value) : value;
  }

  const line = `${JSON.stringify(payload)}\n`;
  if (level === "error" || level === "warn") {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

export const logger = {
  debug: (message: string, fields: Record<string, unknown> = {}, options: LogOptions = {}): void =>
    emit("debug", message, fields, options),
  info: (message: string, fields: Record<string, unknown> = {}, options: LogOptions = {}): void =>
    emit("info", message, fields, options),
  // `warn` and `error` take the argument for one uniform signature and are
  // never quiet in practice: a warning nobody needs to read is a warning that
  // should not have been written.
  warn: (message: string, fields: Record<string, unknown> = {}, options: LogOptions = {}): void =>
    emit("warn", message, fields, options),
  error: (message: string, fields: Record<string, unknown> = {}, options: LogOptions = {}): void =>
    emit("error", message, fields, options),
};
