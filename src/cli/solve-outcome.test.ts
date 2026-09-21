import { describe, expect, it } from "vitest";

import type { AdvanceOutcome } from "../solve/delivery.ts";
import type { SolveOutcome } from "../solve/orchestrator.ts";
import type { FixReport } from "../solve/runner.ts";
import type { ReviewCycleOutcome } from "../solve/review-cycle.ts";
import {
  chainDecision,
  completionLabelFor,
  describeAdvanceOutcome,
  describeReviewSweep,
  describeSolveOutcome,
  endedState,
  isAdvanceFailureExit,
  isFailureExit,
  reportsToTicket,
  reviewStageAfter,
  terminalLabelAfter,
} from "./solve-outcome.ts";

const worktree = {
  issueKey: "SSX-3822",
  branch: "fix/ssx-3822-favicon",
  path: "/tmp/solve/SSX-3822",
  repoPath: "/repos/buy-insurance-advisor-web",
};

const lens = { accurate: true, correction: "" };

/** Carried by `failed` as well as `verified`, so `residualRisk` reaches the reader of a red run. */
const FIX_REPORT: FixReport = {
  changed: true,
  filesTouched: ["src/app/head.tsx"],
  summary: "point the favicon at the nonprod asset",
  commitSubject: "fix(advisor): point the favicon at the nonprod asset",
  commitBody: "The head tag named the production file in every environment.",
  testAdded: true,
  testOmittedReason: "",
  residualRisk: "",
  abandoned: "",
  abandonedCause: "none",
};

/** The one outcome that carries every pass's report, so it is built once. */
const verified = {
  kind: "verified",
  files: 1,
  lines: 4,
  commit: { subject: "fix(advisor): add missing favicon link" },
  recon: {},
  fix: {},
  simplify: {},
  verification: {},
  devLens: lens,
  worktree,
} as unknown as SolveOutcome;

/**
 * Every solve outcome kind there is, checked by the compiler.
 *
 * A `Record` over the union makes adding a kind without adding it here a type error, and the
 * fixture is compared to these keys at runtime.
 */
const SOLVE_KINDS: Record<SolveOutcome["kind"], null> = {
  "no-worktree": null,
  bailed: null,
  abandoned: null,
  refused: null,
  escaped: null,
  failed: null,
  crashed: null,
  "unusable-base": null,
  verified: null,
};

/** One of every kind, so the exhaustiveness claims below are about all of them. */
const OUTCOMES: readonly SolveOutcome[] = [
  { kind: "no-worktree", reason: "the summary yields no usable fix/ branch name" },
  {
    kind: "bailed",
    reason: "the described file does not exist",
    devLens: lens,
    worktree,
    recon: {} as never,
    cleanup: { outcome: "removed", path: worktree.path, branch: { outcome: "deleted" } },
  },
  {
    kind: "abandoned",
    reason: "the fix is larger than the ticket describes",
    cause: "judgement",
    devLens: lens,
    worktree,
  },
  {
    kind: "abandoned",
    reason: "a safety hook denied the write",
    cause: "environment",
    devLens: lens,
    worktree,
  },
  {
    kind: "refused",
    stage: "verification",
    reasons: ["no test script"],
    devLens: lens,
    worktree,
  },
  {
    kind: "escaped",
    paths: ["/git/commerce-rest-api"],
    would: "verified",
    worktree,
  },
  {
    kind: "failed",
    reason: "2 tests failed",
    fix: FIX_REPORT,
    verification: {} as never,
    devLens: lens,
    worktree,
  },
  { kind: "crashed", pass: "fix", reason: "pass timed out after 900000ms", worktree },
  {
    kind: "unusable-base",
    reason: "the repository's own build does not pass in a fresh worktree",
    verification: {} as never,
    worktree,
  },
  verified,
];

/**
 * A key for the exhaustiveness table, which is `kind` except for `abandoned`.
 *
 * `environment` and `judgement` causes disagree on exit code, so folding them under one key
 * would let one silently stand in for both.
 */
function exitKey(outcome: SolveOutcome): string {
  return outcome.kind === "abandoned" ? `abandoned:${outcome.cause}` : outcome.kind;
}

describe("the solve-outcome fixture", () => {
  it("has an example of every kind the type admits", () => {
    // The keys come from the compiler, not a literal — every "covers every outcome kind" claim
    // in this file depends on this assertion.
    const present = new Set(OUTCOMES.map((outcome) => outcome.kind));
    expect([...present].toSorted()).toEqual(Object.keys(SOLVE_KINDS).toSorted());
  });
});

