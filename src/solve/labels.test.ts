import { describe, expect, it } from "vitest";

import {
  AGENT_LABELS,
  type ClaimAuthority,
  LabelStateError,
  SOLVE_QUEUE_EXCLUDED_LABELS,
  applyEdit,
  claimTransition,
  completionTransition,
  eligibility,
  isEligible,
  isNoopEdit,
  isTerminal,
  labelEdit,
  repoFromLabels,
  reviewStageTransition,
  reviewTransition,
} from "./labels.ts";

/** What a ticket looks like the moment a human has authorised a solve. */
const AUTHORISED = [AGENT_LABELS.solvable, AGENT_LABELS.start];

describe("eligibility", () => {
  it("accepts a solvable, started ticket in manual mode", () => {
    expect(eligibility(AUTHORISED, "manual")).toEqual({ eligible: true });
  });

  it("accepts a solvable ticket with no go-ahead in auto mode", () => {
    expect(eligibility([AGENT_LABELS.solvable], "auto")).toEqual({ eligible: true });
  });

  it("refuses a solvable ticket with no go-ahead in manual mode", () => {
    // The one human step in the feature. Without this the label triage sets
    // for itself would be enough to start a code change.
    const verdict = eligibility([AGENT_LABELS.solvable], "manual");
    expect(verdict.eligible).toBe(false);
    expect(verdict).toMatchObject({ reason: expect.stringContaining("agent:start") });
  });

  it("refuses a started ticket triage never marked solvable", () => {
    // `agent:start` on its own is a human pointing at a ticket nobody assessed.
    expect(isEligible([AGENT_LABELS.start], "manual")).toBe(false);
    expect(isEligible([AGENT_LABELS.start], "auto")).toBe(false);
  });

  it("refuses a ticket with no agent labels at all", () => {
    expect(isEligible([], "auto")).toBe(false);
    expect(isEligible(["bug", "dor:pass"], "auto")).toBe(false);
  });

  it("treats an unrecognised authority as manual rather than as auto", () => {
    // `solveMode` refuses such a value, so this can only arrive via a caller
    // that read the mode from somewhere else. It still must not skip the human.
    expect(isEligible([AGENT_LABELS.solvable], "Auto" as ClaimAuthority)).toBe(false);
    expect(isEligible([AGENT_LABELS.solvable], "" as ClaimAuthority)).toBe(false);
    expect(isEligible([AGENT_LABELS.solvable], "Named" as ClaimAuthority)).toBe(false);
  });

  describe("the named authority — an operator typed the key", () => {
    it("needs no agent:start, because the terminal is the authorisation", () => {
      expect(eligibility([AGENT_LABELS.solvable], "named")).toEqual({ eligible: true });
    });

    it("still refuses a ticket triage never marked solvable", () => {
      // The load-bearing half. Naming a ticket answers "may this run", which is
      // not "can an agent fix this" — and only triage has made that call. A
      // `named` authority that skipped this would make the whole fitness
      // assessment optional from the command line, which is where it is most
      // likely to be skipped and least likely to be noticed.
      const verdict = eligibility([AGENT_LABELS.start], "named");
      expect(verdict.eligible).toBe(false);
      expect(verdict).toMatchObject({ reason: expect.stringContaining("agent:solvable") });
    });

    it.each([AGENT_LABELS.solving, AGENT_LABELS.reviewing, AGENT_LABELS.done, AGENT_LABELS.failed])(
      "still refuses a ticket already carrying %s",
      (blocker) => {
        // Naming a ticket does not override the dedupe. Somebody else's claim
        // is not ceremony an operator gets to skip.
        expect(isEligible([AGENT_LABELS.solvable, blocker], "named")).toBe(false);
      },
    );

    it("consumes an agent:start that happens to be there", () => {
      // A human authorised it on the board, then somebody ran the command
      // instead of waiting for the poller. Leaving the label behind would hand
      // the queue a standing approval for work that has already been done.
      expect(claimTransition(AUTHORISED, "named").remove).toEqual([AGENT_LABELS.start]);
    });

    it("removes nothing when there was no standing approval to consume", () => {
      expect(claimTransition([AGENT_LABELS.solvable], "named").remove).toEqual([]);
    });
  });

  it.each([AGENT_LABELS.solving, AGENT_LABELS.reviewing, AGENT_LABELS.done, AGENT_LABELS.failed])(
    "refuses a ticket already carrying %s",
    (blocker) => {
      // This is the whole dedupe mechanism. There is no seenKeys list behind
      // this queue, so a ticket that reads as claimable twice is solved twice.
      expect(isEligible([...AUTHORISED, blocker], "manual")).toBe(false);
      expect(isEligible([AGENT_LABELS.solvable, blocker], "auto")).toBe(false);
    },
  );

  it("blocks on both review stages, which the query now also excludes", () => {
    // The assertion here used to be `not.toContain(AGENT_LABELS.reviewing)`,
    // because a reviewing ticket still carried the claim and the query got the
    // exclusion for free. D4 spent that, so the query has to name them and this
    // check has to agree with it — the two are one list now, and the test that
    // would catch them drifting apart is the one below.
    expect(SOLVE_QUEUE_EXCLUDED_LABELS).toContain(AGENT_LABELS.reviewing);
    expect(SOLVE_QUEUE_EXCLUDED_LABELS).toContain(AGENT_LABELS.reviewDone);
    expect(isEligible([...AUTHORISED, AGENT_LABELS.reviewing], "manual")).toBe(false);
    expect(isEligible([...AUTHORISED, AGENT_LABELS.reviewDone], "manual")).toBe(false);
  });

  it("refuses a claim on every label the queue query excludes", () => {
    // The local check is the one that decides; the query is an optimisation. So
    // anything the query filters must also be refused here, or a ticket arriving
    // from a retry, a CLI or a hand-written query walks straight past the guard.
    for (const blocker of SOLVE_QUEUE_EXCLUDED_LABELS) {
      expect(isEligible([...AUTHORISED, blocker], "manual")).toBe(false);
      expect(isEligible([AGENT_LABELS.solvable, blocker], "auto")).toBe(false);
    }
  });

  it("names every blocking label it found, not just the first", () => {
    const verdict = eligibility([...AUTHORISED, AGENT_LABELS.solving, AGENT_LABELS.done], "manual");
    expect(verdict).toMatchObject({
      reason: expect.stringContaining("agent:solving, agent:done"),
    });
  });
});

