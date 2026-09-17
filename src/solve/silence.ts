/**
 * How long a pull request has been quiet, measured in wall-clock time rather than a count of poll
 * ticks — a tick count makes patience a function of polling cadence, not of the policy it expresses.
 * `now` is passed in rather than read, so the boundary can be tested without faking time globally.
 */

/** The newest instant among those given, or `null` when none parse — a bad field must not read as the epoch. */
export function newestInstant(instants: readonly string[]): string | null {
  let newest: string | null = null;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const instant of instants) {
    const at = Date.parse(instant);
    if (Number.isNaN(at) || at <= newestMs) {
      continue;
    }
    newest = instant;
    newestMs = at;
  }
  return newest;
}

/**
 * Milliseconds since the last thing that happened, or `null` when nothing carries a date — callers
 * treat `null` as "keep looking", never as a verdict. Clamped at zero so clock skew can't read as recent activity.
 */
export function quietFor(now: number, instants: readonly string[]): number | null {
  const newest = newestInstant(instants);
  if (newest === null) {
    return null;
  }
  return Math.max(0, now - Date.parse(newest));
}

/** Answers `false` on an unmeasurable input rather than firing — a bound that fires when it can't measure is a timeout on the measurement, not a bound. */
export function hasGoneQuiet(quietMs: number | null, silenceMs: number): boolean {
  return quietMs !== null && quietMs >= silenceMs;
}
