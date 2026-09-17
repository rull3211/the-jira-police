/**
 * The review half of the daemon's schedule: what it costs, how often, and whether it runs at all.
 *
 * Lives here rather than in `index.ts`, which runs `main` on import, so the schedule can be
 * asserted about without starting a service. Deliberately doesn't run the loop itself — that's
 * the caller's job, via `runLoop`.
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
 * Checks the switch first and returns `null` rather than a scheduled no-op, so a disabled solve
 * side doesn't log `review.disabled` every cycle forever. Builds dependencies only after that
 * check, so a missing `VAULT_PATH` can't stop a daemon that never enabled solving. Builds them
 * here rather than per tick, so a misconfiguration fails once at startup instead of identically
 * every cycle.
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
  // Built here, not per tick, so a malformed query (unsafe project key, auto mode with no issue
  // types, an unrecognised SOLVE_MODE) stops the process at startup rather than every cycle.
  const queueDeps = createSolveDeps(settings, client, signal);

  // Logged because the operator is the only bound on what this costs, and can't act on a number
  // never shown.
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
      // Advance before claim, in one function: §6 requires a ticket already under review to move
      // on before a new one is claimed, which two loops on separate cadences can't guarantee.
      // Null: the daemon watches the whole board; naming one ticket is `--watch`'s job.
      await runReviewSweep(settings, client, runDeps, null, signal);

      // Not wrapped in its own try: `runLoop` catches, and swallowing it here would hide the
      // fault from the backoff that exists to slow it.
      await runSolveClaims(settings, queueDeps, client, ledger);
    },
    intervalMs,
    backoffCapMs,
    signal,
  };
}