describe("claimTransition", () => {
  it("adds the claim and consumes the go-ahead in one edit", () => {
    // One edit, not two. Two writes leave a window in which a second instance
    // sees a ticket that is solvable, started and unclaimed.
    expect(claimTransition(AUTHORISED, "manual")).toEqual({
      add: [AGENT_LABELS.solving],
      remove: [AGENT_LABELS.start],
    });
  });

  it("removes agent:start, so a human's approval is single-use", () => {
    // Left behind, it would silently re-authorise the next solve of the same
    // ticket — a standing permission rather than an approval.
    expect(claimTransition(AUTHORISED, "manual").remove).toContain(AGENT_LABELS.start);
  });

  it("removes nothing in auto mode, where there was no go-ahead to consume", () => {
    expect(claimTransition([AGENT_LABELS.solvable], "auto")).toEqual({
      add: [AGENT_LABELS.solving],
      remove: [],
    });
  });

  it("leaves labels it does not own alone", () => {
    const claim = claimTransition([...AUTHORISED, "dor:pass", "Feil"], "manual");
    expect(applyEdit([...AUTHORISED, "dor:pass", "Feil"], claim)).toEqual([
      AGENT_LABELS.solvable,
      "dor:pass",
      "Feil",
      AGENT_LABELS.solving,
    ]);
  });

  it("refuses to claim a ticket that is not eligible", () => {
    // A caller that got the predicate wrong finds out while the ticket is
    // still untouched, rather than by writing a claim over someone else's.
    expect(() => claimTransition([AGENT_LABELS.solvable], "manual")).toThrow(LabelStateError);
    expect(() => claimTransition([...AUTHORISED, AGENT_LABELS.solving], "manual")).toThrow(
      /not eligible/,
    );
  });

  it("does not mutate the labels it was given", () => {
    const labels = [...AUTHORISED];
    claimTransition(labels, "manual");
    expect(labels).toEqual(AUTHORISED);
  });

  it("produces a claimed ticket the queue no longer selects", () => {
    // The round trip that makes the queue idempotent: apply the claim, and the
    // same ticket must now fail the same predicate.
    const after = applyEdit(AUTHORISED, claimTransition(AUTHORISED, "manual"));
    expect(isEligible(after, "manual")).toBe(false);
    expect(isEligible(after, "auto")).toBe(false);
    expect(() => claimTransition(after, "auto")).toThrow(LabelStateError);
  });
});

