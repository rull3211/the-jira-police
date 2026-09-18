/**
 * What the watch has already declined, so it does not pay to decline it again.
 *
 * The relevance check writes nothing to the ticket, unlike every other brake
 * in this feature, so a `no` leaves the trigger in place and would be
 * re-judged every sweep forever without this (§7b's loop, one layer up).
 * Bounds by remembering the newest foreign instant already declined, in
 * memory only — losing it costs one repeated cheap read, not the double
 * claim §1 avoids by refusing on-disk state — and belongs to the daemon's
 * loop, not the sweep, so `watch:once` always starts fresh. Only a paid
 * decline is cached; unreadable counters and missing marks are free to retry.
 * The set never expires; it is bounded by tickets carrying the watch label.
 */

import { logger } from "../logger.ts";

export interface WatchMemo {
  /** True when this exact activity has already been paid for and declined; `NaN` is never seen as such. */
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
      // `<=` rather than `<`: an equal instant is the same activity already
      // judged; strict `<` would re-ask every sweep on an unmoved ticket.
      return last !== undefined && at <= last;
    },
    declined: (key, at) => {
      if (Number.isNaN(at)) {
        // Logged rather than silent: an undatable trigger reaching a paid
        // decline means the check will re-run every sweep.
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