describe("isFailureExit", () => {
  it("does not fail the shell on a bail", () => {
    // A bail is the pipeline working, not a failure — a non-zero code here would teach a backoff
    // to read success as error.
    expect(
      isFailureExit({
        kind: "bailed",
        reason: "the described file does not exist",
        devLens: lens,
        worktree,
        recon: {} as never,
        cleanup: { outcome: "removed", path: worktree.path, branch: { outcome: "deleted" } },
      }),
    ).toBe(false);
  });

  it("fails the shell on a crash", () => {
    // The rule is not "was the code bad" but "did this run produce a usable answer" — a dead
    // pass did not, at full cost.
    expect(
      isFailureExit({ kind: "crashed", pass: "recon", reason: "pass timed out", worktree }),
    ).toBe(true);
  });

  it("agrees with itself across every outcome kind", () => {
    // Pinned as a whole so a new kind forces a decision here rather than silently defaulting to zero.
    expect(Object.fromEntries(OUTCOMES.map((o) => [exitKey(o), isFailureExit(o)]))).toEqual({
      "no-worktree": true,
      bailed: false,
      "abandoned:judgement": false,
      "abandoned:environment": true,
      refused: true,
      escaped: true,
      failed: true,
      crashed: true,
      "unusable-base": true,
      verified: false,
    });
  });

  it("fails the shell on an unusable base, cheap though it is", () => {
    // Nothing was spent, but the rule is "did this produce a usable answer" — an operator seeing
    // zero here would re-run and get the same nothing.
    expect(
      isFailureExit({
        kind: "unusable-base",
        reason: "the build fails before any change",
        verification: {} as never,
        worktree,
      }),
    ).toBe(true);
  });

  it("does not fail the shell when a pass read the code and declined", () => {
    // Same argument as `bailed`: a verdict is an answer, and answering "no" is
    // the pipeline working.
    expect(
      isFailureExit({
        kind: "abandoned",
        reason: "the fix needs a schema migration",
        cause: "judgement",
        devLens: lens,
        worktree,
      }),
    ).toBe(false);
  });

  it("fails the shell when the machine got in the way", () => {
    // A safety hook denying a write mid-pass is why the cause exists — reporting it as a clean
    // exit would file a working ticket as one an agent declined.
    expect(
      isFailureExit({
        kind: "abandoned",
        reason: "a safety hook denied the write",
        cause: "environment",
        devLens: lens,
        worktree,
      }),
    ).toBe(true);
  });
});

describe("describeSolveOutcome", () => {
  it("says something for every kind", () => {
    for (const outcome of OUTCOMES) {
      expect(describeSolveOutcome(outcome)).not.toBe("");
    }
  });

  it("tells an operator which kind of abandon they are looking at", () => {
    // The next command differs: `judgement` means review whether the ticket was misjudged,
    // `environment` means find out what stopped the machine and re-run.
    const machine = describeSolveOutcome({
      kind: "abandoned",
      reason: "a safety hook denied the write",
      cause: "environment",
      devLens: lens,
      worktree,
    });
    const verdict = describeSolveOutcome({
      kind: "abandoned",
      reason: "the fix needs a schema migration",
      cause: "judgement",
      devLens: lens,
      worktree,
    });

    expect(machine).toContain("says nothing about the ticket");
    expect(verdict).toContain("read the code and declined");
    expect(verdict).not.toContain("says nothing about the ticket");
  });

  it("does not let a crash read as a statement about the code", () => {
    const line = describeSolveOutcome({
      kind: "crashed",
      pass: "fix",
      reason: "pass timed out after 900000ms",
      worktree,
    });

    expect(line).toContain("CRASHED");
    expect(line).toContain("no verdict was reached");
    // `FAILED` means the repository's own checks rejected the change — nothing a crashed run
    // ever established.
    expect(line).not.toContain("FAILED");
    expect(line).not.toContain("VERIFIED");
  });

  it("names the pass that died, since that is what decides the next command", () => {
    // A crash in recon and a crash in review are the same outcome and entirely
    // different problems — one wasted a read-only pass, the other left a pull
    // request waiting on an answer.
    expect(
      describeSolveOutcome({ kind: "crashed", pass: "review", reason: "timed out", worktree }),
    ).toContain("review");
  });

  it("points at the kept worktree on every outcome that keeps one", () => {
    // `bailed` is excluded because it removes its own worktree, and `no-worktree` never had one.
    const keeps = OUTCOMES.filter((o) => o.kind !== "no-worktree" && o.kind !== "bailed");
    expect(keeps.length).toBeGreaterThan(3);
    for (const outcome of keeps) {
      expect(describeSolveOutcome(outcome)).toContain(worktree.path);
    }
  });

  it("does not send an operator to a worktree it just deleted", () => {
    // A bail removes its own worktree; printing the path anyway would send someone to an empty
    // directory.
    const line = describeSolveOutcome({
      kind: "bailed",
      reason: "the described file does not exist",
      devLens: lens,
      worktree,
      recon: {} as never,
      cleanup: { outcome: "removed", path: worktree.path, branch: { outcome: "deleted" } },
    });

    expect(line).toContain("Worktree removed");
    expect(line).not.toContain(worktree.path);
  });

  it("warns that the kept worktree is kept, not held", () => {
    // The next run for this ticket salvages the directory to a `-salvaged-<timestamp>` sibling
    // and puts a fresh checkout at the same path — it can be renamed out from under you mid-command.
    const line = describeSolveOutcome({
      kind: "unusable-base",
      reason: "the repository's own build does not pass in a fresh worktree",
      verification: {} as never,
      worktree,
    });

    expect(line).toContain(worktree.path);
    expect(line).toContain("salvaged");
    expect(line).toContain("stop the daemon");
  });

  it("still points at the worktree when git refused to remove it", () => {
    // `removeWorktree` does not force, so a dirty worktree on a bail is kept — exactly the case
    // an operator needs the path for.
    const line = describeSolveOutcome({
      kind: "bailed",
      reason: "the described file does not exist",
      devLens: lens,
      worktree,
      recon: {} as never,
      cleanup: {
        outcome: "kept",
        path: worktree.path,
        reason: "git would not remove it (exit 1) — not forced",
      },
    });

    expect(line).toContain(worktree.path);
    expect(line).toContain("not forced");
  });

  it("says plainly that a verified run pushed nothing", () => {
    // The outcome most likely to be skimmed as "done". Nothing left the machine.
    const line = describeSolveOutcome(verified);

    expect(line).toContain("Nothing was pushed");
    expect(line).toContain(worktree.branch);
  });
});

