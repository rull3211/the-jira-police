/**
 * Per-ticket attempt count, kept in memory, so a ticket that keeps failing stops
 * being claimed. `solve:once`/`bot:once` and tickets with a terminal label are
 * never counted.
 * In memory rather than a label like §1's (§3a): losing it on restart costs one
 * extra attempt, not a double claim.
 */

import { createLogger } from "../logger.ts";

const log = createLogger("solve");

export interface AttemptLedger {
  /**
   * True when this ticket has already been claimed as many times as allowed.
   * Check before claiming: the claim is the cheap part of what follows it.
   */
  readonly exhausted: (key: string) => boolean;
  /** Records that a claim is about to be attempted. Called before the work. */
  readonly attempted: (key: string) => void;
  /** How many attempts this ticket has cost, for a log line. */
  readonly countFor: (key: string) => number;
  /** How many distinct tickets are remembered, for the cycle's own log line. */
  readonly size: () => number;
}

export function createAttemptLedger(max: number): AttemptLedger {
  const attempts = new Map<string, number>();

  return {
    // `>=`, not `>`: the count is of attempts already made, so `>` would grant
    // one more attempt than the operator asked for.
    exhausted: (key) => (attempts.get(key) ?? 0) >= max,
    attempted: (key) => {
      const now = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, now);
      if (now >= max) {
        // Logged once, at the attempt that reaches the cap, not on every skip after.
        log.warn("solve.attempts.exhausted", {
          key,
          attempts: now,
          max,
          note: "the daemon will not claim this ticket again until it restarts or the ticket leaves the queue",
        });
      }
    },
    countFor: (key) => attempts.get(key) ?? 0,
    size: () => attempts.size,
  };
}
