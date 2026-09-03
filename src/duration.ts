/**
 * Human-writable durations for command-line flags.
 *
 * Settings express every duration in milliseconds, which is right for a config
 * file and miserable on a command line: `--for 240000` is a number nobody reads
 * correctly at a glance, and `--interval 30s` is unambiguous.
 *
 * Its own module because the entry point that uses it executes on import, and
 * a test should be able to reach this without starting a service.
 */

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/;

const SCALE: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/** Parses `30s`, `4m`, `2h`, `1.5m`, or a bare millisecond count. */
export function parseDuration(value: string): number {
  const match = DURATION.exec(value.trim());
  const scale = match === null ? undefined : SCALE[match[2] ?? "ms"];
  if (match === null || scale === undefined) {
    throw new Error(`Not a duration: ${JSON.stringify(value)}. Try 30s, 4m, 2h or 240000.`);
  }
  return Number(match[1]) * scale;
}
