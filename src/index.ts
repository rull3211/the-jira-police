/**
 * The service: poll, triage, repeat — plus sweeping PRs under review and tickets sent back for an answer.
 *
 * The three loops share only a Jira client and a shutdown signal, so a failure in one cannot stop
 * another. See architecture/overview.md §2.
 */

import { parseDuration } from "./duration.ts";
import { createLogger } from "./logger.ts";
import { runLoop } from "./loop.ts";
import { runPollCycle } from "./poller.ts";
import { createReviewLoop } from "./review-loop.ts";
import {
  type Settings,
  describeSettings,
  numeric,
  readSettings,
  withConfigErrors,
} from "./settings.ts";
import { createAttemptLedger } from "./solve/attempts.ts";
import { loadState } from "./state/store.ts";
import { createWatchLoop } from "./watch-loop.ts";
import { createWatchMemo } from "./watch/memo.ts";
import { createJiraClient, createPollDeps, pollIntervalMs } from "./wiring.ts";

const cycleLog = createLogger("cycle");
const serviceLog = createLogger("service");
const shutdownLog = createLogger("shutdown");

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

/** Wires shutdown to signals and, optionally, a deadline, so a timed smoke test stops like a real shutdown rather than being killed mid-triage. */
function createShutdown(runForMs: number | undefined): AbortController {
  const controller = new AbortController();
  let requested = false;

  const stop = (reason: string): void => {
    if (requested) {
      shutdownLog.warn("shutdown.forced", { reason });
      process.exit(130);
    }
    requested = true;
    shutdownLog.info("shutdown.requested", { reason, note: "finishing the current cycle" });
    controller.abort();
  };

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  // Node's default action for SIGHUP is immediate termination, so left unhandled it
  // kills the service mid-cycle instead of shutting down gracefully.
  process.on("SIGHUP", () => stop("SIGHUP"));

  if (runForMs !== undefined) {
    // Unref'd: the deadline should not by itself keep the process alive.
    setTimeout(() => stop("deadline"), runForMs).unref();
  }

  return controller;
}

/** Logs unhandled rejections and exceptions before exiting; anything reaching here bypassed `runLoop`'s own catch and would otherwise be lost silently. */
function logUnexpectedExits(): void {
  process.on("unhandledRejection", (reason) => {
    serviceLog.error("service.unhandled_rejection", { error: reason });
    process.exitCode = 1;
  });

  process.on("uncaughtException", (error) => {
    serviceLog.error("service.uncaught_exception", { error });
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

  serviceLog.info("service.start", {
    ...describeSettings(settings),
    runForMs: runForMs ?? "unbounded",
    pid: process.pid,
  });

  const client = createJiraClient(settings);
  const shutdown = createShutdown(runForMs);

  // Built before the loops start so a review config problem fails fast instead of leaving
  // grooming running against a half-up service. The ledger's lifetime must be the process's,
  // not the cycle's, or a released-but-unlabelled ticket would retry every tick forever.
  const review = createReviewLoop(
    settings,
    client,
    shutdown.signal,
    BACKOFF_CAP_MS,
    createAttemptLedger(numeric(settings, "MAX_SOLVE_ATTEMPTS_PER_TICKET", 3)),
  );
  // Built here, not per cycle, because its lifetime must be the process's: a relevance check
  // that says no writes nothing to the ticket, so the memo is the only record an answer was spent.
  const watch = createWatchLoop(
    settings,
    client,
    shutdown.signal,
    BACKOFF_CAP_MS,
    createWatchMemo(),
  );
  const deps = createPollDeps(settings, client, shutdown.signal);

  const grooming = runLoop({
    // Reloaded each cycle, not held in memory, so an out-of-band edit or a concurrent
    // `poll:once` run is respected instead of clobbered.
    runCycle: async () => {
      const state = await loadState(settings.STATE_PATH);
      const outcome = await runPollCycle(state, deps);
      cycleLog.info(
        "cycle.done",
        {
          found: outcome.found,
          skipped: outcome.skipped,
          triaged: outcome.triaged,
          failed: outcome.failed,
          abandoned: outcome.abandoned,
          cursor: outcome.state.cursor,
        },
        // `found`/`skipped` aren't news: most cycles see everything and change nothing.
        // Only spending something (a triage, a failure, an abandonment) is news.
        {
          quiet: outcome.triaged === 0 && outcome.failed === 0 && outcome.abandoned === 0,
        },
      );
    },
    intervalMs,
    backoffCapMs: BACKOFF_CAP_MS,
    signal: shutdown.signal,
  });

  // Awaited together, not raced: stopping when the first loop returns would kill another
  // loop's cycle mid-push just to make the exit look tidy.
  const [groomed, reviewed, watched] = await Promise.all([
    grooming,
    review === null ? Promise.resolve(null) : runLoop(review),
    watch === null ? Promise.resolve(null) : runLoop(watch),
  ]);

  serviceLog.info("service.stopped", {
    cycles: groomed.cycles,
    failures: groomed.failures,
    reviewCycles: reviewed?.cycles ?? "off",
    reviewFailures: reviewed?.failures ?? "off",
    watchCycles: watched?.cycles ?? "off",
    watchFailures: watched?.failures ?? "off",
  });
}

await withConfigErrors(main);