describe("reviewTransition", () => {
  it("hands the claim in, because the claim is a concurrency slot", () => {
    // This assertion was the exact opposite until D4, and the inversion is the
    // point of the phase: agent:solving is counted against MAX_CONCURRENT_SOLVES
    // by buildInFlightJql, so a ticket that kept it until merge would hold the
    // only slot for as long as a human took to review.
    const claimed = [AGENT_LABELS.solvable, AGENT_LABELS.solving];
    expect(reviewTransition(claimed)).toEqual({
      add: [AGENT_LABELS.reviewing],
      remove: [AGENT_LABELS.solving],
    });
    expect(applyEdit(claimed, reviewTransition(claimed))).not.toContain(AGENT_LABELS.solving);
  });

  it("frees the slot it was holding, which is the whole reason for the change", () => {
    // Read against buildInFlightJql, which counts agent:solving and nothing
    // else. Unplug the removal above and this fails with a queue that delivers
    // one pull request and then stops until somebody merges it.
    const claimed = [AGENT_LABELS.solvable, AGENT_LABELS.solving];
    const reviewing = applyEdit(claimed, reviewTransition(claimed));
    expect(reviewing).not.toContain(AGENT_LABELS.solving);
    expect(reviewing).toContain(AGENT_LABELS.reviewing);
  });

  it("keeps a reviewing ticket out of the queue in both modes", () => {
    const claimed = [AGENT_LABELS.solvable, AGENT_LABELS.solving];
    const reviewing = applyEdit(claimed, reviewTransition(claimed));
    expect(isEligible(reviewing, "manual")).toBe(false);
    expect(isEligible(reviewing, "auto")).toBe(false);
  });

  it("refuses to move to review without the claim", () => {
    expect(() => reviewTransition([AGENT_LABELS.solvable])).toThrow(LabelStateError);
  });
});

describe("reviewStageTransition", () => {
  const REVIEWING = [AGENT_LABELS.solvable, AGENT_LABELS.reviewing];
  const REVIEW_DONE = [AGENT_LABELS.solvable, AGENT_LABELS.reviewDone];

  it("swaps reviewing for review-done when a round undrafts", () => {
    expect(reviewStageTransition(REVIEWING, "review-done")).toEqual({
      add: [AGENT_LABELS.reviewDone],
      remove: [AGENT_LABELS.reviewing],
    });
  });

  it("swaps back when a later round pushes, because the arrow goes both ways", () => {
    // Undrafting is a transition, not an ending. While a round is pushing, "only
    // human approval is left" is false, and the label has to say so.
    expect(reviewStageTransition(REVIEW_DONE, "reviewing")).toEqual({
      add: [AGENT_LABELS.reviewing],
      remove: [AGENT_LABELS.reviewDone],
    });
  });

  it("asks for no write when the ticket is already in the stage", () => {
    // The advance step runs on a timer and most rounds change neither the pull
    // request's draft status nor this label. A non-empty edit here would be a
    // Jira write per tick per ticket under review, forever.
    expect(isNoopEdit(reviewStageTransition(REVIEWING, "reviewing"))).toBe(true);
    expect(isNoopEdit(reviewStageTransition(REVIEW_DONE, "review-done"))).toBe(true);
  });

  it("reports a real move as a write worth making", () => {
    // The other half of the assertion above: isNoopEdit must distinguish, not
    // just return true. Unplug the comparison in reviewStageTransition and one
    // of these two tests fails whichever way it is broken.
    expect(isNoopEdit(reviewStageTransition(REVIEWING, "review-done"))).toBe(false);
    expect(isNoopEdit(reviewStageTransition(REVIEW_DONE, "reviewing"))).toBe(false);
  });

  it("refuses a ticket that is under review in neither sense", () => {
    // The stage comes from a pull request; whether the ticket is still under
    // review is a fact about the board, and a person can have moved it between
    // the two reads. Writing agent:reviewing onto a finished ticket would
    // resurrect it into a state the queue excludes and nothing else clears.
    expect(() => reviewStageTransition([AGENT_LABELS.solvable], "reviewing")).toThrow(
      LabelStateError,
    );
    expect(() =>
      reviewStageTransition([AGENT_LABELS.solvable, AGENT_LABELS.done], "review-done"),
    ).toThrow(LabelStateError);
  });

  it("refuses a ticket still on the claim, so the phases cannot be skipped", () => {
    // agent:solving to agent:review-done is not a transition this machine has.
    // reviewTransition is how a ticket enters the review phase, and it is the
    // one that checks the claim.
    expect(() =>
      reviewStageTransition([AGENT_LABELS.solvable, AGENT_LABELS.solving], "review-done"),
    ).toThrow(LabelStateError);
  });

  it("keeps a ticket out of the queue in either stage", () => {
    for (const labels of [REVIEWING, REVIEW_DONE]) {
      expect(isEligible(labels, "manual")).toBe(false);
      expect(isEligible(labels, "auto")).toBe(false);
    }
  });
});