/** The common case: no inline threads, so nothing to post and nothing to fail. */
const NO_THREADS = { answered: 0, resolved: 0, failures: [] } as const;

/**
 * Every review-round kind there is, checked by the compiler.
 *
 * A `Record` over the union makes adding or removing a kind a type error, and the fixture below
 * is pinned against these keys at runtime.
 */
const ADVANCE_KINDS: Record<AdvanceOutcome["kind"], null> = {
  waiting: null,
  ready: null,
  iterated: null,
  "reviewer-exhausted": null,
  capped: null,
  stalled: null,
  abandoned: null,
  refused: null,
  failed: null,
  synced: null,
};

/** One of every review-round kind, so the tables below are about all of them. */
const ADVANCE_OUTCOMES: readonly AdvanceOutcome[] = [
  { kind: "waiting", quietMs: 60_000 },
  { kind: "ready", rounds: 2 },
  {
    kind: "iterated",
    round: 1,
    responses: ["renamed the helper"],
    reviewerRequested: "asked",
    pushed: true,
    spoken: { outcome: "posted" },
    undrafted: "still-drafting",
    threads: NO_THREADS,
    unresolved: "",
  },
  {
    kind: "iterated",
    round: 2,
    responses: ["answered in a comment"],
    reviewerRequested: "failed",
    pushed: false,
    spoken: { outcome: "posted" },
    undrafted: "undrafted",
    threads: NO_THREADS,
    unresolved: "",
  },
  { kind: "reviewer-exhausted", rounds: 3, unresolved: "this still allocates on every render" },
  { kind: "capped", rounds: 20, unresolved: "the reviewer and the pass disagree about the type" },
  {
    kind: "stalled",
    attempts: 3,
    reason: "the worktree at /tmp/solve/SSX-3822 has uncommitted changes",
  },
  { kind: "abandoned", reason: "the reviewer is asking for a schema change" },
  { kind: "refused", stage: "diff-gate", reasons: ["lockfile touched"] },
  { kind: "failed", stage: "push", reason: "the remote rejected the push" },
  { kind: "synced", round: 4, behind: 7, conflicts: ["src/utils/DateUtils.ts"] },
];

describe("the review-round fixture", () => {
  it("has an example of every kind the type admits", () => {
    // Without this, the fixture is a list somebody wrote once, and a kind added later is
    // silently untested by every table that claims to cover everything.
    const present = new Set(ADVANCE_OUTCOMES.map((outcome) => outcome.kind));
    expect([...present].toSorted()).toEqual(Object.keys(ADVANCE_KINDS).toSorted());
  });
});

/** The two `iterated` shapes above, by the only field this mapping reads. */
const ITERATED_DRAFTING = ADVANCE_OUTCOMES[2] as Extract<AdvanceOutcome, { kind: "iterated" }>;
const ITERATED_UNDRAFTED = ADVANCE_OUTCOMES[3] as Extract<AdvanceOutcome, { kind: "iterated" }>;

