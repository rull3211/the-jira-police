/**
 * The review half of the daemon's schedule: what it costs, how often, and
 * whether it runs at all.
 *
 * It lives here rather than in `index.ts` for the reason `pollIntervalMs` does:
 * `index.ts` runs `main` at import, so anything decided inside it cannot be
 * asserted about without starting a service. Every decision this change adds is
 * in this function — the switch, the cadence, the dependencies and the moment
 * they are built — so putting it anywhere else would be shipping the whole of
 * Phase E as wiring nothing can look at.
 *
 * It deliberately does not run the loop. `runLoop` is the caller's to start, so
 * a test can read the schedule that was chosen without anything ticking.
 */

import { runReviewSweep, runSolveClaims } from "./cli/solve-run.ts";
import type { JiraClient } from "./jira/client.ts";
import { logger } from "./logger.ts";
import type { LoopOptions } from "./loop.ts";
import type { AttemptLedger } from "./solve/attempts.ts";
import { REVIEW_ROUND_USD } from "./solve/review-cycle.ts";
import { type Settings, flag, numeric } from "./settings.ts";
import { createSolveDeps, createSolveRunDeps, reviewIntervalMs } from "./wiring.ts";

/**
 * The review loop's schedule, or `null` if the solve side is switched off.
 *
 * ## Three things happen in order here, and the order is the interesting part
 *
 * **The switch is read first.** Returning `null` rather than a loop that does
 * nothing is deliberate twice over. `runReviewCycle` already refuses when
 * `SOLVE_ENABLED` is off, so a scheduled no-op would be correct — and would
 * write `review.disabled` into the log every two minutes forever, a service
 * reporting that nothing is happening into the stream an operator reads to find
 * out what is. Said once, at startup, beside the settings it was read from.
 *
 * **Then the dependencies, and only then.** `createSolveRunDeps` throws
 * `SettingsError` on a missing `VAULT_PATH`. Building it above the switch would
 * mean a daemon with the solve side switched off refusing to start for want of
 * a path it will never read — an operator running the grooming service exactly
 * as they did yesterday, stopped by a feature they did not enable.
 *
 * **And they are built here rather than per tick**, which is the same argument
 * `runReviewSweep` makes for taking them as a parameter: inside the loop, one
 * misconfiguration is a cycle that fails identically forever, backing off to the
 * cap, with the real cause visible only as "the cycle threw". Out here it is one
 * message and exit 78.
 *
 * `backoffCapMs` is a parameter because `index.ts` owns it and cannot be
 * imported from — it starts the service on import. `ledger` is one for the
 * stronger reason the watch's memo is: see `runCycle` below.
 */
export function createReviewLoop(
  settings: Settings,
  client: JiraClient,
  signal: AbortSignal,
  backoffCapMs: number,
  ledger: AttemptLedger,
): LoopOptions | null {
  if (!flag(settings, "SOLVE_ENABLED")) {
    logger.info("review.loop.disabled", {
      note: "SOLVE_ENABLED is off; no pull request is looked at and no round is run",
    });
    return null;
  }

  const intervalMs = reviewIntervalMs(settings);
  const maxRounds = numeric(settings, "MAX_REVIEW_ROUNDS_PER_TICK", 0);
  const runDeps = createSolveRunDeps(settings);
  // Built here for the reason `runDeps` is, and `wiring.ts` makes the argument
  // at the point it builds the two queries eagerly: a malformed one — an unsafe
  // project key, auto mode with no issue types, a `SOLVE_MODE` nobody
  // recognises — should stop the process at startup rather than on whichever
  // cycle first reaches the board. Constructed per tick, as the first draft of
  // this did, that guarantee is defeated from the outside while the file
  // asserting it stays true of itself, and the operator gets a cycle that
  // throws identically every two minutes and reports itself as `cycle_failed`.
  const queueDeps = createSolveDeps(settings, client, signal);

  // The banner `--watch` prints, as a log line. The operator is the last bound
  // on what this costs, and a bound cannot act on a number it has not been
  // shown — least of all here, where the whole point is that nobody is looking.
  logger.info("review.loop.start", {
    intervalMs,
    maxRoundsPerTick: maxRounds,
    worstCasePerTickUsd: Number((maxRounds * REVIEW_ROUND_USD).toFixed(2)),
    note:
      maxRounds === 0
        ? "zero rounds per tick: every pull request is looked at and none is paid for"
        : "a look is two gh reads; only a round costs money",
  });

  return {
    runCycle: async () => {
      // ## Advance, then claim, and it is one tick rather than two loops
      //
      // §6 asks that a ticket already under review be moved on before any new
      // one is picked up, and the cheapest way to guarantee an ordering is to
      // make it a sequence in one function. Two loops on two cadences cannot
      // promise it at all: whichever fires first wins, and at
      // `MAX_CONCURRENT_SOLVES=1` losing that race means the slot is spent on a
      // new solve while a pull request a human is waiting on goes unread for
      // another tick. The cost of one tick is now the sum of both halves, which
      // is why the interval is the review cadence rather than the poll one.
      //
      // Null: the daemon watches the whole board. Naming one ticket is
      // `--watch`'s argument and there is nobody here to name it.
      await runReviewSweep(settings, client, runDeps, null, signal);

      // Not in a `try` of its own. `runLoop` catches, and a claim sweep that
      // throws after the review sweep has already run has lost nothing the next
      // tick will not redo — whereas swallowing it here would back off on
      // nothing and hide the fault from the backoff that exists to slow it.
      await runSolveClaims(settings, queueDeps, client, ledger);
    },
    intervalMs,
    backoffCapMs,
    signal,
  };
}