describe("completionTransition", () => {
  const REVIEWING = [AGENT_LABELS.solvable, AGENT_LABELS.solving, AGENT_LABELS.reviewing];

  it("clears both lifecycle labels and records the outcome", () => {
    expect(completionTransition(REVIEWING, "done")).toEqual({
      add: [AGENT_LABELS.done],
      remove: [AGENT_LABELS.solving, AGENT_LABELS.reviewing],
    });
  });

  it("records a failure the same way", () => {
    expect(completionTransition(REVIEWING, "failed").add).toEqual([AGENT_LABELS.failed]);
  });

  it("gives a closed pull request its own label, not agent:done", () => {
    // This is the mutation guarding a number rather than a behaviour, and it is
    // the only one here whose absence shows up as a plausible-looking figure in
    // a report instead of as a malfunction. agent:done is the count of bugs this
    // tool fixed; a pull request a person closed unmerged is not one.
    expect(completionTransition(REVIEWING, "closed").add).toEqual([AGENT_LABELS.closed]);
    expect(applyEdit(REVIEWING, completionTransition(REVIEWING, "closed"))).not.toContain(
      AGENT_LABELS.done,
    );
  });

  it("sweeps agent:review-done, which is where a finished pull request waits", () => {
    // The state a merge is overwhelmingly likely to arrive from — the loop
    // undrafted, a human read it, a human merged it. Leaving it behind would
    // mark a ticket done while it still claimed to be awaiting approval.
    const waiting = [AGENT_LABELS.solvable, AGENT_LABELS.reviewDone];
    expect(completionTransition(waiting, "done")).toEqual({
      add: [AGENT_LABELS.done],
      remove: [AGENT_LABELS.reviewDone],
    });
  });

  it("works from agent:solving alone, for a solve that bailed before opening a PR", () => {
    // Recon can conclude triage was wrong about the ticket, which is a
    // legitimate ending and not an error.
    expect(completionTransition([AGENT_LABELS.solvable, AGENT_LABELS.solving], "failed")).toEqual({
      add: [AGENT_LABELS.failed],
      remove: [AGENT_LABELS.solving],
    });
  });

  it("keeps agent:solvable, so the assessment can be marked right or wrong later", () => {
    const after = applyEdit(REVIEWING, completionTransition(REVIEWING, "failed"));
    expect(after).toContain(AGENT_LABELS.solvable);
  });

  it("leaves a terminal ticket the queue will never pick up again", () => {
    for (const outcome of ["done", "closed", "failed"] as const) {
      const after = applyEdit(REVIEWING, completionTransition(REVIEWING, outcome));
      expect(isTerminal(after)).toBe(true);
      expect(isEligible(after, "auto")).toBe(false);
    }
  });
});

describe("labelEdit", () => {
  it("refuses an edit that both adds and removes the same label", () => {
    // Jira does not define whether the union or the subtraction wins, so such
    // an edit has two possible outcomes and no way to say which was meant —
    // and the queue's idempotency rests on reading back the state the last
    // edit intended.
    expect(() => labelEdit([AGENT_LABELS.solving], [AGENT_LABELS.solving])).toThrow(
      LabelStateError,
    );
  });

  it("names every contradicting label", () => {
    expect(() => labelEdit(["a", "b"], ["a", "b"])).toThrow(/adds and removes a, b/);
  });

  it("allows an edit whose halves are disjoint", () => {
    expect(labelEdit(["a"], ["b"])).toEqual({ add: ["a"], remove: ["b"] });
  });
});