describe("reviewStageAfter", () => {
  it("writes review-done only for a round that took the pull request out of draft", () => {
    expect(reviewStageAfter({ kind: "ready", rounds: 2 })).toBe("review-done");
    expect(reviewStageAfter(ITERATED_UNDRAFTED)).toBe("review-done");
  });

  it("keeps a pushing round on agent:reviewing, because it is still working", () => {
    // The label mirrors the draft flag, and a round that pushed stays a draft.
    expect(reviewStageAfter(ITERATED_DRAFTING)).toBe("reviewing");
  });

  it("says reviewing when the undraft failed, which is the truth about the PR", () => {
    // Not pessimism: the pull request really is still a draft, and claiming otherwise would send
    // a human to review something its own flag says is unfinished.
    expect(reviewStageAfter({ ...ITERATED_UNDRAFTED, undrafted: "failed" })).toBe("reviewing");
  });

  it("undrafts the ticket when the reviewer's budget runs out", () => {
    // `exhausted` undrafts the pull request, reaching the same label by a different road — that
    // the loop gave up rather than agreed is recorded in the ticket comment, not this label.
    expect(
      reviewStageAfter({ kind: "reviewer-exhausted", rounds: 3, unresolved: "still slow" }),
    ).toBe("review-done");
  });

  it("writes nothing while the reviewer has said nothing", () => {
    // Once the advance step runs on a timer this is the outcome of almost every tick, so a stage
    // here would be a Jira write per tick per pull request under review, forever.
    expect(reviewStageAfter({ kind: "waiting", quietMs: 60_000 })).toBe(null);
  });

  it("leaves the label alone for every round that left the draft flag alone", () => {
    // `capped`, `abandoned`, `refused` and the error kinds deliberately leave the pull request as
    // found; labelling after changing nothing overrides an earlier, better-informed decision.
    expect(reviewStageAfter({ kind: "capped", rounds: 20, unresolved: "" })).toBe(null);
    expect(reviewStageAfter({ kind: "abandoned", reason: "needs a migration" })).toBe(null);
    expect(reviewStageAfter({ kind: "refused", stage: "diff-gate", reasons: ["lockfile"] })).toBe(
      null,
    );
    expect(reviewStageAfter({ kind: "failed", stage: "push", reason: "rejected" })).toBe(null);
  });

  it("agrees with itself across every review-round kind", () => {
    // Pinned whole so a new outcome forces a decision rather than silently defaulting to null.
    const table = ADVANCE_OUTCOMES.map((outcome) => [outcome.kind, reviewStageAfter(outcome)]);
    expect(table).toEqual([
      ["waiting", null],
      ["ready", "review-done"],
      ["iterated", "reviewing"],
      ["iterated", "review-done"],
      ["reviewer-exhausted", "review-done"],
      ["capped", null],
      // A stall never reached the checkout, so it has no opinion about whether the pull request
      // is finished; `review-done` here would falsely tell a board the cycle ended well.
      ["stalled", null],
      ["abandoned", null],
      ["refused", null],
      ["failed", null],
      // A merge round touches the branch, not the pull request, so the draft flag — and this
      // label — must not move, even though the round did work.
      ["synced", null],
    ]);
  });
});

describe("isAdvanceFailureExit", () => {
  it("does not fail the shell while the reviewer has said nothing", () => {
    // Most ticks find no new comment; a non-zero code here would make an idle loop
    // indistinguishable from a broken one to a daemon's backoff.
    expect(isAdvanceFailureExit({ kind: "waiting", quietMs: 60_000 })).toBe(false);
  });

  it("does not fail the shell when a pass read the review and declined", () => {
    // Same rule as the solve side. Declining is an answer, and a human taking
    // the pull request from here is an outcome this is built to reach.
    expect(isAdvanceFailureExit({ kind: "abandoned", reason: "needs a migration" })).toBe(false);
  });

  it("does not fail the shell when the round cap fires", () => {
    // The cap working is not the command failing. What it owes the operator is
    // the line saying so, which `describeAdvanceOutcome` is tested for below.
    expect(
      isAdvanceFailureExit({ kind: "reviewer-exhausted", rounds: 3, unresolved: "still slow" }),
    ).toBe(false);
  });

  it("agrees with itself across every review-round kind", () => {
    // Pinned whole so a new outcome forces a decision rather than silently defaulting to zero.
    const table = ADVANCE_OUTCOMES.map((outcome) => [outcome.kind, isAdvanceFailureExit(outcome)]);
    expect(Object.fromEntries(table)).toEqual({
      waiting: false,
      ready: false,
      iterated: false,
      "reviewer-exhausted": false,
      capped: false,
      // Counter-intuitive: the attempts that produced a stall each exited non-zero already, so a
      // non-zero code here would retry a pull request just declared not worth retrying.
      stalled: false,
      abandoned: false,
      refused: true,
      failed: true,
      // A merge round reaching this outcome did what it set out to do — failures on that path
      // are `failed`/`merge` and `refused`, already non-zero above.
      synced: false,
    });
  });
});

/** Twenty minutes, the `REVIEW_SILENCE_MS` default, so the tables read as production would. */
const SILENCE_MS = 1_200_000;

