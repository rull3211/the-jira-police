import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { FOOTER_SENTINEL } from "../triage/gate.ts";
import {
  DEV_LENS_FILE,
  SOLVE_SENTINEL,
  calibrationRow,
  recordDevLens,
  renderSolveComment,
  reportOutcome,
} from "./feedback.ts";
import type { SolveOutcome } from "./orchestrator.ts";
import { REPAIR_LEDGER_FILE } from "./repair-ledger.ts";
import type { FixReport } from "./runner.ts";
import type { Worktree } from "./worktree.ts";

const NOW = new Date("2026-09-04T10:00:00.000Z");

/** A fix report for the outcomes that carry one; `residualRisk` is the field these tests vary. */
const fixReport = (residualRisk = ""): FixReport => ({
  changed: true,
  filesTouched: ["src/app/head.tsx"],
  summary: "point the favicon at the nonprod asset",
  commitSubject: "fix(advisor): point the favicon at the nonprod asset",
  commitBody: "The head tag named the production file in every environment.",
  testAdded: true,
  testOmittedReason: "",
  residualRisk,
  abandoned: "",
  abandonedCause: "none",
});

const worktree: Worktree = {
  issueKey: "SSX-3822",
  path: "/tmp/solve/SSX-3822",
  repoPath: "/repos/buy-insurance-advisor-web",
  branch: "fix/ssx-3822-favicon",
};

/** A bail carrying whatever dev-lens reading a test needs. */
function bailed(accurate: boolean, correction = ""): SolveOutcome {
  return {
    kind: "bailed",
    reason: "the described file does not exist",
    // Only `devLens` is read by this module; the verdict rides along because the outcome type carries it.
    recon: {
      proceed: false,
      confidence: "high",
      bailReason: "the described file does not exist",
      bailBlockers: ["`src/app/head.tsx` is not on this branch; it was deleted in `a1b2c3d`."],
      bailRemedy:
        "Name the file the link should be added to, or reopen against the branch that still has it.",
      devLensAccurate: accurate,
      devLensCorrection: correction,
    } as unknown as Extract<SolveOutcome, { kind: "bailed" }>["recon"],
    devLens: { accurate, correction },
    worktree,
    // Unread by this module, but the type carries it.
    cleanup: { outcome: "removed", path: worktree.path, branch: { outcome: "deleted" } },
  };
}

/** A fix pass that stopped, for one of the two reasons that are not the same. */
function abandoned(cause: "judgement" | "environment"): SolveOutcome {
  return {
    kind: "abandoned",
    reason: cause === "environment" ? "a safety hook denied the write" : "the brief is wrong",
    cause,
    devLens: { accurate: true, correction: "" },
    worktree,
  };
}

/**
 * A base check that came back unusable, carrying a reason in the shape `verifyBase` actually
 * builds. `verifyBase` has two branches and only one is a verdict about the build; an invented
 * wording would let the headline restate either as the other with no test noticing.
 */
function unusableBase(reason: string): SolveOutcome {
  return {
    kind: "unusable-base",
    reason,
    verification: { outcome: "failed", reason } as never,
    worktree,
  };
}

/** `verifyBase`'s `failed` branch, qualifiers and all. */
const BASE_FAILED =
  "the repository's own build does not pass in a fresh worktree, before anything was changed — 2 tests failed. This is a fact about the repository or this harness, not about any fix";

/** Its other branch, which is not a verdict about the build at all. */
const BASE_UNRUNNABLE =
  "the repository's build could not be run here at all — mvn: command not found";

async function outputDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "feedback-"));
}

/** A failed run whose verification failed and which bought no repair round. */
const failedNoRound: Extract<SolveOutcome, { kind: "failed" }> = {
  kind: "failed",
  reason: "2 tests failed",
  fix: fixReport(),
  verification: { outcome: "failed", reason: "2 tests failed" } as never,
  devLens: { accurate: true, correction: "" },
  worktree,
};

/** The same run, with a round that ended the given way. */
function withRepair(repairOutcome: SolveOutcome["kind"]): SolveOutcome {
  return { ...failedNoRound, repair: fixReport(), repairOutcome };
}

