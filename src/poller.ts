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
 * 3. State is persisted after every issue rather than once at the end. Each
 *    triage is a paid model run, so losing the record of one to an ill-timed
 *    kill means paying for it twice. Per-cycle saving made the cost of a crash
 *    proportional to the size of the backlog; per-issue saving caps it at one.
 */

import { logger } from "./logger.ts";
import type { OutputSink, TriageResult } from "./output/sink.ts";
import type { TicketRef } from "./jira/types.ts";
import { type PollState, isUnseen, recordSeen, saveState } from "./state/store.ts";
import type { TriagePayload } from "./triage/runner.ts";

export interface PollDeps {
  /** Issues created since the cursor, in any order. */
  readonly fetchCandidates: (since: string | null) => Promise<readonly TicketRef[]>;
  readonly triage: (ticket: TicketRef) => Promise<TriagePayload>;
  readonly sink: OutputSink;
  readonly statePath: string;
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

/**
 * Oldest first, so the cursor can advance monotonically as work succeeds.
 *
 * Compares instants, not strings. Jira returns `created` with a numeric offset
 * rather than `Z` — `2026-09-02T09:55:34.178+0200` — and the offset changes at
 * the DST boundary. A lexicographic compare then orders `02:00+0100` (01:00Z)
 * before `02:30+0200` (00:30Z), which is backwards, and the cursor would
 * advance past the earlier ticket and drop it permanently.
 *
 * Ties break on key so the order is total: equal timestamps are common, and an
 * unstable order there would make the cursor's resume point non-deterministic.
 */
function byCreatedAscending(a: TicketRef, b: TicketRef): number {
  const delta = instant(a) - instant(b);
  return delta === 0 ? a.key.localeCompare(b.key) : delta;
}

/**
 * Fails loudly on a timestamp we cannot read.
 *
 * `Date.parse` returns NaN rather than throwing, and NaN from a comparator
 * leaves the order arbitrary — which would silently drop tickets. Everything
 * else in this module is built to never lose an issue quietly, so a
 * nonsensical timestamp should stop the cycle instead.
 */
function instant(ticket: TicketRef): number {
  const parsed = Date.parse(ticket.created);
  if (Number.isNaN(parsed)) {
    throw new Error(`${ticket.key} has an unparseable created timestamp: ${ticket.created}`);
  }
  return parsed;
}

export async function runPollCycle(state: PollState, deps: PollDeps): Promise<PollOutcome> {
  const candidates = (await deps.fetchCandidates(state.cursor)).toSorted(byCreatedAscending);

  const fresh = candidates.filter((ticket) => isUnseen(state, ticket.key));
  const skipped = candidates.length - fresh.length;

  if (fresh.length === 0) {
    logger.debug("poll.nothing_new", { found: candidates.length, skipped });
    return { found: candidates.length, skipped, triaged: 0, failed: 0, abandoned: 0, state };
  }

  logger.info("poll.candidates", { found: candidates.length, skipped, fresh: fresh.length });

  let current = state;
  let stillContiguous = true;
  let triaged = 0;
  let failed = 0;

  for (const ticket of fresh) {
    if (deps.signal?.aborted === true) {
      break;
    }

    try {
      const payload = await deps.triage(ticket);
      await deps.sink.write(toTriageResult(ticket, payload));

      // Saved here, not after the loop. The report is already on disk and the
      // model run is already paid for; leaving the key unrecorded until the
      // cycle ends means a kill in between buys the same verdict twice.
      current = recordSeen(current, [ticket.key], stillContiguous ? ticket.created : null);
      await saveState(deps.statePath, current);
      triaged += 1;
    } catch (error) {
      failed += 1;
      // Leave the cursor behind this issue so the next cycle sees it again.
      stillContiguous = false;
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
