/**
 * The scheduling shell around `runPollCycle`: when to poll again, and when to
 * stop.
 *
 * Kept separate from `index.ts` so it can be tested. `index.ts` executes on
 * import — it is an entry point — so anything a test needs to reach has to live
 * somewhere a test can import without starting a service.
 *
 * `runPollCycle` already isolates per-issue failures, so a throw reaching this
 * layer means something broader broke: Jira is down, the credential expired,
 * the disk is full. Those are exactly the failures that repeat, so retrying at
 * the normal cadence would hammer a struggling dependency and bury the real
 * error in a wall of identical log lines. Hence the backoff.
 */

import { setTimeout as delay } from "node:timers/promises";

import { logger } from "./logger.ts";

export interface LoopOptions {
  /** One poll cycle. Expected to handle its own per-issue failures. */
  readonly runCycle: () => Promise<void>;
  readonly intervalMs: number;
  /** Ceiling for backoff, so a long outage still retries periodically. */
  readonly backoffCapMs: number;
  /** Aborted to request a graceful stop. */
  readonly signal: AbortSignal;
  /** Injected in tests to avoid real waiting. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface LoopSummary {
  readonly cycles: number;
  readonly failures: number;
}

/**
 * Normal interval when the last cycle succeeded, doubling while it does not.
 *
 * Capped rather than unbounded: a service that has backed off to six hours is
 * indistinguishable from a dead one, and the outage it is waiting on will
 * usually have been fixed long before.
 */
export function nextDelayMs(
  consecutiveFailures: number,
  intervalMs: number,
  backoffCapMs: number,
): number {
  if (consecutiveFailures <= 0) {
    return intervalMs;
  }
  // 2 ** n overflows to Infinity eventually; Math.min resolves that to the cap.
  return Math.min(backoffCapMs, intervalMs * 2 ** consecutiveFailures);
}

/**
 * Waits, but wakes immediately on shutdown.
 *
 * A plain timer would make Ctrl-C take up to a full poll interval to be
 * noticed, which reads as a hang. Abort is a normal outcome here, not an
 * error, so it resolves rather than throwing.
 */
export async function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch {
    // Aborted mid-wait: the caller's own signal check handles it.
  }
}

export async function runLoop(options: LoopOptions): Promise<LoopSummary> {
  const sleep = options.sleep ?? interruptibleSleep;

  let cycles = 0;
  let failures = 0;
  let consecutiveFailures = 0;

  while (!options.signal.aborted) {
    cycles += 1;
    try {
      await options.runCycle();
      consecutiveFailures = 0;
    } catch (error) {
      failures += 1;
      consecutiveFailures += 1;
      logger.error("loop.cycle_failed", { error, consecutiveFailures });
    }

    // Checked again because a cycle can take a while, and shutdown requested
    // during one should not be followed by a sleep and another cycle.
    if (options.signal.aborted) {
      break;
    }

    const waitMs = nextDelayMs(consecutiveFailures, options.intervalMs, options.backoffCapMs);
    logger.debug("loop.sleeping", { waitMs, consecutiveFailures });
    await sleep(waitMs, options.signal);
  }

  return { cycles, failures };
}
