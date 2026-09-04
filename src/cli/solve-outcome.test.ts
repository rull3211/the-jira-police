import { describe, expect, it } from "vitest";

import type { SolveOutcome } from "../solve/orchestrator.ts";
import { describeSolveOutcome, isFailureExit } from "./solve-outcome.ts";

const worktree = {
  issueKey: "SSX-3822",
  branch: "fix/ssx-3822-favicon",
  path: "/tmp/solve/SSX-3822",
  repoPath: "/repos/buy-insurance-advisor-web",
};

const lens = { accurate: true, correction: "" };

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

/** One of every kind, so the exhaustiveness claims below are about all of them. */
const OUTCOMES: readonly SolveOutcome[] = [
  { kind: "no-worktree", reason: "the summary yields no usable fix/ branch name" },
  {
    kind: "bailed",
    reason: "the described file does not exist",
    devLens: lens,
    worktree,
    recon: {} as never,
  },
  {
    kind: "abandoned",
    reason: "the fix is larger than the ticket describes",
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
    kind: "failed",
    reason: "2 tests failed",
    verification: {} as never,
    devLens: lens,
    worktree,
  },
  { kind: "crashed", pass: "fix", reason: "pass timed out after 900000ms", worktree },
  verified,
];

describe("isFailureExit", () => {
  it("does not fail the shell on a bail", () => {
    // A bail is the pipeline working. Recon declining is the honest answer to a
    // fitness call made with no source access, and a non-zero code here would
    // teach an operator — and, in Phase E, a backoff — to read success as error.
    expect(
      isFailureExit({
        kind: "bailed",
        reason: "the described file does not exist",
        devLens: lens,
        worktree,
        recon: {} as never,
      }),
    ).toBe(false);
  });

  it("fails the shell on a crash", () => {
    // The one most easily grouped with `bailed`, because neither is a verdict
    // about the code. The rule is not "was the code bad" — it is "did this run
    // produce a usable answer", and a dead pass did not, at full cost.
    expect(
      isFailureExit({ kind: "crashed", pass: "recon", reason: "pass timed out", worktree }),
    ).toBe(true);
  });

  it("agrees with itself across every outcome kind", () => {
    // Pinned as a whole so that adding a kind forces a decision here rather
    // than defaulting it to zero, which is the direction that fails quietly.
    expect(Object.fromEntries(OUTCOMES.map((o) => [o.kind, isFailureExit(o)]))).toEqual({
      "no-worktree": true,
      bailed: false,
      abandoned: false,
      refused: true,
      failed: true,
      crashed: true,
      verified: false,
    });
  });
});

describe("describeSolveOutcome", () => {
  it("says something for every kind", () => {
    for (const outcome of OUTCOMES) {
      expect(describeSolveOutcome(outcome)).not.toBe("");
    }
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
    // The two words an operator scanning output would act on, and neither is
    // true here. `FAILED` in particular means the repository's own checks
    // rejected the change, which nothing in a crashed run ever established.
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
    // The worktree is the evidence, and a path an operator has to reconstruct
    // by hand is one they will not look at.
    for (const outcome of OUTCOMES.filter((o) => o.kind !== "no-worktree")) {
      expect(describeSolveOutcome(outcome)).toContain(worktree.path);
    }
  });

  it("says plainly that a verified run pushed nothing", () => {
    // The outcome most likely to be skimmed as "done". Nothing left the machine.
    const line = describeSolveOutcome(verified);

    expect(line).toContain("Nothing was pushed");
    expect(line).toContain(worktree.branch);
  });
});