describe("chainDecision", () => {
  it("keeps going only while the reviewer is still in the conversation", () => {
    // The direction matters: an untaught outcome must stop the chain, not join it — `--review`
    // runs unattended, so defaulting to `continue` is a new way to spend money.
    const table = ADVANCE_OUTCOMES.map((outcome) => [
      outcome.kind,
      chainDecision(outcome, SILENCE_MS).stop,
    ]);
    expect(table).toEqual([
      ["waiting", false],
      ["ready", true],
      ["iterated", false],
      ["iterated", true],
      ["reviewer-exhausted", true],
      ["capped", true],
      ["stalled", true],
      ["abandoned", true],
      ["refused", true],
      ["failed", true],
      // The merge answered the base, not the review — stopping here would end the chain one
      // round before the round that reads the still-waiting feedback.
      ["synced", false],
    ]);
  });

  it("ends the chain on the round that hands the pull request to a human", () => {
    // Undrafting means this side has finished (§6.1c); watching afterward is right for a daemon
    // but would hold a foreground command's terminal open for as long as a review takes.
    expect(chainDecision(ITERATED_UNDRAFTED, SILENCE_MS).stop).toBe(true);
    expect(chainDecision(ITERATED_DRAFTING, SILENCE_MS).stop).toBe(false);
  });

  it("counts a silence only when the reviewer has actually said nothing", () => {
    // `silent` is deliberately not `!stop` — a round that ran and pushed is the loop working, and
    // folding it in would trip the absent-reviewer brake on productive work.
    const silent = ADVANCE_OUTCOMES.filter((outcome) => chainDecision(outcome, SILENCE_MS).silent);
    expect(silent.map((outcome) => outcome.kind)).toEqual(["waiting"]);
  });

  it("names a reason for every kind, because the operator is watching this one", () => {
    for (const outcome of ADVANCE_OUTCOMES) {
      expect(chainDecision(outcome, SILENCE_MS).why).not.toBe("");
    }
  });

  it("stops once the pull request has been quiet for longer than the bound", () => {
    // A duration read off the pull request, so it means the same number of minutes whatever
    // `REVIEW_POLL_MS` is — without it, this is the one loop that polls forever unwatched.
    const decision = chainDecision({ kind: "waiting", quietMs: SILENCE_MS }, SILENCE_MS);

    expect(decision.stop).toBe(true);
    expect(decision.silent).toBe(true);
    expect(decision.why).toContain("20 minutes");
  });

  it("keeps waiting while the pull request is still fresh", () => {
    expect(chainDecision({ kind: "waiting", quietMs: SILENCE_MS - 1 }, SILENCE_MS).stop).toBe(
      false,
    );
  });

  it("keeps waiting when it could not measure how quiet the pull request is", () => {
    // `null` means "cannot be answered from this payload" — stopping here would end a live pull
    // request on a parse failure, unrecoverable in the direction that matters.
    expect(chainDecision({ kind: "waiting", quietMs: null }, 0).stop).toBe(false);
  });

  it("distinguishes the two caps in the sentence it prints", () => {
    // The two stop the chain identically but mean opposite things: one is a policy on how much
    // argument a bot reviewer is worth, the other a brake on the machinery.
    const budget = chainDecision(
      { kind: "reviewer-exhausted", rounds: 3, unresolved: "" },
      SILENCE_MS,
    ).why;
    const brake = chainDecision({ kind: "capped", rounds: 20, unresolved: "" }, SILENCE_MS).why;

    expect(budget).toContain("budget");
    expect(brake).toContain("MAX_PR_ROUNDS_TOTAL");
    expect(brake).toContain("draft");
  });
});

