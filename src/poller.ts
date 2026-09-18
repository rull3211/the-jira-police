/**
 * One poll cycle: find candidate issues, triage the unseen ones, persist state.
 *
 * An issue is marked seen only after its report is durably written, so a transient failure can't
 * silently drop it. The cursor only advances across an unbroken run of successes from the oldest
 * issue forward — `settledCursor` derives this from created order and the success set, independent
 * of the order triage actually runs in. State saves after every issue, not once at the end, so a
 * crash mid-cycle repays at most one triage twice.
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
   * Injected as a comparator so this module never learns what a status is. Omitted means
   * created-ascending, the same default `byStatusPriority` returns for an unset priority.
   */
  readonly order?: (a: TicketRef, b: TicketRef) => number;
  /**
   * Aborted to request a graceful stop.
   *
   * Checked between issues, not only between cycles, so shutdown is bounded by a single triage
   * rather than by the rest of a sequential, one-subprocess-per-issue backlog.
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

  // `fresh` stays created-ascending, the only order the cursor can be reasoned about in;
  // `queue` is the order triage actually spends in. Sorting `candidates` (not `fresh`) up
  // front runs the unparseable-timestamp check on already-seen issues too.
  const fresh = candidates.filter((ticket) => isUnseen(state, ticket.key));
  const queue = deps.order === undefined ? fresh : fresh.toSorted(deps.order);
  const skipped = candidates.length - fresh.length;

  if (fresh.length === 0) {
    logger.debug("poll.nothing_new", { found: candidates.length, skipped });
    return { found: candidates.length, skipped, triaged: 0, failed: 0, abandoned: 0, state };
  }

  logger.info("poll.candidates", { found: candidates.length, skipped, fresh: fresh.length });

  if (deps.order !== undefined) {
    // Whether `TRIAGE_STATUS_PRIORITY` starves moving tickets can only be judged from the
    // queue it actually produced, so it's logged only when an operator opted into an order.
    // Truncated because a backlog has no upper bound; total is reported separately so a
    // truncated list doesn't read as the whole queue.
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

      // Saved here, not after the loop, so a kill mid-cycle doesn't buy the same paid triage
      // twice. Cursor is recomputed from `fresh` rather than tracked along this loop, because
      // the loop is no longer in created order.
      current = recordSeen(current, [ticket.key], settledCursor(fresh, succeeded));
      await saveState(deps.statePath, current);
      triaged += 1;
    } catch (error) {
      failed += 1;
      // Nothing to do to the cursor: `settledCursor` already stops at any issue not in `succeeded`.
      logger.error("poll.issue_failed", { issueKey: ticket.key, error });
    }
  }

  const abandoned = fresh.length - triaged - failed;
  if (abandoned > 0) {
    // Not an error: still unseen, so the next run picks them up. Logged so fewer results
    // than found doesn't read as tickets going missing.
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