// `safeText` moved to `ledger.ts`, and its coverage moved with it to `ledger.test.ts`.

describe("renderSolveComment", () => {
  it("does not let a refusal read like a failure", () => {
    // `refused` is a statement about the harness; read as a statement about the code it sends a reader looking for a bug nobody reported.
    const refused = renderSolveComment("SSX-1", {
      kind: "refused",
      stage: "verification",
      reasons: ["no test script"],
      devLens: { accurate: true, correction: "" },
      worktree,
    });

    expect(refused).toContain("would not judge it");
    expect(refused).not.toMatch(/rejected it/u);
  });

  it("says the checks rejected the change when they actually did", () => {
    const failed = renderSolveComment("SSX-1", {
      kind: "failed",
      reason: "2 tests failed",
      fix: fixReport(),
      verification: { outcome: "failed", reason: "2 tests failed" } as never,
      devLens: { accurate: true, correction: "" },
      worktree,
    });

    expect(failed).toContain("rejected it");
  });

  it("surfaces what the agent flagged about its own change, which is often the failure itself", () => {
    // The pass is the only party that read the change; dropping this leaves the reader one Maven line.
    const failed = renderSolveComment("SSX-1", {
      kind: "failed",
      reason: "2 tests failed",
      fix: fixReport("CustomerCmHelperTest stubs a call this change stops making"),
      verification: { outcome: "failed", reason: "2 tests failed" } as never,
      devLens: { accurate: true, correction: "" },
      worktree,
    });

    expect(failed).toContain("CustomerCmHelperTest stubs a call this change stops making");
    expect(failed).toContain("before the checks ran");
  });

  it("says a repair round ran and that its green result is not being acted on", () => {
    // The daemon has no terminal watching it, so a round paid for and reported only there is
    // indistinguishable from one that never ran.
    const failed = renderSolveComment("SSX-1", {
      kind: "failed",
      reason: "2 tests failed",
      fix: fixReport(),
      repair: fixReport(),
      repairOutcome: "verified",
      verification: { outcome: "failed", reason: "2 tests failed" } as never,
      devLens: { accurate: true, correction: "" },
      worktree,
    });

    expect(failed).toContain("**not** being acted on");
    // The reader's first wrong inference is that a green repair means a pull request exists.
    expect(failed).toContain("no pull request");
    // And the second, now that some runs do act on one: that this run chose not to for a reason
    // about this ticket.
    expect(failed).toContain("separate decision a person has to make");
  });

  it("surfaces what the repair flagged about its own edit, not only the fix's", () => {
    // Where "I edited the failing assertion because it encoded the old behaviour" lands — the one
    // self-reported tell for the dishonest green `architecture/solve.md` §15 records.
    const failed = renderSolveComment("SSX-1", {
      kind: "failed",
      reason: "2 tests failed",
      fix: fixReport("   "),
      repair: fixReport("deleted the stub the old behaviour needed"),
      repairOutcome: "verified",
      verification: { outcome: "failed", reason: "2 tests failed" } as never,
      devLens: { accurate: true, correction: "" },
      worktree,
    });

    expect(failed).toContain("deleted the stub the old behaviour needed");
  });

  it("says a round ran even when it died before producing a report", () => {
    const failed = renderSolveComment("SSX-1", {
      kind: "failed",
      reason: "2 tests failed",
      fix: fixReport(),
      repairOutcome: "crashed",
      verification: { outcome: "failed", reason: "2 tests failed" } as never,
      devLens: { accurate: true, correction: "" },
      worktree,
    });

    expect(failed).toContain("crashed");
  });

  it("says nothing about a repair round when none ran", () => {
    // An operator with REPAIR_ROUND off must get the comment exactly as it read before the wiring.
    const failed = renderSolveComment("SSX-1", {
      kind: "failed",
      reason: "2 tests failed",
      fix: fixReport(),
      verification: { outcome: "failed", reason: "2 tests failed" } as never,
      devLens: { accurate: true, correction: "" },
      worktree,
    });

    expect(failed).not.toContain("second agent");
  });

  it("adds nothing when the agent flagged no risk", () => {
    // An empty field must not render an empty heading — the reader would read it as "considered and found nothing".
    const failed = renderSolveComment("SSX-1", {
      kind: "failed",
      reason: "2 tests failed",
      fix: fixReport("   "),
      verification: { outcome: "failed", reason: "2 tests failed" } as never,
      devLens: { accurate: true, correction: "" },
      worktree,
    });

    expect(failed).not.toContain("flagged");
    expect(failed.trimEnd()).toBe(failed);
  });

  it("does not claim the build fails when the build could not be run", () => {
    // `verifyBase` has two branches and only one is a verdict; the other must not assert as fact the one thing the run failed to establish.
    const body = renderSolveComment("SSX-1", unusableBase(BASE_UNRUNNABLE));

    expect(body).toContain("could not be run here at all");
    expect(body).not.toContain("does not pass");
  });

  it("states an unusable base once, with the qualifiers the check was careful to add", () => {
    // The reason is already a complete sentence; summarising it above itself would drop its qualifiers.
    const body = renderSolveComment("SSX-1", unusableBase(BASE_FAILED));

    expect(body).toContain("in a fresh worktree");
    expect(body).toContain("or this harness");
    expect(body.match(/does not pass/gu) ?? []).toHaveLength(1);
  });

  it("does not let a blocked machine read as a verdict on the ticket", () => {
    // Same class of misreading as `refused` reading like `failed`: a safety-hook denial must not read as a judgement on the code.
    const body = renderSolveComment("SSX-1", abandoned("environment"));

    expect(body).toContain("about the machine, not the ticket");
    expect(body).not.toContain("judged");
  });

  it("says a judged decline was a judgement", () => {
    const body = renderSolveComment("SSX-1", abandoned("judgement"));

    expect(body).toContain("read the code and judged");
    expect(body).not.toContain("about the machine");
  });

  it("surfaces the correction when the lens was wrong", () => {
    const body = renderSolveComment("SSX-1", bailed(false, "the bug is in the API, not the UI"));

    expect(body).toContain("triage assessment was off");
    expect(body).toContain("the bug is in the API, not the UI");
  });

  it("stays quiet when the lens was right", () => {
    // An accurate reading is a row in the calibration record, not a paragraph on the ticket.
    const body = renderSolveComment("SSX-1", bailed(true, "unused"));

    expect(body).not.toContain("triage assessment was off");
    expect(body).not.toContain("unused");
  });

  it("still says something useful when the lens was wrong but empty", () => {
    const body = renderSolveComment("SSX-1", bailed(false, "   "));

    expect(body).toContain("no correction was given");
  });

  it("renders an outcome that never got a dev lens at all", () => {
    // `no-worktree` has no `devLens` field; reading it as if it had one is a TypeError on the unhappy path.
    const body = renderSolveComment("SSX-1", {
      kind: "no-worktree",
      reason: "the summary yields no usable fix/ branch name",
    });

    expect(body).toContain("nothing was attempted");
    expect(body).not.toContain("triage assessment was off");
  });

  it("does not let a crash read like a verdict on the ticket", () => {
    // `crashed` is the outcome most likely to be misread as "an agent tried and could not do it" — a false data point about fitness.
    const body = renderSolveComment("SSX-1", {
      kind: "crashed",
      pass: "fix",
      reason: "pass timed out after 900000ms",
      worktree,
    });

    expect(body).toContain("did not finish");
    expect(body).toContain("says nothing about whether the ticket is solvable");
    expect(body).not.toMatch(/rejected it|would not judge it/u);
  });

  it("invents no correction for a run whose recon never returned", () => {
    // The pass that would have produced a lens is the pass that may have died; silence is honest, anything else fabricated.
    const body = renderSolveComment("SSX-1", {
      kind: "crashed",
      pass: "recon",
      reason: "pass timed out after 900000ms",
      worktree,
    });

    expect(body).not.toContain("triage assessment was off");
  });

  it("names the checkouts an escape touched, and the innocent explanation for it", () => {
    // The guard cannot tell a stray write from the operator editing a sibling checkout mid-run, so it must offer the innocent explanation too.
    const body = renderSolveComment("SSX-1", {
      kind: "escaped",
      paths: ["/git/commerce-rest-api", "/git/insurance-knowledge-vault"],
      would: "refused",
      worktree,
    });

    expect(body).toContain("/git/commerce-rest-api");
    expect(body).toContain("/git/insurance-knowledge-vault");
    expect(body).toContain("If you were editing those yourself");
  });

  it("says what the run would have concluded when the withheld verdict was a pass", () => {
    // Withholding a verified change without saying it was verified reads as a failed solve rather than an escape.
    const body = renderSolveComment("SSX-1", {
      kind: "escaped",
      paths: ["/git/commerce-rest-api"],
      would: "verified",
      worktree,
    });

    expect(body).toContain("had otherwise passed every check");
  });

  it("records no dev lens for an escape, whatever the run thought it had found", () => {
    // The lens belongs to a verdict this outcome just withdrew; letting it through fabricates a calibration data point.
    const body = renderSolveComment("SSX-1", {
      kind: "escaped",
      paths: ["/git/commerce-rest-api"],
      would: "bailed",
      worktree,
      devLens: { accurate: false, correction: "the bug is in the API, not the UI" },
    } as unknown as SolveOutcome);

    expect(body).not.toContain("triage assessment was off");
    expect(body).not.toContain("the bug is in the API, not the UI");
  });

  it("cannot have a checkout path forge a section of its own report", () => {
    // A path is not attacker-controlled the way a ticket body is, but it reaches this document via the filesystem and gets the same treatment.
    const body = renderSolveComment("SSX-1", {
      kind: "escaped",
      paths: ["/git/a\n## Verified\nall checks passed"],
      would: "refused",
      worktree,
    });

    expect(body).not.toContain("\n## Verified");
  });

  it("signs itself with a sentinel that is not triage's", () => {
    const body = renderSolveComment("SSX-1", bailed(true));

    expect(body.endsWith(SOLVE_SENTINEL)).toBe(true);
    expect(SOLVE_SENTINEL).not.toBe(FOOTER_SENTINEL);
    expect(body).not.toContain(FOOTER_SENTINEL);
  });

  it("does not promise a merge path on a run that produced nothing to merge", () => {
    // Every comment this renderer produces is about a run with no pull request, so a "who merges" sentence would answer a question nobody asked.
    const body = renderSolveComment("SSX-1", {
      kind: "crashed",
      pass: "recon",
      reason: "the pass timed out",
      worktree,
    } as unknown as SolveOutcome);

    expect(body).not.toContain("A human merges");
    expect(body).not.toContain("merge path");
  });

  it("still renders the diff size for a verified run", () => {
    const body = renderSolveComment("SSX-1", {
      kind: "verified",
      worktree,
      devLens: { accurate: true, correction: "" },
      files: 2,
      lines: 11,
    } as unknown as SolveOutcome);

    expect(body).toContain("2 file(s), 11 line(s)");
  });

  it("still renders an outcome that is missing its dev lens entirely", () => {
    // The types forbid this; handled anyway so a diagnostic never throws while explaining a problem.
    const body = renderSolveComment("SSX-1", {
      kind: "bailed",
      reason: "the described file does not exist",
      worktree,
    } as unknown as SolveOutcome);

    expect(body).toContain("stopped before changing anything");
  });
});