describe("describeAdvanceOutcome", () => {
  it("says something for every kind", () => {
    for (const outcome of ADVANCE_OUTCOMES) {
      expect(describeAdvanceOutcome(outcome)).not.toBe("");
    }
  });

  it("does not let a refusal read like a round that ran", () => {
    const text = describeAdvanceOutcome({
      kind: "refused",
      stage: "diff-gate",
      reasons: ["lockfile touched"],
    });
    expect(text).toContain("REFUSED");
    expect(text).toContain("Nothing was pushed");
  });

  it("does not let a merge round read like a round that answered the reviewer", () => {
    // A merge round costs money and pushes a commit like any other, but it never read the review
    // — mistaking it for one would read the reviewer's silence as agreement never given.
    const clean = describeAdvanceOutcome({ kind: "synced", round: 3, behind: 7, conflicts: [] });
    expect(clean).toContain("SYNCED");
    expect(clean).toContain("7 commit(s)");
    expect(clean).toContain("The review was not read this round");

    // And the conflicted case names the files, because a merge the bot resolved
    // by itself is the one commit on that branch a human should read.
    const resolved = describeAdvanceOutcome({
      kind: "synced",
      round: 3,
      behind: 7,
      conflicts: ["src/utils/DateUtils.ts"],
    });
    expect(resolved).toContain("src/utils/DateUtils.ts");
  });

  it("says out loud when the reviewer was not asked to look again", () => {
    // The failure is silent: code pushed, nobody reads it because the notification never went
    // out. Recovery is one button, so the operator must be told.
    const text = describeAdvanceOutcome({
      kind: "iterated",
      round: 2,
      responses: ["fixed"],
      pushed: true,
      spoken: { outcome: "posted" },
      undrafted: "still-drafting",
      reviewerRequested: "failed",
      threads: NO_THREADS,
      unresolved: "",
    });
    expect(text).toContain("NOT");
    expect(text).toContain("add them by hand");
  });

  it("does not print that warning when the reviewer was asked", () => {
    const text = describeAdvanceOutcome({
      kind: "iterated",
      round: 2,
      responses: ["fixed"],
      pushed: true,
      spoken: { outcome: "posted" },
      undrafted: "still-drafting",
      reviewerRequested: "asked",
      threads: NO_THREADS,
      unresolved: "",
    });
    expect(text).not.toContain("NOT");
    expect(text).toContain("asked to look again");
  });

  it("prints what a successful round could not settle", () => {
    const text = describeAdvanceOutcome({
      kind: "iterated",
      round: 2,
      responses: ["fixed"],
      pushed: true,
      spoken: { outcome: "posted" },
      undrafted: "still-drafting",
      reviewerRequested: "asked",
      threads: NO_THREADS,
      unresolved: "the second point needs a product decision",
    });

    expect(text).toContain("Unresolved:");
    expect(text).toContain("needs a product decision");
  });

  it("says nothing about unresolved when the round settled everything", () => {
    const text = describeAdvanceOutcome({
      kind: "iterated",
      round: 2,
      responses: ["fixed"],
      pushed: true,
      spoken: { outcome: "posted" },
      undrafted: "still-drafting",
      reviewerRequested: "asked",
      threads: NO_THREADS,
      unresolved: "",
    });

    // The common case, and a bare "Unresolved:" heading over nothing trains a
    // reader to skip the line on the round where it matters.
    expect(text).not.toContain("Unresolved");
  });

  it("does not claim a push on a round that only answered", () => {
    // An operator who goes looking for a commit that was never pushed has no way to tell which
    // half of the headline is wrong.
    const text = describeAdvanceOutcome({
      kind: "iterated",
      round: 2,
      responses: ["checked the claim; the premise does not hold"],
      pushed: false,
      spoken: { outcome: "posted" },
      undrafted: "undrafted",
      reviewerRequested: "asked",
      threads: NO_THREADS,
      unresolved: "",
    });

    expect(text).not.toContain("round 2 pushed");
    expect(text).toContain("nothing was pushed");
    expect(text).toContain("round 2");
  });

  it("says the round pushed when it did", () => {
    // The other half, so the fix cannot be "never say pushed", which would
    // lose the fact rather than report it correctly.
    const text = describeAdvanceOutcome({
      kind: "iterated",
      round: 2,
      responses: ["fixed"],
      pushed: true,
      spoken: { outcome: "posted" },
      undrafted: "still-drafting",
      reviewerRequested: "asked",
      threads: NO_THREADS,
      unresolved: "",
    });

    expect(text).toContain("round 2 pushed.");
  });

  it("says the cap fired rather than that the reviewer was satisfied", () => {
    // `ready` and `reviewer-exhausted` both undraft — reading one as the other would tell a human
    // the bot and reviewer agreed when they did not.
    const text = describeAdvanceOutcome({
      kind: "reviewer-exhausted",
      rounds: 3,
      unresolved: "this still allocates on every render",
    });
    expect(text).toContain("EXHAUSTED");
    expect(text).toContain("still allocates on every render");
    expect(text).not.toContain("nothing to act on");
  });

  it("says which budget ran out, and that the other one has not", () => {
    // This is a statement about one of two channels, not a terminal state — reading it as one
    // sends an operator to do by hand what the loop is still willing to do.
    const text = describeAdvanceOutcome({ kind: "reviewer-exhausted", rounds: 3, unresolved: "x" });

    expect(text).toContain("REVIEWER EXHAUSTED");
    expect(text).toContain("human");
  });

  it("does not describe waiting as work that happened", () => {
    const text = describeAdvanceOutcome({ kind: "waiting", quietMs: 60_000 });
    expect(text).toContain("WAITING");
    expect(text).toContain("nothing was pushed");
  });
});

