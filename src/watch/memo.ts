/**
 * What the watch has already declined, so it does not pay to decline it again.
 *
 * ## The gap this closes, which `relevance.ts` predicted in its own header
 *
 * Every other brake in this feature works because the action it bounds leaves a
 * mark. A re-triage posts a comment, which moves the high-water mark and quiets
 * the ticket; a reservation writes a label, which the next sweep reads. **The
 * relevance check writes nothing.** So a ticket whose latest activity is not an
 * answer — a PM linking a duplicate, a reporter promising to get to it next
 * sprint — stays triggered on that same activity, and is re-judged on every
 * sweep, on identical content, until somebody speaks again or the watch is
 * dropped. §7b's infinite loop, one layer up and two orders of magnitude cheaper
 * per lap, and cheap-per-lap times a daemon is not cheap.
 *
 * The bound is *remember the newest foreign instant already declined*, and skip
 * the ticket while nothing newer than that has arrived.
 *
 * ## In memory, and that is an argument rather than a shortcut
 *
 * §1 refuses on-disk state because losing it causes a **double claim** — a
 * ticket solved twice, a second pull request, real damage. Losing this causes a
 * **repeated cheap read**: one relevance check per watched ticket, once, on the
 * sweep after a restart, and then quiet again. The costs are not the same kind
 * of thing, so the argument does not carry over, and a file here would buy
 * durability nobody needs at the price of the failure §1 spent the design
 * avoiding.
 *
 * It follows that the memo belongs to the **loop**, not to the sweep. A sweep
 * given a fresh one is exactly a run of the command by hand, which cannot run
 * away because a person has to type it again.
 *
 * ## Two things it deliberately does not do
 *
 * **It never remembers anything but a decline.** A re-triage moves the real mark
 * and needs no memo; a refusal to *reserve*, an unreadable counter or a missing
 * high-water mark are all conditions a later sweep should retry, and all of them
 * are free. Only the paid answer is worth caching, and only the paid answer is.
 *
 * **It never expires.** The set is bounded by the tickets carrying the watch
 * label, an entry is a string and a number, and a ticket that unsubscribes
 * leaves a few bytes behind until the process ends. A sweeper for that would be
 * more code than the thing it collects.
 */

import { logger } from "../logger.ts";

export interface WatchMemo {
  /**
   * True when this exact activity has already been paid for and declined.
   *
   * `NaN` is never seen, because a ticket whose foreign activity cannot be dated
   * is one nothing should skip.
   */
  readonly seen: (key: string, at: number) => boolean;
  /** Records a decline. A `NaN` instant is dropped rather than stored. */
  readonly declined: (key: string, at: number) => void;
  /** How many tickets are remembered, for the sweep's own log line. */
  readonly size: () => number;
}

export function createWatchMemo(): WatchMemo {
  const declines = new Map<string, number>();

  return {
    seen: (key, at) => {
      if (Number.isNaN(at)) {
        return false;
      }
      const last = declines.get(key);
      // `<=` rather than `<`: the remembered instant is one that was judged, so
      // an equal one is the same activity. A strict `<` would re-ask on every
      // sweep for any ticket whose newest foreign item never moves, which is
      // every ticket this memo exists for.
      return last !== undefined && at <= last;
    },
    declined: (key, at) => {
      if (Number.isNaN(at)) {
        // Not an error and not silent. A ticket that reaches a paid decline
        // without a datable trigger is a disagreement between the decision and
        // the dating rule, and the consequence is a check re-run every sweep.
        logger.warn("watch.memo.undatable", {
          key,
          note: "declined activity could not be dated, so the check will run again next sweep",
        });
        return;
      }
      declines.set(key, at);
    },
    size: () => declines.size,
  };
}