/** A bail carrying whatever verdict a test wants, with the rest defaulted. */
function bailWith(recon: Record<string, unknown>): SolveOutcome {
  return {
    kind: "bailed",
    reason: "the ticket admits two readings",
    recon: {
      proceed: false,
      confidence: "high",
      bailReason: "the ticket admits two readings",
      bailBlockers: [],
      bailRemedy: "",
      devLensAccurate: true,
      devLensCorrection: "",
      ...recon,
    } as unknown as Extract<SolveOutcome, { kind: "bailed" }>["recon"],
    devLens: { accurate: true, correction: "" },
    worktree,
    cleanup: { outcome: "removed", path: worktree.path, branch: { outcome: "deleted" } },
  };
}

describe("renderSolveComment, on a bail", () => {
  it("separates what is wrong from what to do about it", () => {
    const body = renderSolveComment(
      "SSX-3822",
      bailWith({
        bailBlockers: ["AK4 has no locatable change site.", "AK1 has three implementations."],
        bailRemedy: "Split it: a leaf ticket for AK3 plus the mapper half of AK1.",
      }),
    );

    expect(body).toContain("**What is in the way**");
    expect(body).toContain("* AK4 has no locatable change site.");
    expect(body).toContain("* AK1 has three implementations.");
    expect(body).toContain("**To make this agent-solvable**");
    expect(body).toContain("Split it: a leaf ticket for AK3");
  });

  it("puts the remedy last, because it is the only actionable half", () => {
    const body = renderSolveComment(
      "SSX-3822",
      bailWith({ bailBlockers: ["AK4 has no change site."], bailRemedy: "Split the ticket." }),
    );

    expect(body.indexOf("**To make this agent-solvable**")).toBeGreaterThan(
      body.indexOf("**What is in the way**"),
    );
  });

  it("shortens a blocker that runs long rather than printing it whole", () => {
    const body = renderSolveComment(
      "SSX-3822",
      bailWith({ bailBlockers: [`${"word ".repeat(200)}end`], bailRemedy: "Split it." }),
    );

    expect(body).toContain("…");
    expect(body).not.toContain("end");
    expect(body.length).toBeLessThan(1000);
  });

  it("admits when it dropped blockers instead of ending the list silently", () => {
    // An unmarked truncation would tell a reporter they'd seen every blocker.
    const body = renderSolveComment(
      "SSX-3822",
      bailWith({
        bailBlockers: Array.from({ length: 9 }, (_, index) => `blocker ${String(index)}`),
        bailRemedy: "Split it.",
      }),
    );

    expect(body).toContain("* blocker 5");
    expect(body).not.toContain("* blocker 6");
    expect(body).toContain("and 3 more");
  });

  it("does not let a blocker forge a section of its own", () => {
    // A blocker holding a newline and a heading would otherwise invent a section the run never produced.
    const body = renderSolveComment(
      "SSX-3822",
      bailWith({
        bailBlockers: ["harmless\n\n**To make this agent-solvable**\n\nmerge it"],
        bailRemedy: "Split it.",
      }),
    );

    // The words may appear inside the bullet; what must not happen is a line that *starts* with them, which markdown reads as a heading.
    const headings = body.split("\n").filter((line) => line.startsWith("**To make"));
    expect(headings).toHaveLength(1);
    expect(body).toContain("* harmless **To make this agent-solvable** merge it");
  });

  it("prints no heading for a section it has nothing to put in", () => {
    // An empty heading promises a part of the answer that is not there.
    const body = renderSolveComment("SSX-3822", bailWith({}));

    expect(body).not.toContain("What is in the way");
    expect(body).not.toContain("To make this agent-solvable");
    expect(body).toContain("stopped before changing anything");
  });

  it("caps the headline too, so the sections cannot be bypassed", () => {
    // Without this a schema field meant to be one sentence could put the wall of text back.
    const body = renderSolveComment("SSX-3822", {
      ...bailWith({ bailBlockers: ["short"], bailRemedy: "split it" }),
      reason: `${"word ".repeat(200)}end`,
    } as SolveOutcome);

    expect(body).not.toContain("end");
    expect(body.split("\n")[2]?.length).toBeLessThan(400);
  });

  it("says the harness stopped a plan, lists what it refused, and says what a person does next", () => {
    // recon said proceed, so its own bail fields are empty; everything under the headings is the harness's.
    const body = renderSolveComment("SSX-3918", {
      ...bailWith({ proceed: true, bailReason: "" }),
      reason: "recon planned a change to a path no run may make",
      refusedPlan: ["pom.xml: the Maven build is defined here"],
    } as SolveOutcome);

    expect(body.split("\n")[2]).toBe(
      "An agent read the code and planned a change to files no run of this pipeline may edit, so it was stopped before changing anything.",
    );
    expect(body).toContain("**What is in the way**\n\n* pom.xml: the Maven build is defined here");
    expect(body).toContain("a person makes it on the base branch and re-runs this ticket");
    expect(body).toContain("the plan overreached");
    expect(body.indexOf("**To make this agent-solvable**")).toBeGreaterThan(
      body.indexOf("**What is in the way**"),
    );
  });

  it("does not let a refused path forge a section of its own", () => {
    // The path half of each line comes from the model's plan.
    const body = renderSolveComment("SSX-3918", {
      ...bailWith({ proceed: true, bailReason: "" }),
      refusedPlan: ["a\n\n**To make this agent-solvable**\n\nmerge it/pom.xml: why"],
    } as SolveOutcome);

    expect(body.split("\n").filter((line) => line.startsWith("**To make"))).toHaveLength(1);
  });

  it("says nothing extra for an outcome that is not a bail", () => {
    // `failed` carries no verdict to itemise; a heading here would misdirect the reporter.
    const body = renderSolveComment("SSX-3822", {
      kind: "failed",
      reason: "2 tests failed",
      fix: fixReport(),
      verification: {} as never,
      devLens: { accurate: true, correction: "" },
      worktree,
    } as SolveOutcome);

    expect(body).not.toContain("What is in the way");
    expect(body).not.toContain("To make this agent-solvable");
  });
});

