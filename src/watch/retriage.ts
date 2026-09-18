/**
 * Running a re-triage: slice (free) → reserve on paper (free) → ask relevance
 * (cents) → write the reservation → only then run the triage (dollars).
 *
 * The reservation write must precede the triage run and a failure there must
 * stop it (§6.3): a count written after the work is a receipt, and a failed
 * receipt hands back a free run every sweep.
 *
 * Does not take the watch label off itself — that hand-off (§7c) is the
 * triage poster's own decision via `TRIAGE_OWNED_AGENT_LABELS`; a second
 * writer here would eventually disagree with it.
 *
 * `groom` is injected, like `endWatch`'s client, so a module that builds a
 * paid session can be tested without paying.
 */

import type { JiraClient } from "../jira/client.ts";
import type { TicketRef } from "../jira/types.ts";
import { createLogger } from "../logger.ts";
import type { TriagePayload } from "../triage/runner.ts";
import { syntheticTicket } from "../triage/single.ts";
import { retriageContext } from "./context.ts";
import { reserveRetriage } from "./counter.ts";
import type { WatchSignals } from "./decide.ts";
import type { RelevanceChecker } from "./relevance.ts";

const log = createLogger("watch");

export interface RetriageDeps {
  readonly client: Pick<JiraClient, "updateLabels">;
  readonly checker: RelevanceChecker;
  readonly groom: (ticket: TicketRef) => Promise<TriagePayload>;
  /** For the browse URL on the fabricated ticket; nothing here calls it. */
  readonly baseUrl: string;
}

/**
 * What a re-triage attempt did, named so a caller can count spend. Each
 * refusal kind names a different reason, so a sweep can tell "nobody
 * answered" from "the counter is broken".
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
 * Re-triages one watched ticket, or says why it did not. The triage itself is
 * allowed to throw (`createGroom`'s contract) with the reservation already
 * written — the cost of failing closed, not a bug to fix by moving the write.
 */
export async function runRetriage(
  deps: RetriageDeps,
  signals: WatchSignals,
): Promise<RetriageOutcome> {
  const key = signals.key;

  const context = retriageContext(signals);
  if (context === null) {
    log.info("watch.retriage.refused", { key, why: "no comment of ours to measure from" });
    return { kind: "no-mark" };
  }

  // Pure, so an unreadable counter refuses here rather than after a paid
  // check; a readable one is held unwritten until the check says it's worth it.
  const reservation = reserveRetriage(signals.labels);
  if (reservation === null) {
    log.warn("watch.retriage.refused", { key, why: "the re-triage counter will not read" });
    return { kind: "uncountable" };
  }

  const relevance = await deps.checker.check(context);
  if (!relevance.answers) {
    log.info("watch.retriage.declined", { key, reason: relevance.reason });
    return { kind: "irrelevant", reason: relevance.reason };
  }

  try {
    await deps.client.updateLabels(key, reservation);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("watch.retriage.unreserved", { key, error: message });
    return { kind: "unreserved", error: message };
  }
  log.info("watch.retriage.reserved", { key, count: reservation.count });

  const ticket = syntheticTicket(key, deps.baseUrl);
  const payload = await deps.groom(ticket);
  log.info("watch.retriaged", {
    key,
    count: reservation.count,
    verdict: payload.verdict,
    solvable: payload.agentFitness.solvable,
    plausible: payload.agentFitness.plausible,
  });

  return { kind: "retriaged", count: reservation.count, reason: relevance.reason, ticket, payload };
}
