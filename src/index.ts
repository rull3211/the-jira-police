/**
 * The service: poll, triage, repeat, until asked to stop — and, since Phase E,
 * look at the pull requests already under review while it does.
 *
 *   pnpm start
 *   node src/index.ts --skill live-triage-probe --interval 30s --for 4m
 *
 * Flags override settings for a single run. They exist because a smoke test
 * wants a 30-second cadence and a real skill without editing `.env` and
 * risking those values being left behind in it.
 *
 * Shutdown is graceful: SIGINT/SIGTERM lets the current cycle finish, so an
 * issue mid-triage is either completed and recorded or left untouched for the
 * next run. A second signal exits immediately, for when that is too slow.
 *
 * ## Two loops, and the separation is the safety property
 *
 * The grooming loop is the one that has been running in production. The review
 * loop is new, spends an order of magnitude more per action, and shells out to
 * `git` and `gh`. **The first requirement of adding it was that it cannot stop
 * the grooming loop from doing what it did yesterday**, and the cheapest way to
 * get that is not a `try`/`catch` around a shared tick — it is two loops that
 * share only a Jira client and a shutdown signal. A `gh` that is missing, a
 * repository that was renamed, a review sweep backing off to fifteen minutes:
 * none of them are visible from the other side.
 *
 * They also want different cadences for different reasons — see
 * `reviewIntervalMs` — and a single tick would make the two-minute half wait
 * behind the twenty-minute-per-issue half. `TRIAGE_TIMEOUT_MS` is 20 minutes,
 * so one wedged triage would hold the review sweep for longer than a reviewer
 * takes to answer, every time.
 *
 * **What that costs, stated plainly, because nothing here bounds it:** the two
 * loops can spend at the same time and no setting spans them. A tick's worth of
 * review rounds is bounded by `MAX_REVIEW_ROUNDS_PER_TICK` and a triage cycle by
 * the queue, and the total is the sum of two numbers nobody chose together.
 * When the solve half joins this file it goes *inside* the review loop rather
 * than beside it, so that "advance before claiming" stays an ordering that one
 * tick can guarantee.
 */

import { parseDuration } from "./duration.ts";
import { logger } from "./logger.ts";
import { runLoop } from "./loop.ts";
import { runPollCycle } from "./poller.ts";
import { createReviewLoop } from "./review-loop.ts";
import { type Settings, describeSettings, readSettings, withConfigErrors } from "./settings.ts";
import { loadState } from "./state/store.ts";
import { createJiraClient, createPollDeps, pollIntervalMs } from "./wiring.ts";

/** Backoff ceiling. Long enough to stop hammering, short enough to recover unattended. */
const BACKOFF_CAP_MS = 15 * 60 * 1000;

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function applyOverrides(settings: Settings, argv: readonly string[]): Settings {
  const skill = flagValue(argv, "--skill");
  const interval = flagValue(argv, "--interval");

  return {
    ...settings,
    ...(skill === undefined ? {} : { SKILL_NAME: skill }),
    ...(interval === undefined ? {} : { POLL_INTERVAL_MS: String(parseDuration(interval)) }),
  };
}

/**
 * Wires shutdown to signals and, optionally, to a deadline.
 *
 * The deadline is what makes an unattended smoke test possible: run for four
 * minutes, then stop the way a real shutdown would rather than being killed
 * mid-triage by an external timer.
 */
function createShutdown(runForMs: number | undefined): AbortController {
  const controller = new AbortController();
  let requested = false;

  const stop = (reason: string): void => {
    if (requested) {
      logger.warn("shutdown.forced", { reason });
      process.exit(130);
    }
    requested = true;
    logger.info("shutdown.requested", { reason, note: "finishing the current cycle" });
    controller.abort();
  };

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  // SIGHUP is the one that actually happened. Node's default action for it is
  // immediate termination, so a daemon started in a terminal died the instant
  // that terminal closed — mid-cycle, with no `service.stopped` line and no
  // chance to finish the ticket in flight. The symptom is the worst kind: a
  // service that is simply gone, with nothing in its own logs to say why.
  //
  // Handled identically to the other two rather than ignored. A closed terminal
  // is a legitimate request to stop; the bug was never that it stopped, only
  // that it stopped abruptly and silently. Surviving a hangup is a job for
  // nohup or a service manager, not for this process to arrogate.
  process.on("SIGHUP", () => stop("SIGHUP"));

  if (runForMs !== undefined) {
    // Unref'd: the deadline should not by itself keep the process alive.
    setTimeout(() => stop("deadline"), runForMs).unref();
  }

  return controller;
}

/**
 * Makes a silent death loud.
 *
 * `runLoop` catches everything `runCycle` throws, so no triage failure can end
 * the service — which means any exit that is not a signal came from outside
 * that try, and Node's default is to print to stderr and leave. If stderr is a
 * terminal that has since closed, the reason is simply lost, and the only
 * evidence left is a stale state file and a process that is no longer there.
 *
 * These handlers do not attempt recovery: the process still exits, because a
 * daemon carrying on after an unhandled rejection is in an unknown state. They
 * exist so the last thing it does is say why, in the same structured format as
 * everything else it logs.
 */
function logUnexpectedExits(): void {
  process.on("unhandledRejection", (reason) => {
    logger.error("service.unhandled_rejection", { error: reason });
    process.exitCode = 1;
  });

  process.on("uncaughtException", (error) => {
    logger.error("service.uncaught_exception", { error });
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  logUnexpectedExits();

  const settings = applyOverrides(readSettings(), argv);

  const runForRaw = flagValue(argv, "--for");
  const runForMs = runForRaw === undefined ? undefined : parseDuration(runForRaw);
  const intervalMs = pollIntervalMs(settings);

  logger.info("service.start", {
    ...describeSettings(settings),
    runForMs: runForMs ?? "unbounded",
    pid: process.pid,
  });

  const client = createJiraClient(settings);
  const shutdown = createShutdown(runForMs);

  // Built before anything starts ticking, so a configuration problem on the
  // review side stops the process instead of leaving the grooming loop running
  // against a service that is half up.
  const review = createReviewLoop(settings, client, shutdown.signal, BACKOFF_CAP_MS);
  const deps = createPollDeps(settings, client, shutdown.signal);

  const grooming = runLoop({
    // State is reloaded each cycle rather than held in memory: the file is the
    // source of truth, and rereading it means an out-of-band edit — or a
    // `poll:once` run alongside this one — is respected instead of clobbered.
    runCycle: async () => {
      const state = await loadState(settings.STATE_PATH);
      const outcome = await runPollCycle(state, deps);
      logger.info("cycle.done", {
        found: outcome.found,
        skipped: outcome.skipped,
        triaged: outcome.triaged,
        failed: outcome.failed,
        abandoned: outcome.abandoned,
        cursor: outcome.state.cursor,
      });
    },
    intervalMs,
    backoffCapMs: BACKOFF_CAP_MS,
    signal: shutdown.signal,
  });

  // Both are awaited together rather than raced: a shutdown aborts the shared
  // signal, and each loop finishes the cycle it is in. Stopping when the first
  // one returns would kill a review round mid-push to make a poll cycle's exit
  // look tidy.
  const [groomed, reviewed] = await Promise.all([
    grooming,
    review === null ? Promise.resolve(null) : runLoop(review),
  ]);

  logger.info("service.stopped", {
    cycles: groomed.cycles,
    failures: groomed.failures,
    reviewCycles: reviewed?.cycles ?? "off",
    reviewFailures: reviewed?.failures ?? "off",
  });
}

await withConfigErrors(main);