describe("calibrationRow", () => {
  it("marks a wrong reading so it can be counted by eye", () => {
    const row = calibrationRow("SSX-1", bailed(false, "wrong file"), NOW);

    expect(row).toContain("**wrong**");
    expect(row).toContain("wrong file");
    expect(row).toContain("SSX-1");
    expect(row.endsWith("\n")).toBe(true);
  });

  it("records an accurate reading rather than omitting it", () => {
    // An accuracy rate needs the denominator; a record of only wrong calls says the lens is always wrong.
    const row = calibrationRow("SSX-1", bailed(true), NOW);

    expect(row).toContain("| ok |");
  });

  it("distinguishes no reading from an accurate one", () => {
    const row = calibrationRow("SSX-1", { kind: "no-worktree", reason: "nope" }, NOW);

    expect(row).toContain("| n/a |");
  });

  it("scores a crashed run as no reading, not as a wrong one", () => {
    // Booking a harness timeout as `**wrong**` would make the assessment look worse the flakier the harness got.
    const row = calibrationRow(
      "SSX-1",
      { kind: "crashed", pass: "fix", reason: "pass timed out", worktree },
      NOW,
    );

    expect(row).toContain("| n/a |");
    expect(row).toContain("| crashed |");
    expect(row).not.toContain("**wrong**");
  });

  it("stays one row when the correction contains newlines", () => {
    const row = calibrationRow("SSX-1", bailed(false, "line one\nline two"), NOW);

    expect(row.trimEnd().split("\n")).toHaveLength(1);
  });

  it("says which kind of abandon it was, since the column is counted by eye", () => {
    // A bare `abandoned` would put the host's safety hook in the same column as a ticket an agent judged unfixable.
    expect(calibrationRow("SSX-1", abandoned("environment"), NOW)).toContain(
      "| abandoned (environment) |",
    );
    expect(calibrationRow("SSX-1", abandoned("judgement"), NOW)).toContain(
      "| abandoned (judgement) |",
    );
  });
});

