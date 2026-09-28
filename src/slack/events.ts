/**
 * The pipeline's own outcomes turned into audit events. Pure, and reusing the one-line descriptions
 * operators already read, so a thread never words an outcome differently from the terminal.
 */

import { describeAdvanceOutcome, describeSolveOutcome } from "../cli/solve-outcome.ts";
import type { AdvanceOutcome } from "../solve/delivery.ts";
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

/** `waiting` is nothing happening, which is not news; everything else earns a line. */
export function reviewOutcomeEvents(outcome: AdvanceOutcome): readonly AuditEvent[] {
  switch (outcome.kind) {
    case "waiting":
      return [];
    case "ready":
      return [{ kind: "pr-ready" }];
    case "iterated": {
      const round: AuditEvent = {
        kind: "review-round",
        text: `review round ${String(outcome.round)}: ${outcome.pushed ? "pushed a change" : "nothing pushed"}, ${String(outcome.responses.length)} answer(s)`,
      };
      return outcome.undrafted === "undrafted" ? [round, { kind: "pr-ready" }] : [round];
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
