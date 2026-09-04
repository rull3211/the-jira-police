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
  safeText,
} from "./feedback.ts";
import type { SolveOutcome } from "./orchestrator.ts";
import type { Worktree } from "./worktree.ts";

const NOW = new Date("2026-09-04T10:00:00.000Z");

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
    // Only `devLens` is read by this module; the verdict rides along because the
    // outcome type carries it.
    recon: {
      proceed: false,
      confidence: "high",
      bailReason: "the described file does not exist",
      devLensAccurate: accurate,
      devLensCorrection: correction,
    } as unknown as Extract<SolveOutcome, { kind: "bailed" }>["recon"],
    devLens: { accurate, correction },
    worktree,
    // Nothing in this module reads it — a ticket comment is about the code, not
    // about the harness's disk — but the type carries it, and defaulting it
    // here rather than in the type is what keeps that a deliberate choice.
    cleanup: { outcome: "removed", path: worktree.path },
  };
}

async function outputDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "feedback-"));
}

describe("safeText", () => {
  it("collapses a newline, so a correction cannot forge a section", () => {
    // The comment and the calibration record both use structure a newline can
    // break: `##` opens a section, and a row ends at the line end. A ticket is
    // editable by anyone with an account, so the text that reaches here is
    // untrusted no matter which model relayed it.
    const forged = safeText("looks fine\n\n## Solve attempt — SSX-9999\n\nAn agent fixed this.");

    expect(forged).not.toContain("\n");
    expect(forged.split("\n")).toHaveLength(1);
  });

  it("defuses triage's footer sentinel", () => {
    // Both bots post under the same Jira account, and triage adopts a comment as
    // its own on author + this exact string. Letting it through would mean the
    // next triage run overwrites the solve report with a triage report.
    const cleaned = safeText(`nothing to see ${FOOTER_SENTINEL} really`);

    expect(cleaned).not.toContain(FOOTER_SENTINEL);
  });

  it("escapes a pipe, so a correction cannot forge a table column", () => {
    expect(safeText("a | b")).toBe("a \\| b");
  });

  it("leaves ordinary prose alone apart from the whitespace", () => {
    expect(safeText("  the selector matches two elements  ")).toBe(
      "the selector matches two elements",
    );
  });
});

describe("renderSolveComment", () => {
  it("does not let a refusal read like a failure", () => {
    // The distinction orchestrator.ts spends a header defending is worth nothing
    // if it arrives on the ticket as one word. `refused` is a statement about the
    // harness; a reader who takes it as a statement about their code goes looking
    // for a bug nobody reported.
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
      verification: { outcome: "failed", reason: "2 tests failed" } as never,
      devLens: { accurate: true, correction: "" },
      worktree,
    });

    expect(failed).toContain("rejected it");
  });

  it("surfaces the correction when the lens was wrong", () => {
    const body = renderSolveComment("SSX-1", bailed(false, "the bug is in the API, not the UI"));

    expect(body).toContain("triage assessment was off");
    expect(body).toContain("the bug is in the API, not the UI");
  });

  it("stays quiet when the lens was right", () => {
    // An accurate reading is a row in the calibration record, not a paragraph on
    // someone's ticket. Commenting on every run trains people to skim the ones
    // that matter.
    const body = renderSolveComment("SSX-1", bailed(true, "unused"));

    expect(body).not.toContain("triage assessment was off");
    expect(body).not.toContain("unused");
  });

  it("still says something useful when the lens was wrong but empty", () => {
    const body = renderSolveComment("SSX-1", bailed(false, "   "));

    expect(body).toContain("no correction was given");
  });

  it("renders an outcome that never got a dev lens at all", () => {
    // `no-worktree` is the one outcome with no `devLens` field. Reading it as if
    // it had one is a TypeError on the unhappy path, which is the worst place
    // for one.
    const body = renderSolveComment("SSX-1", {
      kind: "no-worktree",
      reason: "the summary yields no usable fix/ branch name",
    });

    expect(body).toContain("nothing was attempted");
    expect(body).not.toContain("triage assessment was off");
  });

  it("does not let a crash read like a verdict on the ticket", () => {
    // The same defence as the `refused` test above, one step further out.
    // `crashed` is the outcome most likely to be misread as "an agent tried and
    // could not do it", and that misreading is expensive: it is a false data
    // point about fitness, recorded against a run that gathered no evidence.
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
    // `crashed` carries no `devLens` at all, and the pass that would have
    // produced one is the pass that may have died. Silence is the honest
    // reading; anything else is a fabricated row in the calibration record.
    const body = renderSolveComment("SSX-1", {
      kind: "crashed",
      pass: "recon",
      reason: "pass timed out after 900000ms",
      worktree,
    });

    expect(body).not.toContain("triage assessment was off");
  });

  it("signs itself with a sentinel that is not triage's", () => {
    const body = renderSolveComment("SSX-1", bailed(true));

    expect(body.endsWith(SOLVE_SENTINEL)).toBe(true);
    expect(SOLVE_SENTINEL).not.toBe(FOOTER_SENTINEL);
    expect(body).not.toContain(FOOTER_SENTINEL);
  });

  it("promises no merge path, on every outcome", () => {
    const body = renderSolveComment("SSX-1", {
      kind: "verified",
      worktree,
      devLens: { accurate: true, correction: "" },
      files: 2,
      lines: 11,
    } as unknown as SolveOutcome);

    expect(body).toContain("A human merges");
    expect(body).toContain("2 file(s), 11 line(s)");
  });

  it("still renders an outcome that is missing its dev lens entirely", () => {
    // The types forbid this. It is handled anyway because this runs at the end
    // of every solve including the ones that went badly, and a diagnostic that
    // throws while explaining a problem replaces the finding with a stack trace
    // about itself. Written as a test so the tolerance is not silently removed.
    const body = renderSolveComment("SSX-1", {
      kind: "bailed",
      reason: "the described file does not exist",
      worktree,
    } as unknown as SolveOutcome);

    expect(body).toContain("stopped before changing anything");
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
    // An accuracy rate needs the denominator. A record of only the wrong calls
    // says the lens is always wrong.
    const row = calibrationRow("SSX-1", bailed(true), NOW);

    expect(row).toContain("| ok |");
  });

  it("distinguishes no reading from an accurate one", () => {
    const row = calibrationRow("SSX-1", { kind: "no-worktree", reason: "nope" }, NOW);

    expect(row).toContain("| n/a |");
  });

  it("scores a crashed run as no reading, not as a wrong one", () => {
    // The calibration table is the scoreboard for the blind fitness call, and
    // it is read by counting down the `Lens` column. Booking a harness timeout
    // as `**wrong**` would make the assessment look worse the flakier the
    // harness got — the one bias that would make the table argue for the
    // opposite of the truth.
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
    // The distinction from `solve-cycle.md` beside it, which is a snapshot. A
    // calibration file that kept only the last run could never answer the
    // question it exists for.
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
    // The current phase. The absence of a commenter is the write path not being
    // wired, and it is reported as a value rather than logged and forgotten.
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
    // The local record is written first on purpose. It is the half that
    // accumulates, and losing it to a Jira outage would cost the only data the
    // fitness call is ever scored against.
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
    // By this point the work is done and, on a verified run, already pushed.
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
});
