/**
 * One pass over the watched tickets: look at each, and if authorised, act.
 *
 * Shared between `watch:once` and the daemon so the order in which a ticket is
 * looked at, decided about and paid for cannot diverge between them. The two
 * callers differ only in `acting` (a dry run holds no writer at all) and
 * `memo` (the daemon's persists across ticks; the command's is fresh each run).
 */

import type { IssueActivity, JiraClient } from "../jira/client.ts";
import { createLogger } from "../logger.ts";
import type { OutputSink } from "../output/sink.ts";
import { toTriageResult } from "../triage/single.ts";
import { describeDecision, describeRetriage } from "../cli/watch-args.ts";
import type { TicketCommenter } from "../solve/feedback.ts";
import { decideWatch, newestForeignAt, type WatchDecision, type WatchSignals } from "./decide.ts";
import { endWatch } from "./end.ts";
import type { WatchMemo } from "./memo.ts";
import { type RetriageDeps, runRetriage } from "./retriage.ts";
import { toWatchSignals } from "./signals.ts";

const log = createLogger("watch");

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
  /** Where a per-ticket line goes: stdout for the command, the log for the daemon. */
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
  /** Kept beside the decision rather than recomputed, so `runRetriage` sees exactly what `decideWatch` did. */
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

  log.debug("watch.looked", {
    key,
    closed: signals.closed,
    comments: signals.comments.length,
    changes: signals.changes.length,
    decision: decision.kind,
    // Every distinct field name, unfiltered: `decideWatch` returns on the
    // first trigger so a commented-on ticket never reaches the changelog, and
    // a list pre-filtered by `BLOCKER_CLEARING_FIELDS` could only confirm its
    // own guess about which field names this board actually uses.
    fields: [...new Set(signals.changes.flatMap((change) => change.fields))].toSorted(),
  });

  return { activity, signals, decision };
}

/**
 * Sweeps the given keys, in order. Never throws for one ticket's sake — the
 * attempt is already reserved by the time a triage run could fail, so
 * abandoning the rest of the sweep would only hide them.
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
      // Checked before the paid call, not after: the memo bounds the check
      // itself, not the free look that happens regardless.
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
        log.warn("watch.sweep.retriage_failed", { key, error: message });
      }
    }
  }

  return { looked: keys.length, ...counts, ended, retriaged, failed, skipped };
}
