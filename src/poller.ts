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
}

export interface PollOutcome {
  readonly found: number;
  /** Already handled in an earlier cycle. */
  readonly skipped: number;
  readonly triaged: number;
  readonly failed: number;
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
    return { found: candidates.length, skipped, triaged: 0, failed: 0, state };
  }

  logger.info("poll.candidates", { found: candidates.length, skipped, fresh: fresh.length });

  const processed: string[] = [];
  let cursorCreated: string | null = null;
  let stillContiguous = true;
  let failed = 0;

  for (const ticket of fresh) {
    try {
      const payload = await deps.triage(ticket);
      await deps.sink.write(toTriageResult(ticket, payload));

      processed.push(ticket.key);
      if (stillContiguous) {
        cursorCreated = ticket.created;
      }
    } catch (error) {
      failed += 1;
      // Leave the cursor behind this issue so the next cycle sees it again.
      stillContiguous = false;
      logger.error("poll.issue_failed", { issueKey: ticket.key, error });
    }
  }

  const next = recordSeen(state, processed, cursorCreated);
  if (processed.length > 0 || failed > 0) {
    await saveState(deps.statePath, next);
  }

  logger.info("poll.done", { triaged: processed.length, failed });

  return {
    found: candidates.length,
    skipped,
    triaged: processed.length,
    failed,
    state: next,
  };
}
