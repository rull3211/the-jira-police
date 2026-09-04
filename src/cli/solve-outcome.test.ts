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
    kind: "failed",
    reason: "2 tests failed",
    verification: {} as never,
    devLens: lens,
    worktree,
  },
  { kind: "crashed", pass: "fix", reason: "pass timed out after 900000ms", worktree },
  verified,
];

/**
 * A key for the exhaustiveness table, which is `kind` except for `abandoned`.
 *
 * That kind is the one place where two rows of the table disagree — an
 * `environment` cause exits non-zero and a `judgement` cause does not — so
 * folding them under one key would let whichever came last silently stand in
 * for both, and the exhaustiveness check would pass while covering one of them.
 */
function exitKey(outcome: SolveOutcome): string {
  return outcome.kind === "abandoned" ? `abandoned:${outcome.cause}` : outcome.kind;
}

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
        cleanup: { outcome: "removed", path: worktree.path, branch: { outcome: "deleted" } },
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
    expect(Object.fromEntries(OUTCOMES.map((o) => [exitKey(o), isFailureExit(o)]))).toEqual({
      "no-worktree": true,
      bailed: false,
      "abandoned:judgement": false,
      "abandoned:environment": true,
      refused: true,
      failed: true,
      crashed: true,
      verified: false,
    });
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
    // And this is why the cause exists. Observed 2026-09-04: a safety hook on
    // the host denied a write mid-pass. Nothing was learned, the session was
    // paid for, and reporting it as a clean exit would file a working ticket
    // as one an agent declined.
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
    // The next command differs. `judgement` means read the reason and decide
    // whether the ticket was misjudged; `environment` means find out what
    // stopped the machine, and re-running is reasonable. One word for both
    // sends half of them to the wrong place.
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
    // by hand is one they will not look at. `bailed` is excluded because it is
    // the one outcome that removes its own worktree — and `no-worktree` never
    // had one.
    const keeps = OUTCOMES.filter((o) => o.kind !== "no-worktree" && o.kind !== "bailed");
    expect(keeps.length).toBeGreaterThan(3);
    for (const outcome of keeps) {
      expect(describeSolveOutcome(outcome)).toContain(worktree.path);
    }
  });

  it("does not send an operator to a worktree it just deleted", () => {
    // The prose/behaviour divergence this whole project exists to catch, in
    // miniature: the line used to say "Worktree kept at <path>" on every
    // outcome, and a bail now removes it. Printing the path anyway would send
    // someone to an empty directory to work out why it was empty.
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

  it("still points at the worktree when git refused to remove it", () => {
    // `removeWorktree` does not force, so a bail whose worktree is somehow
    // dirty keeps it — and that is precisely the case an operator most needs
    // the path for, because something wrote to a read-only pass's checkout.
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