describe("terminalLabelAfter", () => {
  /**
   * The whole table, because this function is defined by what it excludes.
   *
   * A test naming only the labelled outcomes would pass just as happily if a third started
   * labelling too, and a wrongly-labelled ticket leaves the queue permanently stuck.
   */
  const EXPECTED: Readonly<Record<string, "failed" | null>> = {
    "no-worktree": "failed",
    bailed: "failed",
    "abandoned:judgement": "failed",
    "abandoned:environment": "failed",
    refused: "failed",
    escaped: null,
    failed: "failed",
    crashed: "failed",
    "unusable-base": "failed",
    verified: null,
  };

  it("covers every outcome kind", () => {
    // Pins the table against the union rather than against itself: a new
    // SolveOutcome member reaches this test before it reaches production.
    expect(new Set(OUTCOMES.map(exitKey))).toEqual(new Set(Object.keys(EXPECTED)));
  });

  for (const outcome of OUTCOMES) {
    const key = exitKey(outcome);
    it(`leaves ${key} as ${EXPECTED[key] ?? "a release"}`, () => {
      expect(terminalLabelAfter(outcome)).toBe(EXPECTED[key] ?? null);
    });
  }

  it("labels a machine crash too, so a ticket that always times out does not loop silently forever", () => {
    // A crash says nothing about this attempt's ticket specifically, but leaving it unlabelled
    // bought nothing but a silent reclaim every tick the in-memory ledger forgot on restart — the
    // same shape SSX-3954 hit for `unusable-base`, below. A human reads the reason and clears it.
    expect(
      terminalLabelAfter({
        kind: "crashed",
        pass: "recon",
        reason: "recon pass of SSX-3831 exceeded 1800000ms",
        worktree,
      }),
    ).toBe("failed");
  });

  it("labels a bail, so the queue stops paying to be told no twice", () => {
    expect(
      terminalLabelAfter({
        kind: "bailed",
        reason: "two acceptance criteria have no single reasonable implementation",
        devLens: { accurate: false, correction: "AK3 needs a mechanism that does not exist" },
        worktree,
        recon: {} as never,
        cleanup: { outcome: "removed", path: worktree.path, branch: { outcome: "deleted" } },
      }),
    ).toBe("failed");
  });

  it("labels a deterministic build failure, so the daemon stops reclaiming it every restart", () => {
    // verify.ts only reaches `kind: "failed"` after the build/tests actually ran and did not
    // pass — a fact about the change, not the harness — so releasing it back to `agent:solvable`
    // bought nothing but a reclaim on every tick the in-memory attempt ledger forgot on restart.
    expect(
      terminalLabelAfter({
        kind: "failed",
        reason: "2 tests failed",
        fix: FIX_REPORT,
        verification: {} as never,
        devLens: lens,
        worktree,
      }),
    ).toBe("failed");
  });

  it("labels an unusable base too, so a broken repository toolchain does not loop silently forever (SSX-3954)", () => {
    // SSX-3954: the repository's build did not pass in a fresh worktree before any change —
    // reproduced as this harness's Maven/JDK toolchain against the repository's pinned Lombok
    // version, a fact about the harness, not about the ticket. Recon and every later pass are
    // skipped (`describeSolveOutcome`'s "Nothing was attempted"), and without a terminal label
    // the ticket hit the same wall every tick the in-memory ledger had forgotten, across restarts.
    expect(
      terminalLabelAfter({
        kind: "unusable-base",
        reason: "the repository's own build does not pass in a fresh worktree",
        verification: {} as never,
        worktree,
      }),
    ).toBe("failed");
  });
});

describe("reportsToTicket", () => {
  /**
   * The same exhaustive table as above, for a stronger reason: a wrongly-silent outcome leaves
   * no artefact to notice, so only this table stands between a new kind and an invisible run.
   */
  const EXPECTED: Readonly<Record<string, boolean>> = {
    "no-worktree": true,
    bailed: true,
    "abandoned:judgement": true,
    "abandoned:environment": true,
    refused: true,
    escaped: true,
    failed: true,
    crashed: true,
    "unusable-base": true,
    verified: false,
  };

  it("covers every outcome kind", () => {
    expect(new Set(OUTCOMES.map(exitKey))).toEqual(new Set(Object.keys(EXPECTED)));
  });

  for (const outcome of OUTCOMES) {
    const key = exitKey(outcome);
    it(`${EXPECTED[key] === true ? "reports" : "stays quiet about"} ${key}`, () => {
      expect(reportsToTicket(outcome)).toBe(EXPECTED[key]);
    });
  }

  it("reports a blocked machine, which is the case the old gate lost", () => {
    // Restoring the old `terminalLabelAfter` gate here is the mutation that matters — this
    // assertion is what catches it.
    expect(
      reportsToTicket({
        kind: "abandoned",
        cause: "environment",
        reason: "the write pass was denied its Write tool by a local policy hook",
        devLens: { accurate: true, correction: "" },
        worktree,
      }),
    ).toBe(true);
  });

  it("reports a crash and an unusable base, which the old gate also lost", () => {
    expect(
      reportsToTicket({
        kind: "crashed",
        pass: "recon",
        reason: "recon pass exceeded 1800000ms",
        worktree,
      }),
    ).toBe(true);
    expect(
      reportsToTicket({
        kind: "unusable-base",
        reason: "the base build does not pass in a fresh worktree",
        verification: {} as never,
        worktree,
      }),
    ).toBe(true);
  });

  it("disagrees with terminalLabelAfter, because they ask different questions", () => {
    // An escaped run must be reported but NOT labelled: reporting tells the team the run
    // happened; labelling would blame the ticket for an operator's own concurrent edits to their
    // checkout, which is what `escaped` actually means. It is the one outcome that still diverges
    // now that every other release-with-no-verdict kind also labels `agent:failed`.
    const blocked: SolveOutcome = {
      kind: "escaped",
      paths: ["/git/commerce-rest-api"],
      would: "verified",
      worktree,
    };
    expect(reportsToTicket(blocked)).toBe(true);
    expect(terminalLabelAfter(blocked)).toBeNull();
  });

  it("stays quiet on success, because the pull request is the notification", () => {
    expect(reportsToTicket(verified)).toBe(false);
  });
});

