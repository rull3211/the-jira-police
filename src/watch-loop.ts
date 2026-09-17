/**
 * The sendback watch's place in the daemon's schedule: whether it runs, how often, and what it
 * may do when it does.
 *
 * `WATCH_ENABLED` is read first and returns `null` rather than a scheduled no-op, same as
 * `createReviewLoop`. The memo is a parameter, not built inside `runCycle`, because a relevance
 * check that says no writes nothing to the ticket — nothing clears the trigger — so the memo
 * must live as long as the process, not the cycle, or the same refusal repeats every sweep.
 */

import type { JiraClient } from "./jira/client.ts";
import { buildSendbackWatchJql } from "./jira/jql.ts";
import { logger } from "./logger.ts";
import type { LoopOptions } from "./loop.ts";
import { FileSink } from "./output/sink.ts";
import { type Settings, flag, list, numeric } from "./settings.ts";
import type { WatchMemo } from "./watch/memo.ts";
import type { RetriageDeps } from "./watch/retriage.ts";
import { runWatchSweep, type WatchActing } from "./watch/sweep.ts";
import {
  createGroom,
  createSolveCommenter,
  createWatchChecker,
  watchIntervalMs,
} from "./wiring.ts";

/**
 * The same settings with the re-triage's comment turned on.
 *
 * A re-triage that posted nothing would leave the ticket triggered on identical content and
 * buy the same run every sweep — §7b's infinite loop, restored by a `.env` value rather than code.
 */
function posting(settings: Settings): Settings {
  return { ...settings, WRITE_BACK: "true" };
}

/**
 * The watch loop's schedule, or `null` if the watch is switched off.
 *
 * Dependencies are built after the switch check, for the same reasons as `createReviewLoop`:
 * a disabled watch must not refuse to start over a setting it never reads, and a
 * misconfiguration must fail once at startup rather than every cycle.
 */
export function createWatchLoop(
  settings: Settings,
  client: JiraClient,
  signal: AbortSignal,
  backoffCapMs: number,
  memo: WatchMemo,
): LoopOptions | null {
  if (!flag(settings, "WATCH_ENABLED")) {
    logger.info("watch.loop.disabled", {
      note: "WATCH_ENABLED is off; no sent-back ticket is looked at and no re-triage is run",
    });
    return null;
  }

  const intervalMs = watchIntervalMs(settings);
  const maxRetriage = numeric(settings, "MAX_RETRIAGE_PER_TICKET");
  const jql = buildSendbackWatchJql({
    project: settings.JIRA_PROJECT,
    components: list(settings, "JIRA_COMPONENTS"),
  });

  // The daemon always acts, unlike `watch:once`'s dry mode: arming `WATCH_ENABLED` is itself
  // the decision that switch exists to make.
  const acting: WatchActing = {
    commenter: createSolveCommenter(settings),
    sink: new FileSink(settings.OUTPUT_DIR),
    retriage: {
      client,
      checker: createWatchChecker(settings),
      groom: createGroom(posting(settings)),
      baseUrl: settings.JIRA_BASE_URL,
    } satisfies RetriageDeps,
  };

  // Cadence and per-ticket cap are both logged because the worst case is their product;
  // neither alone says it.
  logger.info("watch.loop.start", {
    intervalMs,
    maxRetriagePerTicket: maxRetriage,
    jql,
    note: "a sweep costs one read per watched ticket; only a re-triage costs dollars",
  });

  return {
    runCycle: async () => {
      const keys = (await client.search(jql)).map((ticket) => ticket.key);
      const outcome = await runWatchSweep({ client, maxRetriage, memo, acting, report }, keys);
      logger.info(
        "watch.cycle.done",
        { ...outcome, remembered: memo.size() },
        // `outcome.quiet` is deliberately not read here: it counts tickets nobody touched, not
        // a verdict on the sweep, and colliding the two would invert the marker.
        { quiet: outcome.retriaged === 0 && outcome.failed === 0 && outcome.ended === 0 },
      );
    },
    intervalMs,
    backoffCapMs,
    signal,
  };
}

/** Logged rather than written to stdout, which is frequently nothing for a daemon. */
function report(line: string): void {
  logger.info("watch.cycle.ticket", { line: line.trim() });
}