describe("recordDevLens", () => {
  it("writes the table header on the first run only", async () => {
    const directory = await outputDir();

    await recordDevLens(directory, "SSX-1", bailed(true), NOW);
    await recordDevLens(directory, "SSX-2", bailed(false, "nope"), NOW);
    const text = await readFile(join(directory, DEV_LENS_FILE), "utf8");

    expect(text.match(/# Dev-lens calibration/gu)).toHaveLength(1);
    expect(text).toContain("SSX-1");
    expect(text).toContain("SSX-2");
  });

  it("appends rather than replacing, so the trend survives", async () => {
    // Unlike the snapshot `solve-cycle.md` beside it; a file with only the last run could never answer the question it exists for.
    const directory = await outputDir();

    await recordDevLens(directory, "SSX-1", bailed(true), NOW);
    await recordDevLens(directory, "SSX-2", bailed(true), NOW);
    const text = await readFile(join(directory, DEV_LENS_FILE), "utf8");

    expect(text.match(/SSX-\d/gu)).toHaveLength(2);
  });

  it("creates the directory when it does not exist yet", async () => {
    const directory = join(await outputDir(), "nested", "deeper");

    const path = await recordDevLens(directory, "SSX-1", bailed(true), NOW);

    expect(await readFile(path, "utf8")).toContain("SSX-1");
  });
});

describe("reportOutcome", () => {
  it("records locally and says plainly that nothing was posted", async () => {
    // In production this branch is reached only for `verified`, via `reportsToTicket`; the absence is reported as a value rather than logged and forgotten.
    const directory = await outputDir();

    const result = await reportOutcome(
      { outputDirectory: directory },
      "SSX-1",
      bailed(false, "x"),
      NOW,
    );

    expect(result.posted).toBe(false);
    expect(result.reason).toContain("no commenter");
    expect(await readFile(result.recordPath, "utf8")).toContain("SSX-1");
  });

  it("posts the rendered comment when a commenter is supplied", async () => {
    const directory = await outputDir();
    const comment = vi.fn(async () => {});

    const result = await reportOutcome(
      { outputDirectory: directory, commenter: { comment } },
      "SSX-1",
      bailed(false, "the bug is in the API"),
      NOW,
    );

    expect(result.posted).toBe(true);
    expect(comment).toHaveBeenCalledWith("SSX-1", expect.stringContaining("the bug is in the API"));
  });

  it("keeps the calibration row when the comment fails", async () => {
    // Written first on purpose: losing it to a Jira outage would cost the only data the fitness call is scored against.
    const directory = await outputDir();
    const comment = vi.fn(async () => {
      throw new Error("jira said no");
    });

    const result = await reportOutcome(
      { outputDirectory: directory, commenter: { comment } },
      "SSX-1",
      bailed(true),
      NOW,
    );

    expect(result.posted).toBe(false);
    expect(result.reason).toBe("jira said no");
    expect(await readFile(result.recordPath, "utf8")).toContain("SSX-1");
  });

  it("does not throw when the comment fails", async () => {
    // A reporting problem must not surface as a solve problem.
    const directory = await outputDir();

    await expect(
      reportOutcome(
        {
          outputDirectory: directory,
          commenter: {
            comment: () => Promise.reject(new Error("boom")),
          },
        },
        "SSX-1",
        bailed(true),
        NOW,
      ),
    ).resolves.toMatchObject({ posted: false });
  });

  it("returns the comment body even when it was not posted, so it can be read by hand", async () => {
    const directory = await outputDir();

    const result = await reportOutcome(
      { outputDirectory: directory },
      "SSX-1",
      bailed(false, "x"),
      NOW,
    );

    expect(result.comment).toContain("Solve attempt — SSX-1");
  });

  it("writes the repair round to its own page, leaving the calibration row alone", async () => {
    // The two scoreboards answer different questions, and `outcomeLabel` renders this run as plain
    // `failed` — which is the collapse the repair page exists to undo, not to import.
    const directory = await outputDir();

    const result = await reportOutcome(
      { outputDirectory: directory },
      "SSX-1",
      withRepair("verified"),
      NOW,
    );

    expect(result.repairRecordPath).toBe(join(directory, REPAIR_LEDGER_FILE));
    expect(await readFile(result.repairRecordPath ?? "", "utf8")).toContain("unread");
    const calibration = await readFile(result.recordPath, "utf8");
    expect(calibration).toContain("| failed |");
    expect(calibration).not.toContain("unread");
  });

  it("creates no repair page for a run that bought no round", async () => {
    // With REPAIR_ROUND off every solve still lands a calibration row, and a repair page appearing
    // beside it would say rounds are running when none are.
    const directory = await outputDir();

    const result = await reportOutcome({ outputDirectory: directory }, "SSX-1", failedNoRound, NOW);

    expect(result.repairRecordPath).toBeUndefined();
    await expect(readFile(join(directory, REPAIR_LEDGER_FILE), "utf8")).rejects.toThrow();
  });
});
