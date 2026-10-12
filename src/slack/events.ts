/**
 * The pipeline's own outcomes, and what a review look saw, turned into audit events. Pure, and reusing
 * the one-line descriptions operators already read, so a thread never words an outcome differently.
 */

import { describeAdvanceOutcome, describeSolveOutcome } from "../cli/solve-outcome.ts";
import type { AdvanceOutcome } from "../solve/delivery.ts";
import { AGENT_LABELS } from "../solve/labels.ts";
import type { SolveOutcome } from "../solve/orchestrator.ts";
import type { TriagePayload } from "../triage/runner.ts";
import type { AuditEvent } from "./audit.ts";

export function triageVerdictEvent(payload: TriagePayload, posted: boolean): AuditEvent {
  return {
    kind: "triage-verdict",
    verdict: payload.verdict,
    solvable: payload.agentFitness.solvable,
    confidence: payload.agentFitness.solvable ? payload.agentFitness.confidence : null,
    posted,
  };
}

export function solveOutcomeEvent(outcome: SolveOutcome): AuditEvent {
  switch (outcome.kind) {
    case "verified":
      return { kind: "verified" };
    case "crashed":
      return { kind: "crashed", where: `${outcome.pass} pass`, message: outcome.reason };
    default:
      return {
        kind: "solve-ended",
        outcome: outcome.kind,
        reason: firstLine(describeSolveOutcome(outcome)),
      };
  }
}

/**
 * What a review look found, for `observed`. The labels are read, never trusted as a verdict: a
 * person can add `agent:solvable` by hand.
 */
export function observedEvent(
  labels: readonly string[],
  pr: { readonly url: string | null; readonly number: number; readonly draft: boolean },
): AuditEvent {
  const dor = labels.includes("dor:pass") ? "pass" : labels.includes("dor:gaps") ? "gaps" : null;
  const solvable = labels.includes(AGENT_LABELS.solvable);
  return {
    kind: "observed",
    pr: { url: pr.url ?? "", number: pr.number, draft: pr.draft },
    triage: dor === null && !solvable ? null : { dor, solvable },
  };
}

/**
 * `waiting` and `unlanded` recur every tick until someone comments, so they are not news; everything
 * else earns a line. `pr-reworking` mirrors `reviewStageAfter` handing the ticket back to `reviewing`.
 */
export function reviewOutcomeEvents(outcome: AdvanceOutcome): readonly AuditEvent[] {
  switch (outcome.kind) {
    case "waiting":
    case "unlanded":
      return [];
    case "ready":
      return [{ kind: "pr-ready" }];
    case "iterated": {
      const round: AuditEvent = {
        kind: "review-round",
        text: `review round ${String(outcome.round)}: ${outcome.pushed ? "pushed a change" : "nothing pushed"}, ${String(outcome.responses.length)} answer(s)`,
      };
      return [
        round,
        outcome.undrafted === "undrafted" ? { kind: "pr-ready" } : { kind: "pr-reworking" },
      ];
    }
    case "reviewer-exhausted":
      return [
        { kind: "review-round", text: firstLine(describeAdvanceOutcome(outcome)) },
        { kind: "pr-ready" },
      ];
    default:
      return [{ kind: "review-round", text: firstLine(describeAdvanceOutcome(outcome)) }];
  }
}

/**
 * The runner's own timeout, local commands included, what Node's `fetch`, gh and git print when the
 * far end never answered, and a gateway in front of it giving up. Matched on text, so a source
 * rewording one makes it a crash again.
 */
const NETWORK_FAILURE =
  /\btimed out\b|aborted due to timeout|fetch failed|error connecting to|\bdial tcp\b|could not resolve host|handshake timeout|\b(?:HTTP|Jira returned) 50[234]\b/iu;

/** A review look, or a round, that threw. Retried every tick, so a network failure must not broadcast. */
export function reviewFailureEvent(reason: string): AuditEvent {
  return NETWORK_FAILURE.test(reason)
    ? { kind: "unreachable", where: "review", message: reason }
    : { kind: "crashed", where: "review", message: reason };
}

export function prEndedEvent(state: "MERGED" | "CLOSED"): AuditEvent {
  return { kind: "pr-ended", state: state === "MERGED" ? "merged" : "closed" };
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}
