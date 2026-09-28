import { describe, expect, it } from "vitest";

import type { AdvanceOutcome } from "../solve/delivery.ts";
import type { SolveOutcome } from "../solve/orchestrator.ts";
import type { TriagePayload } from "../triage/runner.ts";
import {
  prEndedEvent,
  reviewOutcomeEvents,
  solveOutcomeEvent,
  triageVerdictEvent,
} from "./events.ts";

/** Only the four fields `reviewOutcomeEvents` reads; the rest of an `iterated` outcome is irrelevant to it. */
function iterated(undrafted: "undrafted" | "still-drafting", pushed: boolean): AdvanceOutcome {
  return {
    kind: "iterated",
    round: 2,
    pushed,
    responses: ["a", "b"],
    undrafted,
  } as unknown as AdvanceOutcome;
}

function payload(solvable: boolean): TriagePayload {
  return {
    verdict: "ready-ish",
    agentFitness: { solvable, plausible: false, confidence: "high" },
  } as unknown as TriagePayload;
}

describe("triageVerdictEvent", () => {
  it("carries the confidence only for a ticket called solvable", () => {
    expect(triageVerdictEvent(payload(true), true)).toMatchObject({
      solvable: true,
      confidence: "high",
      posted: true,
    });
    expect(triageVerdictEvent(payload(false), false)).toMatchObject({
      solvable: false,
      confidence: null,
      posted: false,
    });
  });
});

describe("solveOutcomeEvent", () => {
  it("turns a verified run into verified, and a pass that died into a crash naming the pass", () => {
    expect(solveOutcomeEvent({ kind: "verified" } as SolveOutcome)).toEqual({ kind: "verified" });
    expect(
      solveOutcomeEvent({
        kind: "crashed",
        pass: "fix",
        reason: "exit 1",
        worktree: { path: "/w" },
      } as unknown as SolveOutcome),
    ).toEqual({ kind: "crashed", where: "fix pass", message: "exit 1" });
  });

  it("ends every other outcome with its kind and the first line an operator reads, no worktree path", () => {
    const event = solveOutcomeEvent({
      kind: "abandoned",
      cause: "judgement",
      reason: "the brief was wrong",
      worktree: { path: "/tmp/worktrees/SSX-1" },
    } as unknown as SolveOutcome);

    expect(event).toMatchObject({ kind: "solve-ended", outcome: "abandoned" });
    expect((event as { reason: string }).reason).toContain("the brief was wrong");
    expect((event as { reason: string }).reason).not.toContain("/tmp/worktrees");
  });
});

describe("reviewOutcomeEvents", () => {
  it("says nothing about a reviewer who has not spoken", () => {
    expect(reviewOutcomeEvents({ kind: "waiting", quietMs: 1000 })).toEqual([]);
  });

  it("marks the pull request ready when the round undrafted it, and only then", () => {
    expect(reviewOutcomeEvents(iterated("undrafted", true)).map((event) => event.kind)).toEqual([
      "review-round",
      "pr-ready",
    ]);
    expect(reviewOutcomeEvents(iterated("still-drafting", false))).toEqual([
      { kind: "review-round", text: "review round 2: nothing pushed, 2 answer(s)" },
    ]);
  });

  it("gives every other outcome a timeline line in the words the terminal uses", () => {
    const [event] = reviewOutcomeEvents({ kind: "capped", rounds: 20, unresolved: "" });

    expect(event).toMatchObject({ kind: "review-round" });
    expect((event as { text: string }).text.length).toBeGreaterThan(0);
  });
});

describe("prEndedEvent", () => {
  it("maps Jira's states to the record's", () => {
    expect(prEndedEvent("MERGED")).toEqual({ kind: "pr-ended", state: "merged" });
    expect(prEndedEvent("CLOSED")).toEqual({ kind: "pr-ended", state: "closed" });
  });
});
