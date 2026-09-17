/**
 * Minimal structured logger. Writes JSON lines to stdout/stderr (house lint bans `console`).
 *
 * Every line carries a `q` marker (⏳ quiet / 🔧 news), defaulting to 🔧 so an unclassified line
 * reads as news rather than disappearing into the quiet pile. It's a third `emit` argument rather
 * than a reserved field because outcome objects spread into `fields` can carry their own `quiet`
 * member (see `WatchSweepOutcome`), which would otherwise collide with and invert the marker.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

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
    message,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (key === "q") {
      // A spread outcome object could carry its own `q` field; kept under `_q` rather than
      // dropped or allowed to silently overwrite the marker.
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
  // Takes the `options` argument only for a uniform signature; never actually quiet in practice.
  warn: (message: string, fields: Record<string, unknown> = {}, options: LogOptions = {}): void =>
    emit("warn", message, fields, options),
  error: (message: string, fields: Record<string, unknown> = {}, options: LogOptions = {}): void =>
    emit("error", message, fields, options),
};
