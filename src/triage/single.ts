/**
 * Triaging one named key, when discovery is the half being skipped.
 *
 * `createGroom` takes a `TicketRef` and reads exactly one field off it. Every
 * caller that names a key rather than receiving one from the poller therefore
 * has to fabricate the other seven, and until now each of them fabricated its
 * own copy: `triage:once` and `bot:once` held the same eight-line literal and
 * the same seven-line result mapping, byte for byte. The sendback watch is the
 * third caller, and three copies of a literal that models another module's
 * input is the defect this repository has now recorded four times — most
 * recently in `client.test.ts`'s hand-copied label list, where the copy stopped
 * agreeing with the thing it copied and nothing failed.
 *
 * Pure, and no I/O: what the callers do with the result — write it, print it,
 * hand it to a solver — is theirs.
 */

import type { TicketRef } from "../jira/types.ts";
import type { TriageResult } from "../output/sink.ts";
import type { TriagePayload } from "./runner.ts";

/**
 * A ticket reference for a key somebody typed, with the fields discovery would
 * have filled in left honestly empty.
 *
 * The summary says so in words rather than being blank, because it is the one
 * fabricated field that reaches an artifact — `TriageResult.summary` — and a
 * reader comparing two reports should be able to tell which one had a real
 * ticket behind it. `updated` and `labels` are empty for the reason
 * `TicketRef.updated`'s own comment gives: the honest normalisation of a value
 * that was never fetched is an absent value, not a plausible stand-in.
 */
export function syntheticTicket(issueKey: string, baseUrl: string): TicketRef {
  return {
    key: issueKey,
    summary: `${issueKey} (summary not fetched in single-run mode)`,
    url: `${baseUrl}/browse/${issueKey}`,
    created: new Date().toISOString(),
    updated: "",
    labels: [],
    issueTypeId: "",
    issueTypeName: "",
    statusId: "",
    statusName: "",
  };
}

/** The payload as an artifact, carrying the fitness call rather than only its conclusion. */
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