describe("applyEdit", () => {
  it("adds, removes and does not duplicate", () => {
    expect(applyEdit(["a", "b"], { add: ["b", "c"], remove: ["a"] })).toEqual(["b", "c"]);
  });

  it("does not mutate its input", () => {
    const labels = ["a"];
    applyEdit(labels, { add: ["b"], remove: ["a"] });
    expect(labels).toEqual(["a"]);
  });
});

describe("isTerminal", () => {
  it("is true only once the machine has stopped", () => {
    expect(isTerminal([AGENT_LABELS.solvable, AGENT_LABELS.solving])).toBe(false);
    expect(isTerminal([AGENT_LABELS.done])).toBe(true);
    expect(isTerminal([AGENT_LABELS.failed])).toBe(true);
  });

  it("counts a pull request somebody closed, which is over without being done", () => {
    // agent:closed asks a different question from agent:done and gets the same
    // answer here. "Did the tool fix a bug" is no; "is there anything left to
    // do" is also no, and this function is the second question.
    expect(isTerminal([AGENT_LABELS.closed])).toBe(true);
  });

  it("does not treat a ticket waiting on a human as finished", () => {
    // agent:review-done is the closest thing to an ending that is not one: the
    // loop is still listening, and a human review can still send it back to
    // agent:reviewing. Reading it as terminal would stop the advance step.
    expect(isTerminal([AGENT_LABELS.solvable, AGENT_LABELS.reviewDone])).toBe(false);
  });
});

/**
 * `svc:<repo>` is not this feature's label. It is an existing board convention
 * written by triage (`INTAKE_INSTRUCTIONS.md:359`) and only read here, which is
 * why the solve queue needs no private channel to learn where a fix would go —
 * SSX-3822 already carries `svc:buy-insurance-advisor-web`.
 *
 * It also means the value comes from text a stranger can edit, so every
 * ambiguous reading resolves to `null` and the allowlist decides from there.
 */
describe("repoFromLabels", () => {
  const REPO = "buy-insurance-advisor-web";

  it("reads the repository from the label the board actually carries", () => {
    // Copied verbatim from groomed/SSX-3822.md rather than invented, so the
    // fixture cannot agree with the code while disagreeing with Jira.
    const live = [
      "triaged",
      "route:ours",
      "team:ssx",
      "jira:SSX",
      "domain:insurance",
      `svc:${REPO}`,
      "tier:leaf",
      "dup:none",
      "dor:pass",
      "value:med",
      "effort:S",
      "intake:pm-screened",
      "next:to-trio",
    ];

    expect(repoFromLabels(live)).toBe(REPO);
  });

  it("returns null when no svc: label is present", () => {
    expect(repoFromLabels([AGENT_LABELS.solvable, "dor:pass"])).toBeNull();
  });

  it("returns null rather than picking one of two", () => {
    // A contradiction is not a decision. Taking the first would invent one, and
    // this value chooses which repository gets written to.
    expect(repoFromLabels([`svc:${REPO}`, "svc:some-other-repo"])).toBeNull();
  });

  it("returns null when triage said it could not tell", () => {
    // impl-uncertain is the documented alternative to svc:, so a ticket
    // carrying both is in a state the convention does not describe.
    expect(repoFromLabels([`svc:${REPO}`, "impl-uncertain"])).toBeNull();
    expect(repoFromLabels(["impl-uncertain"])).toBeNull();
  });

  it("returns null for an empty or blank repository name", () => {
    expect(repoFromLabels(["svc:"])).toBeNull();
    expect(repoFromLabels(["svc:   "])).toBeNull();
  });

  it.each(["../../etc/passwd", "a/b", "..", "repo name", "repo;rm -rf /", "$(whoami)"])(
    "refuses %j, which Phase C would turn into a worktree path",
    (name) => {
      expect(repoFromLabels([`svc:${name}`])).toBeNull();
    },
  );

  it("accepts the punctuation real repository names use", () => {
    expect(repoFromLabels(["svc:my-repo_v2.0"])).toBe("my-repo_v2.0");
  });

  it("does not confuse a label that merely contains svc:", () => {
    expect(repoFromLabels(["domain:svc:thing"])).toBeNull();
  });
});
