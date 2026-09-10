/**
 * One poll cycle: find candidate issues, triage the unseen ones, persist state.
 *
 * The Jira query is injected rather than built here, so the ordering, dedupe
 * and failure-isolation rules below can be tested without a live board.
 *
 * Two correctness rules drive the shape of this file:
 *
 * 1. An issue is recorded as seen only after its report is safely written.
 *    Marking it earlier means a transient failure silently drops a ticket for
 *    good — the cursor moves past it and nothing ever looks at it again.
 *
 * 2. The cursor advances only across an unbroken run of successes from the
 *    oldest issue forward. If issue #3 fails but #4 succeeds, moving the cursor
 *    to #4 would strand #3 outside the next query window. Stopping at the gap
 *    costs a little rework and loses nothing.
 *
 *    **This is a fact about `created` order, not about loop order**, and it
 *    used to be both. The cursor was a flag carried down a loop that happened
 *    to run oldest-first, so the two were indistinguishable until something
 *    wanted to work in a different order. `settledCursor` in `triage/order.ts`
 *    now derives it from created-ascending order and the set of successes, so
 *    the loop below is free to spend in whatever order is worth spending in.
 *
 * 3. State is persisted after every issue rather than once at the end. Each
 *    triage is a paid model run, so losing the record of one to an ill-timed
 *    kill means paying for it twice. Per-cycle saving made the cost of a crash
 *    proportional to the size of the backlog; per-issue saving caps it at one.
 */

import { logger } from "./logger.ts";
import type { OutputSink, TriageResult } from "./output/sink.ts";
import type { TicketRef } from "./jira/types.ts";
import { type PollState, isUnseen, recordSeen, saveState } from "./state/store.ts";
import { byCreatedAscending, settledCursor } from "./triage/order.ts";
import type { TriagePayload } from "./triage/runner.ts";

export interface PollDeps {
  /** Issues created since the cursor, in any order. */
  readonly fetchCandidates: (since: string | null) => Promise<readonly TicketRef[]>;
  readonly triage: (ticket: TicketRef) => Promise<TriagePayload>;
  readonly sink: OutputSink;
  readonly statePath: string;
  /**
   * The order to triage in, when it should not be oldest-first.
   *
   * Injected as a comparator rather than as the status list itself, so this
   * module never learns what a status is and the ordering can be tested
   * without one. Omitted means created-ascending — which is what
   * `byStatusPriority` also returns for an unset `TRIAGE_STATUS_PRIORITY`, so
   * the default is the same behaviour arrived at by two routes rather than a
   * second policy.
   */
  readonly order?: (a: TicketRef, b: TicketRef) => number;
  /**
   * Aborted to request a graceful stop.
   *
   * Checked between issues rather than only between cycles. A cycle with a
   * backlog runs one paid subprocess per issue, sequentially, so "finish the
   * current cycle" can mean several more minutes and several more model runs
   * after the operator has already asked it to stop — which reads as a hang.
   * Stopping between issues keeps shutdown bounded by a single triage.
   */
  readonly signal?: AbortSignal;
}

export interface PollOutcome {
  readonly found: number;
  /** Already handled in an earlier cycle. */
  readonly skipped: number;
  readonly triaged: number;
  readonly failed: number;
  /** Fresh issues never attempted, because shutdown was requested mid-cycle. */
  readonly abandoned: number;
  readonly state: PollState;
}

/** How many of the queue's tickets `poll.order` names before truncating. */
const ORDER_LOG_LIMIT = 10;

export function toTriageResult(ticket: TicketRef, payload: TriagePayload): TriageResult {
  return {
    issueKey: ticket.key,
    issueUrl: ticket.url,
    summary: ticket.summary,
    verdict: payload.verdict,
    labels: payload.labels,
    recommendedNextStep: payload.recommendedNextStep,
    report: payload.report,
    agentFitness: payload.agentFitness,
  };
}

export async function runPollCycle(state: PollState, deps: PollDeps): Promise<PollOutcome> {
  const candidates = (await deps.fetchCandidates(state.cursor)).toSorted(byCreatedAscending);

  // Two orderings of the same issues, and the cycle needs both at once.
  // `fresh` stays created-ascending because that is the only order the cursor
  // may be reasoned about in; `queue` is the order model runs are spent in.
  // Sorting `candidates` above rather than sorting `fresh` keeps the
  // unparseable-timestamp check on every issue found, including ones already
  // seen — a corrupt timestamp should stop the cycle whether or not it happens
  // to land on work we were going to do.
  const fresh = candidates.filter((ticket) => isUnseen(state, ticket.key));
  const queue = deps.order === undefined ? fresh : fresh.toSorted(deps.order);
  const skipped = candidates.length - fresh.length;

  if (fresh.length === 0) {
    logger.debug("poll.nothing_new", { found: candidates.length, skipped });
    return { found: candidates.length, skipped, triaged: 0, failed: 0, abandoned: 0, state };
  }

  logger.info("poll.candidates", { found: candidates.length, skipped, fresh: fresh.length });

  if (deps.order !== undefined) {
    // The instrument for the question `TRIAGE_STATUS_PRIORITY` cannot answer on
    // its own: whether working by column starves the tickets that were moving.
    // Nobody can judge that from the setting, only from the order it actually
    // produced against a real backlog — so the order is printed, at `info`,
    // and only when an operator has opted in by configuring one.
    //
    // Truncated because this is a log line and a backlog has no upper bound.
    // The count is reported separately so a truncated list still says how much
    // it is hiding, rather than looking like the whole queue.
    logger.info("poll.order", {
      total: queue.length,
      head: queue.slice(0, ORDER_LOG_LIMIT).map((ticket) => ({
        key: ticket.key,
        status: ticket.statusName === "" ? ticket.statusId : ticket.statusName,
      })),
    });
  }

  let current = state;
  const succeeded = new Set<string>();
  let triaged = 0;
  let failed = 0;

  for (const ticket of queue) {
    if (deps.signal?.aborted === true) {
      break;
    }

    try {
      const payload = await deps.triage(ticket);
      await deps.sink.write(toTriageResult(ticket, payload));
      succeeded.add(ticket.key);

      // Saved here, not after the loop. The report is already on disk and the
      // model run is already paid for; leaving the key unrecorded until the
      // cycle ends means a kill in between buys the same verdict twice.
      //
      // The cursor is recomputed from `fresh` rather than tracked along this
      // loop, because this loop is no longer in created order. Recomputing is
      // O(n) over a set that is a handful of tickets, and the alternative —
      // remembering how far the created-ascending prefix had got — is the
      // coupling this change removes, reintroduced as an optimisation.
      current = recordSeen(current, [ticket.key], settledCursor(fresh, succeeded));
      await saveState(deps.statePath, current);
      triaged += 1;
    } catch (error) {
      failed += 1;
      // Nothing to do to the cursor: `settledCursor` stops at any issue not in
      // `succeeded`, so this one already blocks it without being told to.
      logger.error("poll.issue_failed", { issueKey: ticket.key, error });
    }
  }

  const abandoned = fresh.length - triaged - failed;
  if (abandoned > 0) {
    // Not an error: these are simply still unseen, so the next run picks them
    // up. Logged because a cycle reporting fewer results than it found would
    // otherwise look like tickets going missing.
    logger.warn("poll.interrupted", { abandoned, note: "left for the next cycle" });
  }

  logger.info("poll.done", { triaged, failed, abandoned });

  return {
    found: candidates.length,
    skipped,
    triaged,
    failed,
    abandoned,
    state: current,
  };
}
