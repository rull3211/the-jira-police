/**
 * Minimal structured logger. Writes JSON lines to stdout/stderr (house lint bans `console`).
 *
 * Every line carries a `q` marker (⏳ quiet / 🔧 news), defaulting to 🔧 so an unclassified line
 * reads as news rather than disappearing into the quiet pile. It's a third `emit` argument rather
 * than a reserved field because outcome objects spread into `fields` can carry their own `quiet`
 * member (see `WatchSweepOutcome`), which would otherwise collide with and invert the marker.
 *
 * Every line also carries `src`, named by the call site through `createLogger`. There is no
 * unsourced logger to fall back to, so a new module is a type error until it says what it speaks
 * as — see `logger-call-sites.ts` for the half of that a type cannot check.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Who is speaking. One name per message namespace already in use, so `src` and the message agree
 * and neither has to be derived from the other.
 *
 * Widening this is the intended way to add a subsystem. Grouping these into a shorter list for a
 * reader is the log viewer's job, not this module's: it keeps the grouping free to change without
 * touching every logging module again.
 */
export const LOG_SOURCES = [
  "adf",
  "attach-stage",
  "attachments",
  "bot-once",
  "cycle",
  "exec",
  "jira",
  "labels",
  "loop",
  "poll",
  "poll-once",
  "post",
  "recon-once",
  "review",
  "service",
  "session",
  "shutdown",
  "solve",
  "solve-once",
  "sweep-once",
  "triage",
  "triage-once",
  "watch",
  "watch-once",
] as const;

export type LogSource = (typeof LOG_SOURCES)[number];

/** Per-call rendering options, not log fields. Never default `quiet` to `true` — its absence must mean 🔧. */
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
  source: LogSource,
  level: LogLevel,
  message: string,
  fields: Record<string, unknown>,
  options: LogOptions,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel()]) {
    return;
  }

  const payload: Record<string, unknown> = {
    // First key, so it lands in a fixed column on every line (`JSON.stringify` preserves insertion order).
    q: options.quiet === true ? QUIET_MARK : NEWS_MARK,
    ts: new Date().toISOString(),
    level,
    src: source,
    message,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (key === "q" || key === "src") {
      // A spread outcome object could carry either key; kept under `_`-prefixed names rather than
      // dropped or allowed to silently overwrite. A caller-supplied `src` overwriting this one
      // would make the viewer's source filter hide lines it was asked to show.
      payload[`_${key}`] = value;
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

export interface Logger {
  readonly debug: (message: string, fields?: Record<string, unknown>, options?: LogOptions) => void;
  readonly info: (message: string, fields?: Record<string, unknown>, options?: LogOptions) => void;
  readonly warn: (message: string, fields?: Record<string, unknown>, options?: LogOptions) => void;
  readonly error: (message: string, fields?: Record<string, unknown>, options?: LogOptions) => void;
}

/** One instance per source, so every module naming a source holds the object a test can spy on. */
const instances = new Map<LogSource, Logger>();

/** There is deliberately no unsourced logger: an unnamed call site would be a `src` nobody can filter on. */
export function createLogger(source: LogSource): Logger {
  const existing = instances.get(source);
  if (existing !== undefined) {
    return existing;
  }

  const made: Logger = {
    debug: (message, fields = {}, options = {}) => emit(source, "debug", message, fields, options),
    info: (message, fields = {}, options = {}) => emit(source, "info", message, fields, options),
    // Takes the `options` argument only for a uniform signature; never actually quiet in practice.
    warn: (message, fields = {}, options = {}) => emit(source, "warn", message, fields, options),
    error: (message, fields = {}, options = {}) => emit(source, "error", message, fields, options),
  };
  instances.set(source, made);
  return made;
}
