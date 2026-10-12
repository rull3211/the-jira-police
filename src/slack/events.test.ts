import { describe, expect, it } from "vitest";

import { describeAdvanceOutcome } from "../cli/solve-outcome.ts";
import type { AdvanceOutcome } from "../solve/delivery.ts";
import type { SolveOutcome } from "../solve/orchestrator.ts";
import type { TriagePayload } from "../triage/runner.ts";
import {
  observedEvent,
  prEndedEvent,
  reviewFailureEvent,
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

  it("says nothing about a round that never landed, since that settle recurs until someone comments", () => {
    expect(reviewOutcomeEvents({ kind: "unlanded", round: 3 })).toEqual([]);
  });

  it("marks the pull request ready when the round undrafted it, and sends it back when not", () => {
    expect(reviewOutcomeEvents(iterated("undrafted", false)).map((event) => event.kind)).toEqual([
      "review-round",
      "pr-ready",
    ]);
    expect(reviewOutcomeEvents(iterated("still-drafting", true))).toEqual([
      { kind: "review-round", text: "review round 2: pushed a change, 2 answer(s)" },
      { kind: "pr-reworking" },
    ]);
  });

  it("marks the pull request ready when the reviewer's budget ran out, since that undrafts it too", () => {
    expect(
      reviewOutcomeEvents({ kind: "reviewer-exhausted", rounds: 3, unresolved: "" }).map(
        (event) => event.kind,
      ),
    ).toEqual(["review-round", "pr-ready"]);
  });

  it("gives a capped outcome one timeline line, in the words the terminal prints for it", () => {
    const outcome = { kind: "capped", rounds: 20, unresolved: "" } as const;

    expect(reviewOutcomeEvents(outcome)).toEqual([
      { kind: "review-round", text: describeAdvanceOutcome(outcome).split("\n", 1)[0] },
    ]);
  });
});

describe("observedEvent", () => {
  const pr = { url: "https://github.com/o/r/pull/7", number: 7, draft: false };

  it("reads triage's call from the labels triage writes, and nothing from the rest", () => {
    expect(observedEvent(["dor:pass", "agent:solvable", "route:ours"], pr)).toMatchObject({
      triage: { dor: "pass", solvable: true },
    });
    expect(observedEvent(["dor:gaps"], pr)).toMatchObject({
      triage: { dor: "gaps", solvable: false },
    });
    expect(observedEvent(["agent:review-done", "urgent"], pr)).toMatchObject({ triage: null });
  });

  it("shows a PR without a URL as its number rather than failing the look", () => {
    expect(observedEvent([], { ...pr, url: null })).toMatchObject({ pr: { url: "", number: 7 } });
  });
});

describe("reviewFailureEvent", () => {
  // Worded as each source prints it; the ones marked were measured offline on 2026-10-12.
  it.each([
    ["the runner's own timeout", "gh could not list pull requests (timed out)"],
    [
      "gh, the resolver failing (measured)",
      "gh could not list pull requests (exit 1: error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com)",
    ],
    [
      "gh, the connection refused (measured)",
      'gh could not list pull requests (exit 1: Post "https://api.github.com/graphql": proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused)',
    ],
    ["Jira, no route (measured)", "Request to /rest/api/3/issue/SSX-1 failed: fetch failed"],
    [
      "Jira, its timeout (measured)",
      "Request to /rest/api/3/issue/SSX-1 failed: The operation was aborted due to timeout",
    ],
    [
      "git, the resolver failing (measured)",
      "fatal: unable to access 'https://github.com/o/r/': Could not resolve host: github.com",
    ],
    [
      "gh, the TLS handshake stalling (SSX-3895's record, 2026-10-01)",
      'gh could not read #1443 (exit 1: Post "https://api.github.com/graphql": net/http: TLS handshake timeout)',
    ],
    [
      "gh, GitHub's gateway giving up (SSX-4042's broadcast, 2026-10-12)",
      "gh could not list pull requests (exit 1: HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql))",
    ],
    [
      "gh, a bad gateway in the same format",
      "gh could not list pull requests (exit 1: HTTP 502: 502 Bad Gateway (https://api.github.com/graphql))",
    ],
    [
      "Jira, unavailable, `JiraError` quoting a body that names no status",
      "Jira returned 503: <!DOCTYPE html><html><head><title>Atlassian</title></head><body>Back soon</body></html>",
    ],
  ])("files %s as a network failure", (_source, reason) => {
    expect(reviewFailureEvent(reason)).toEqual({
      kind: "unreachable",
      where: "review",
      message: reason,
    });
  });

  it.each([
    "gh could not list pull requests (exit 1: HTTP 401: Bad credentials (https://api.github.com/graphql))",
    "Jira rejected the credentials (401). Check JIRA_EMAIL and JIRA_AUTH; API credentials are revoked when the account password changes.",
    "Jira returned 404: Issue does not exist",
    "Jira returned 500: Internal server error",
    "gh could not list pull requests (exit 1: HTTP 500: Something went wrong (https://api.github.com/graphql))",
    "gh could not list pull requests (exit 1: HTTP 403: API rate limit exceeded for user ID 1234567. (https://api.github.com/graphql))",
    "SSX-1's summary yields no usable branch name",
    "no pull request on fix/SSX-1-cache",
  ])("keeps %s a crash", (reason) => {
    expect(reviewFailureEvent(reason)).toEqual({
      kind: "crashed",
      where: "review",
      message: reason,
    });
  });
});

describe("prEndedEvent", () => {
  it("maps Jira's states to the record's", () => {
    expect(prEndedEvent("MERGED")).toEqual({ kind: "pr-ended", state: "merged" });
    expect(prEndedEvent("CLOSED")).toEqual({ kind: "pr-ended", state: "closed" });
  });
});
