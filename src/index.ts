/**
 * The service: poll, triage, repeat, until asked to stop.
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
 */

import { parseDuration } from "./duration.ts";
import { logger } from "./logger.ts";
import { runLoop } from "./loop.ts";
import { runPollCycle } from "./poller.ts";
import {
  type Settings,
  SettingsError,
  describeSettings,
  numeric,
  readSettings,
} from "./settings.ts";
import { loadState } from "./state/store.ts";
import { createJiraClient, createPollDeps } from "./wiring.ts";

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

  if (runForMs !== undefined) {
    // Unref'd: the deadline should not by itself keep the process alive.
    setTimeout(() => stop("deadline"), runForMs).unref();
  }

  return controller;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  let settings: Settings;
  try {
    settings = applyOverrides(readSettings(), argv);
  } catch (error) {
    if (error instanceof SettingsError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 78; // EX_CONFIG
      return;
    }
    throw error;
  }

  const runForRaw = flagValue(argv, "--for");
  const runForMs = runForRaw === undefined ? undefined : parseDuration(runForRaw);
  const intervalMs = numeric(settings, "POLL_INTERVAL_MS");

  logger.info("service.start", {
    ...describeSettings(settings),
    runForMs: runForMs ?? "unbounded",
    pid: process.pid,
  });

  const client = createJiraClient(settings);
  const shutdown = createShutdown(runForMs);
  const deps = createPollDeps(settings, client, shutdown.signal);

  const summary = await runLoop({
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

  logger.info("service.stopped", { cycles: summary.cycles, failures: summary.failures });
}

await main();
