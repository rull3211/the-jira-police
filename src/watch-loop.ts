/**
 * The sendback watch's place in the daemon's schedule: whether it runs, how
 * often, and what it is allowed to do when it does.
 *
 * Beside `review-loop.ts` and built the same way, for the same reason: `index.ts`
 * runs `main` at import, so anything decided inside it cannot be asserted about
 * without starting a service. Every decision this loop adds is in this function,
 * and it does not run the loop — `runLoop` is the caller's to start, so a test
 * can read the schedule that was chosen without anything ticking.
 *
 * ## This is the switch that most deserves to be a switch
 *
 * Every other loop in this service spends because somebody asked for something.
 * A ticket was labelled, a reviewer commented, an operator typed a command. This
 * one spends because a reporter edited a ticket, which is not a request for
 * anything and may not even be about us. `WATCH_ENABLED` is therefore read
 * first, and returning `null` rather than a loop that declines every tick is the
 * same choice `createReviewLoop` made: a scheduled no-op would write
 * `watch.disabled` into the operator's log forever, which is a service reporting
 * that nothing is happening into the stream read to find out what is.
 *
 * ## The memo is a parameter, and that is the whole reason this file is not two
 * lines
 *
 * `relevance.ts` names the one cost its own design cannot pay for: **a `no` is
 * silent, and silence does not clear the trigger.** Every other brake works
 * because the action leaves a mark on the ticket. A check that declines writes
 * nothing, so the ticket stays triggered on that same activity and is re-judged
 * on the next sweep, and the next, on identical content.
 *
 * `watch:once` is safe from that because it has no next sweep. This file is the
 * next sweep, and the bound is *one memo for as long as the process lives*.
 *
 * **So the caller supplies it rather than this function building one**, and the
 * choice is about which mutations are reachable. Built here and closed over, the
 * failure is one line moving into `runCycle` — after which the loop pays for the
 * same refusal every sweep forever, while every test still passes, because a
 * test that runs a single tick cannot see the difference. Taken as a parameter,
 * a `runCycle` that ignored it would have to ignore an argument, which a test
 * that hands in a memo and ticks twice does see. The lifetime is the process's,
 * and `index.ts` is what has one.
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
 * `watch:once` has the identical override and the identical argument, and the
 * duplication is two lines rather than an import because the two are separate
 * grants: an operator's `--write` and a daemon's `WATCH_ENABLED` are different
 * decisions by different people, and a shared helper would make relaxing one
 * relax the other. The argument itself: the watch is self-limiting only because
 * a re-triage moves the high-water mark it measures from, and the mark is our
 * own comment. A paid run that analysed and posted nothing would leave the
 * ticket triggered on identical content and buy the same run on the next sweep —
 * §7b's infinite loop, restored by a value in `.env` rather than by any code.
 */
function posting(settings: Settings): Settings {
  return { ...settings, WRITE_BACK: "true" };
}

/**
 * The watch loop's schedule, or `null` if the watch is switched off.
 *
 * Dependencies are built after the switch and before the first tick, for the two
 * reasons `createReviewLoop` gives: a daemon with the watch off must not refuse
 * to start over a setting it will never read, and a misconfiguration must be one
 * message at startup rather than a cycle that fails identically forever, backing
 * off to the cap, visible only as "the cycle threw".
 *
 * `backoffCapMs` and `memo` are parameters because `index.ts` owns both and
 * cannot be imported from — it starts the service on import.
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

  // **The daemon always acts.** `watch:once` has a dry mode because its whole
  // second job is calibration — a person deciding whether this switch is safe to
  // arm. Here the switch *is* that decision, already made, and a loop that swept
  // every six hours and changed nothing would be the most expensive way
  // available to write "would have" into a log nobody reads.
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

  // The operator is the last bound on what this costs, and a bound cannot act on
  // a number it has not been shown — least of all here, where the point is that
  // nobody is looking. The cadence and the per-ticket cap are both stated,
  // because the worst case is their product and neither alone says it.
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
      logger.info("watch.cycle.done", { ...outcome, remembered: memo.size() });
    },
    intervalMs,
    backoffCapMs,
    signal,
  };
}

/**
 * Where a per-ticket line goes when nobody is at a terminal.
 *
 * The log rather than stdout: a service's stdout is wherever it was started
 * from, which is frequently nothing, and these lines are the only per-ticket
 * record of a decision that may have cost money.
 */
function report(line: string): void {
  logger.info("watch.cycle.ticket", { line: line.trim() });
}
