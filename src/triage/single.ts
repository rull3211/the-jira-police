/**
 * Triaging one named key, when discovery is the half being skipped. Shared by every caller that
 * names a key rather than receiving one from the poller, so the fabricated `TicketRef` fields
 * have one definition instead of a hand-copied one per caller.
 *
 * Pure, and no I/O: what the callers do with the result — write it, print it, hand it to a
 * solver — is theirs.
 */

import type { TicketRef } from "../jira/types.ts";
import type { TriageResult } from "../output/sink.ts";
import type { TriagePayload } from "./runner.ts";

/**
 * A ticket reference for a key somebody typed, with the fields discovery would have filled in
 * left honestly empty. The summary says so in words rather than being blank, since it is the one
 * fabricated field that reaches `TriageResult.summary` and a reader should be able to tell which
 * report had a real ticket behind it.
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
