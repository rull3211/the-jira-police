import { describe, expect, it } from "vitest";

import type { SolveMode } from "../settings.ts";
import {
  AGENT_LABELS,
  LabelStateError,
  SOLVE_QUEUE_EXCLUDED_LABELS,
  applyEdit,
  claimTransition,
  completionTransition,
  eligibility,
  isEligible,
  isTerminal,
  labelEdit,
  repoFromLabels,
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

  it("treats an unrecognised mode as manual rather than as auto", () => {
    // `solveMode` refuses such a value, so this can only arrive via a caller
    // that read the mode from somewhere else. It still must not skip the human.
    expect(isEligible([AGENT_LABELS.solvable], "Auto" as SolveMode)).toBe(false);
    expect(isEligible([AGENT_LABELS.solvable], "" as SolveMode)).toBe(false);
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

  it("blocks locally on agent:reviewing even though the query does not", () => {
    // The query gets away with omitting it only because a reviewing ticket
    // still carries the claim. This check does not depend on that holding.
    expect(SOLVE_QUEUE_EXCLUDED_LABELS).not.toContain(AGENT_LABELS.reviewing);
    expect(isEligible([...AUTHORISED, AGENT_LABELS.reviewing], "manual")).toBe(false);
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
  it("adds agent:reviewing while keeping the claim", () => {
    // Dropping agent:solving here would put a ticket with an open pull request
    // straight back into the queue to be solved a second time.
    const claimed = [AGENT_LABELS.solvable, AGENT_LABELS.solving];
    expect(reviewTransition(claimed)).toEqual({ add: [AGENT_LABELS.reviewing], remove: [] });
    expect(applyEdit(claimed, reviewTransition(claimed))).toContain(AGENT_LABELS.solving);
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
    for (const outcome of ["done", "failed"] as const) {
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
