/**
 * How long a pull request has been quiet, read off the pull request.
 *
 * ## What this replaces, and why counting ticks was wrong
 *
 * `MAX_REVIEW_WAITS` was a count of consecutive silent polls, held in a `let`
 * inside `runReviewChain`. Two things are wrong with that and only the first is
 * obvious.
 *
 * The obvious one: it is the only bound in this service that lives on a
 * process's stack. `MAX_REVIEW_ITERATIONS` and `MAX_PR_ROUNDS_TOTAL` are both
 * read off the marker comment, so they survive a restart, a second instance and
 * a wiped `state/` — for the reasons `marker.ts` sets out. The silence bound
 * survived none of it, and a poll cycle over many pull requests has no stack to
 * put it on at all: there is one process and N pull requests, and the thing
 * being bounded is a property of each pull request rather than of the loop.
 *
 * The one that actually bites: **a count of ticks makes patience a function of
 * cadence.** Ten waits at a two-minute interval is twenty minutes; the same ten
 * waits at one minute is ten. So changing how often the loop looks silently
 * changes how long it is willing to wait — a cadence change becoming a policy
 * change, with nothing in either setting's name saying so. Wall-clock time is
 * the thing the policy is actually about, so wall-clock time is what is
 * measured, and `REVIEW_POLL_MS` goes back to meaning only how often to look.
 *
 * ## The clock starts at the last thing that happened, and errs towards waiting
 *
 * Everything dated on the pull request counts, including comments this service
 * wrote itself. That looks too generous — our own marker post resets the clock —
 * and it is the safe direction on purpose. Giving up early abandons a pull
 * request a reviewer was about to look at, and there is no cheap way back from
 * that; waiting longer costs one `gh` read per tick, which is free. The
 * asymmetry decides it.
 *
 * ## No I/O, and no `Date.now()` either
 *
 * `now` is passed in. A function that reads the clock cannot be tested against
 * a boundary without either faking time globally or sleeping, and the boundary
 * is the whole of the behaviour here.
 */

/**
 * The newest instant among those given, or `null` when none of them parse.
 *
 * Unparseable and empty entries are skipped rather than treated as the epoch.
 * Reading a missing date as 1970 would make one bad field say the pull request
 * has been quiet for fifty years, which is the failure direction this module
 * refuses everywhere else.
 */
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
 * Milliseconds since the last thing that happened, or `null` when nothing that
 * happened carries a date.
 *
 * **`null` is not zero and not infinity.** It means the question cannot be
 * answered from this pull request, and the callers below turn that into "keep
 * looking" rather than into a verdict. A pull request always has a creation
 * instant, so reaching `null` means the payload was not what it claimed to be —
 * and inventing a duration from that is how a loop stops watching something it
 * never actually looked at.
 *
 * Clamped at zero. A clock skew that puts the newest comment in the future
 * would otherwise report a negative quiet, which reads as "very recently
 * active" by luck rather than by intent.
 */
export function quietFor(now: number, instants: readonly string[]): number | null {
  const newest = newestInstant(instants);
  if (newest === null) {
    return null;
  }
  return Math.max(0, now - Date.parse(newest));
}

/**
 * Whether the pull request has been quiet long enough to stop waiting on it.
 *
 * The unknown case answers `false`, and that is the only interesting line here.
 * A bound that fires when it cannot measure is not a bound, it is a timeout on
 * the measurement — and the thing it would end is a pull request somebody is
 * waiting on.
 */
export function hasGoneQuiet(quietMs: number | null, silenceMs: number): boolean {
  return quietMs !== null && quietMs >= silenceMs;
}
