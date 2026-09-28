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

export function prEndedEvent(state: "MERGED" | "CLOSED"): AuditEvent {
  return { kind: "pr-ended", state: state === "MERGED" ? "merged" : "closed" };
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}
