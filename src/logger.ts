/**
 * Minimal structured logger. Writes JSON lines to stdout/stderr.
 *
 * House lint config bans `console`, and a service wants machine-readable logs
 * anyway, so this goes straight to the streams.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

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

function emit(level: LogLevel, message: string, fields: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel()]) {
    return;
  }

  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    message,
  };
  for (const [key, value] of Object.entries(fields)) {
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
  debug: (message: string, fields: Record<string, unknown> = {}): void =>
    emit("debug", message, fields),
  info: (message: string, fields: Record<string, unknown> = {}): void =>
    emit("info", message, fields),
  warn: (message: string, fields: Record<string, unknown> = {}): void =>
    emit("warn", message, fields),
  error: (message: string, fields: Record<string, unknown> = {}): void =>
    emit("error", message, fields),
};
