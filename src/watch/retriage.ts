/**
 * Running a re-triage, in the order that makes the brakes work.
 *
 * This is the engine everything else in `src/watch/` was built to bound.
 * `decideWatch` says a ticket moved, `retriageContext` says what moved,
 * `relevance.ts` says whether it moved in the direction we asked for, and
 * `counter.ts` says how many attempts are left. None of them spends anything.
 * This does, and it is the only loop in the service that can spend with nobody
 * having asked for anything, so the sequencing below is the design rather than
 * an implementation detail:
 *
 * 1. **Slice, free.** No high-water mark, no run — the same condition
 *    `decideWatch` unsubscribes on, checked again here because this function is
 *    reachable from a named key that never went through the decision.
 * 2. **Reserve on paper, free.** `reserveRetriage` is pure, so an unreadable
 *    counter refuses before a single session starts. Nothing is written yet:
 *    the budget counts re-triages, and a check that answers *no* has not
 *    performed one.
 * 3. **Ask whether it is worth it**, at cents.
 * 4. **Write the reservation**, and only then
 * 5. **run the triage**, at dollars.
 *
 * **Step 4 comes before step 5 and a failure there stops the run.** §6.3
 * settled this for the review marker and the argument transfers unchanged: a
 * count written *after* the work is a receipt, and a failed receipt hands back
 * a free run on every sweep, forever. A count written before is a reservation,
 * and the worst it can do is spend an attempt on a run that then fails — which
 * is visible on the board as a number that moved, rather than invisible as a
 * charge that repeats.
 *
 * **What this does not do is take the label off**, and that is deliberate
 * rather than unfinished. §7c's hand-off — `agent:watching` off, `agent:solvable`
 * possibly on — is a *triage* decision and the triage poster already makes it:
 * both labels are in `TRIAGE_OWNED_AGENT_LABELS`, so the run this function pays
 * for is allowed to write them and is the only party that knows the new verdict.
 * A second writer here would be this service deciding a ticket's fitness from
 * outside the component that assesses it, and the two would eventually disagree.
 * If the triage leaves the label on, the watch simply continues — its own newest
 * comment is now the high-water mark, so the ticket reads as quiet until
 * somebody speaks again.
 *
 * The groom is injected rather than constructed, for the reason `endWatch`
 * takes its client: a module that builds a paid session cannot be tested
 * without paying.
 */

import type { JiraClient } from "../jira/client.ts";
import type { TicketRef } from "../jira/types.ts";
import { logger } from "../logger.ts";
import type { TriagePayload } from "../triage/runner.ts";
import { syntheticTicket } from "../triage/single.ts";
import { retriageContext } from "./context.ts";
import { reserveRetriage } from "./counter.ts";
import type { WatchSignals } from "./decide.ts";
import type { RelevanceChecker } from "./relevance.ts";

export interface RetriageDeps {
  readonly client: Pick<JiraClient, "updateLabels">;
  readonly checker: RelevanceChecker;
  readonly groom: (ticket: TicketRef) => Promise<TriagePayload>;
  /** For the browse URL on the fabricated ticket; nothing here calls it. */
  readonly baseUrl: string;
}

/**
 * What a re-triage attempt did, named so a caller can count spend.
 *
 * Four of the five kinds are refusals and each names a different reason,
 * because they fail in different directions and an operator reading a sweep
 * needs to tell "nobody answered" from "the counter is broken".
 */
export type RetriageOutcome =
  /** No comment of ours, so nothing to judge the activity against. */
  | { readonly kind: "no-mark" }
  /** The counter on the ticket will not read, and it must not read as zero. */
  | { readonly kind: "uncountable" }
  /** Somebody moved, and it was not an answer. The commonest outcome by design. */
  | { readonly kind: "irrelevant"; readonly reason: string }
  /** The reservation would not write, so the run that it authorises does not happen. */
  | { readonly kind: "unreserved"; readonly error: string }
  | {
      readonly kind: "retriaged";
      /** The count the ticket now carries. */
      readonly count: number;
      readonly reason: string;
      readonly ticket: TicketRef;
      readonly payload: TriagePayload;
    };

/**
 * Re-triages one watched ticket, or says why it did not.
 *
 * The triage itself is allowed to throw. That is `createGroom`'s existing
 * contract — a refused verdict is not a partial result — and a caller sweeping
 * several tickets should treat it the way the poller does. The reservation is
 * already written when it happens, which is the cost of failing closed and is
 * stated here so nobody later "fixes" it by moving the write.
 */
export async function runRetriage(
  deps: RetriageDeps,
  signals: WatchSignals,
): Promise<RetriageOutcome> {
  const key = signals.key;

  const context = retriageContext(signals);
  if (context === null) {
    logger.info("watch.retriage.refused", { key, why: "no comment of ours to measure from" });
    return { kind: "no-mark" };
  }

  // Pure, and therefore free to check before anything is started. An unreadable
  // counter refuses here rather than after a paid check, and a readable one is
  // held unwritten until the check says the run is worth making.
  const reservation = reserveRetriage(signals.labels);
  if (reservation === null) {
    logger.warn("watch.retriage.refused", { key, why: "the re-triage counter will not read" });
    return { kind: "uncountable" };
  }

  const relevance = await deps.checker.check(context);
  if (!relevance.answers) {
    logger.info("watch.retriage.declined", { key, reason: relevance.reason });
    return { kind: "irrelevant", reason: relevance.reason };
  }

  try {
    await deps.client.updateLabels(key, reservation);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("watch.retriage.unreserved", { key, error: message });
    return { kind: "unreserved", error: message };
  }
  logger.info("watch.retriage.reserved", { key, count: reservation.count });

  const ticket = syntheticTicket(key, deps.baseUrl);
  const payload = await deps.groom(ticket);
  logger.info("watch.retriaged", {
    key,
    count: reservation.count,
    verdict: payload.verdict,
    solvable: payload.agentFitness.solvable,
    plausible: payload.agentFitness.plausible,
  });

  return { kind: "retriaged", count: reservation.count, reason: relevance.reason, ticket, payload };
}
