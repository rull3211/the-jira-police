/**
 * One pass over the watched tickets: look at each, and if authorised, act.
 *
 * It was the body of `watch:once`'s `main` until the daemon needed it too.
 * Extracted rather than reimplemented, and the reason is this repository's
 * oldest rule: a second copy of *the order in which a watched ticket is looked
 * at, decided about and paid for* is a copy that stops agreeing on the day one
 * of them changes — and the two callers here differ in exactly the way that
 * makes the divergence invisible, since one is run by a person watching the
 * output and the other by nobody.
 *
 * What the callers do differ in is the two things that actually separate them:
 *
 * - **`acting`.** A dry run holds no writer at all, so the refusal is structural
 *   rather than a branch that could be got wrong — B1's argument for `SolveDeps`,
 *   which has now been made four times in this tree and has never been wrong.
 * - **`memo`.** The daemon's persists across ticks and is the only thing bounding
 *   a check that answers *no* without writing anything; the command's is fresh
 *   every time, which is correct because a person typing it again is the bound.
 *
 * The sweep itself takes no view on either. It cannot spend without the first
 * and cannot run away without the second, and both are the caller's to supply.
 */

import type { IssueActivity, JiraClient } from "../jira/client.ts";
import { logger } from "../logger.ts";
import type { OutputSink } from "../output/sink.ts";
import { toTriageResult } from "../triage/single.ts";
import { describeDecision, describeRetriage } from "../cli/watch-args.ts";
import type { TicketCommenter } from "../solve/feedback.ts";
import { decideWatch, newestForeignAt, type WatchDecision, type WatchSignals } from "./decide.ts";
import { endWatch } from "./end.ts";
import type { WatchMemo } from "./memo.ts";
import { type RetriageDeps, runRetriage } from "./retriage.ts";
import { toWatchSignals } from "./signals.ts";

/** Everything needed to act on a decision. Absent on a dry run, entirely. */
export interface WatchActing {
  readonly commenter: TicketCommenter;
  readonly sink: OutputSink;
  readonly retriage: RetriageDeps;
}

export interface WatchSweepDeps {
  readonly client: Pick<JiraClient, "fetchActivity">;
  readonly maxRetriage: number;
  readonly memo: WatchMemo;
  readonly acting: WatchActing | null;
  /**
   * Where a per-ticket line goes.
   *
   * The command writes it to stdout, where a person reads it; the daemon writes
   * it to the log, where nobody does until something has gone wrong. Passed in
   * rather than chosen here, because a sweep that wrote to stdout from inside a
   * service would interleave with nothing and be lost, and one that only logged
   * would make the calibration command silent.
   */
  readonly report: (line: string) => void;
}

export interface WatchSweepOutcome {
  readonly looked: number;
  readonly retriage: number;
  readonly quiet: number;
  readonly unsubscribe: number;
  /** Watches actually taken off, which is fewer than `unsubscribe` on a dry run. */
  readonly ended: number;
  /** Paid re-triages that ran. */
  readonly retriaged: number;
  /** Re-triages that threw after the attempt was reserved. */
  readonly failed: number;
  /** Tickets whose trigger the memo had already paid to decline. */
  readonly skipped: number;
}

interface Look {
  readonly activity: IssueActivity;
  /**
   * Kept beside the decision rather than recomputed by the caller. `runRetriage`
   * needs exactly what `decideWatch` was shown, and deriving it twice is two
   * readings of one fetch that can disagree — the shape of divergence this
   * repository keeps finding.
   */
  readonly signals: WatchSignals;
  readonly decision: WatchDecision;
}

async function look(
  client: Pick<JiraClient, "fetchActivity">,
  key: string,
  maxRetriage: number,
): Promise<Look> {
  const activity = await client.fetchActivity(key);
  const signals = toWatchSignals(activity);
  const decision = decideWatch(signals, maxRetriage);

  logger.debug("watch.looked", {
    key,
    closed: signals.closed,
    comments: signals.comments.length,
    changes: signals.changes.length,
    decision: decision.kind,
    // **The calibration datum, and the decision cannot carry it.**
    //
    // `decideWatch` reads comments before the changelog and returns on the
    // first trigger, so any ticket somebody has also commented on reports the
    // comment and says nothing about the fields — which is precisely the
    // ticket a reporter answering a sendback produces. The one question this
    // log exists to answer would therefore be masked on exactly the population
    // it was pointed at.
    //
    // Every distinct field name, whatever its age and whether or not it is
    // allowlisted, because the failure being hunted is a name this board uses
    // that `BLOCKER_CLEARING_FIELDS` does not: a filtered list can only ever
    // confirm the guess it was filtered by.
    fields: [...new Set(signals.changes.flatMap((change) => change.fields))].toSorted(),
  });

  return { activity, signals, decision };
}

/**
 * Sweeps the given keys, in order.
 *
 * Never throws for one ticket's sake. `runRetriage` lets a refused verdict
 * through, which is `createGroom`'s contract and right for a single named run;
 * here the attempt is already reserved, so abandoning the remaining tickets buys
 * nothing and hides them. The daemon's reason is stronger still — a loop that
 * dies on one bad ticket backs off to the cap and stops watching the rest.
 */
export async function runWatchSweep(
  deps: WatchSweepDeps,
  keys: readonly string[],
): Promise<WatchSweepOutcome> {
  const counts = { retriage: 0, quiet: 0, unsubscribe: 0 };
  let ended = 0;
  let retriaged = 0;
  let failed = 0;
  let skipped = 0;

  for (const key of keys) {
    const { activity, signals, decision } = await look(deps.client, key, deps.maxRetriage);
    counts[decision.kind] += 1;
    deps.report(describeDecision(key, decision));

    if (deps.acting === null) {
      continue;
    }

    if (decision.kind === "unsubscribe") {
      const did = await endWatch(
        { client: deps.acting.retriage.client, commenter: deps.acting.commenter },
        key,
        activity,
        decision.reason,
      );
      if (did === "unsubscribed") {
        ended += 1;
      }
    }

    if (decision.kind === "retriage") {
      // **Before the check, because the check is the thing being bounded.** The
      // look above is one read and happens regardless; what the memo prevents is
      // paying a session to give the same answer about the same activity on
      // every sweep for as long as the ticket stays subscribed.
      const at = newestForeignAt(signals);
      if (deps.memo.seen(key, at)) {
        skipped += 1;
        deps.report(`          ↳ already declined this activity; not asking again`);
        continue;
      }

      try {
        const outcome = await runRetriage(deps.acting.retriage, signals);
        deps.report(`          ↳ ${describeRetriage(outcome)}`);
        if (outcome.kind === "irrelevant") {
          deps.memo.declined(key, at);
        }
        if (outcome.kind === "retriaged") {
          retriaged += 1;
          await deps.acting.sink.write(toTriageResult(outcome.ticket, outcome.payload));
        }
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        deps.report(`          ↳ re-triage failed: ${message}`);
        logger.warn("watch.sweep.retriage_failed", { key, error: message });
      }
    }
  }

  return { looked: keys.length, ...counts, ended, retriaged, failed, skipped };
}
