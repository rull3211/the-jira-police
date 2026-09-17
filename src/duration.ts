/** Human-writable durations (`30s`, `4m`) for CLI flags; settings themselves stay in milliseconds. */

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/;

const SCALE: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

export function parseDuration(value: string): number {
  const match = DURATION.exec(value.trim());
  const scale = match === null ? undefined : SCALE[match[2] ?? "ms"];
  if (match === null || scale === undefined) {
    throw new Error(`Not a duration: ${JSON.stringify(value)}. Try 30s, 4m, 2h or 240000.`);
  }
  return Number(match[1]) * scale;
}