describe("describeReviewSweep", () => {
  const quiet: ReviewCycleOutcome = {
    watched: 4,
    acted: [],
    settled: [],
    ended: [],
    unlooked: [],
    deferred: [],
  };

  it("says a quiet pass in one line", () => {
    // Printed every tick forever — if a quiet pass is more than one line, the log is unreadable
    // by the time anything happens.
    const line = describeReviewSweep(7, quiet);
    expect(line).toBe("pass 7: 4 watched");
    expect(line).not.toContain("\n");
  });

  it("names every ticket it spent money on, rather than counting them", () => {
    const line = describeReviewSweep(1, {
      ...quiet,
      acted: [
        { issueKey: "SSX-1", number: 11, outcome: { kind: "waiting", quietMs: null } },
        {
          issueKey: "SSX-2",
          number: 22,
          outcome: { kind: "failed", stage: "worktree", reason: "dirty" },
        },
      ],
    });
    expect(line).toContain("SSX-1 #11 waiting");
    expect(line).toContain("SSX-2 #22 failed");
  });

  it("reports the deferral, because that is the bound doing something", () => {
    // Deferred work is actionable work this pass declined to pay for — hiding it makes
    // MAX_REVIEW_ROUNDS_PER_TICK invisible at the only moment it is visible.
    expect(describeReviewSweep(1, { ...quiet, deferred: ["SSX-9", "SSX-10"] })).toContain(
      "2 deferred",
    );
  });

  it("gives a failed look its reason and not just a count", () => {
    // A look that failed repeats identically every pass until somebody reads
    // why, so a bare number would scroll past forever saying nothing.
    const line = describeReviewSweep(1, {
      ...quiet,
      unlooked: [{ issueKey: "SSX-3", reason: "gh timed out" }],
    });
    expect(line).toContain("SSX-3: gh timed out");
  });

  it("distinguishes a merge from a close", () => {
    const line = describeReviewSweep(1, {
      ...quiet,
      ended: [
        { issueKey: "SSX-4", number: 44, state: "MERGED" },
        { issueKey: "SSX-5", number: 55, state: "CLOSED" },
      ],
    });
    expect(line).toContain("SSX-4 MERGED");
    expect(line).toContain("SSX-5 CLOSED");
  });

  it("does not print a section for something that did not happen", () => {
    const line = describeReviewSweep(1, {
      ...quiet,
      settled: [{ issueKey: "SSX-6", number: 66, outcome: { kind: "waiting", quietMs: 1 } }],
    });
    expect(line).toContain("1 settled");
    expect(line).not.toContain("deferred");
    expect(line).not.toContain("could not look");
  });
});

describe("endedState and completionLabelFor", () => {
  it("gives agent:done to a merge and nothing else", () => {
    // `agent:done` is the count of bugs this tool fixed — widening it to any ended pull request
    // would silently absorb every change a person declined.
    expect(completionLabelFor("MERGED")).toBe("done");
    expect(completionLabelFor("CLOSED")).toBe("closed");
  });

  it("reads only the exact word gh prints for a merge", () => {
    expect(endedState("MERGED")).toBe("MERGED");
    expect(endedState("CLOSED")).toBe("CLOSED");
  });

  it("treats a state it has never seen as closed", () => {
    // `closed` counts nothing, so an unrecognised spelling costs the wrong label — the inverse
    // would let a future `gh` inflate the number of bugs this service claims to have fixed.
    expect(endedState("merged")).toBe("CLOSED");
    expect(endedState("DRAFT")).toBe("CLOSED");
    expect(endedState("")).toBe("CLOSED");
  });
});
