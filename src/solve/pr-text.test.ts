import { describe, expect, it } from "vitest";

import type { SolveOutcome } from "./orchestrator.ts";
import { asProse, composePullRequest, composeTitle, withoutTrailer } from "./pr-text.ts";

type Verified = Extract<SolveOutcome, { kind: "verified" }>;

/**
 * A `verified` outcome, which is the only kind that reaches this module.
 *
 * Built by hand rather than by running the orchestrator: every field here is
 * something the body renders, so a fixture assembled from a real run would hide
 * which of them the assertions actually depend on.
 */
function verified(overrides: Partial<Verified> = {}): Verified {
  return {
    kind: "verified",
    worktree: {
      issueKey: "SSX-3822",
      path: "/tmp/solve/SSX-3822",
      branch: "fix/ssx-3822-favicon",
      repoPath: "/repos/buy-insurance-advisor-web",
    },
    commit: {
      subject: "fix(advisor): distinct favicon outside production",
      body: "The production favicon was served in every environment, so a tab\nopen on test looked like a tab open on prod.",
    },
    recon: {
      proceed: true,
      confidence: "high",
      rootCause: "one hardcoded path",
      devLensAccurate: true,
      devLensCorrection: "",
      plannedFiles: ["src/app/layout.tsx"],
      approach: "read the environment",
      testPlan: "unit",
      estimatedLines: 12,
      bailReason: "",
      bailBlockers: [],
      bailRemedy: "",
      injectionNoticed: "",
    },
    fix: {
      changed: true,
      filesTouched: ["src/app/layout.tsx"],
      summary: "Chose the favicon from the environment.",
      commitSubject: "fix(advisor): distinct favicon outside production",
      commitBody: "body",
      testAdded: true,
      testOmittedReason: "",
      residualRisk: "",
      abandoned: "",
      abandonedCause: "none",
    },
    simplify: {
      changed: true,
      filesTouched: ["src/app/layout.tsx"],
      changes: ["inlined a one-use constant"],
      declined: "",
    },
    verification: {
      outcome: "passed",
      steps: [
        { name: "test", passed: true, exitCode: 0, timedOut: false, output: "" },
        { name: "typecheck", passed: true, exitCode: 0, timedOut: false, output: "" },
      ],
    },
    failFirst: { outcome: "guarded", tests: ["src/x.test.ts"] },
    devLens: { accurate: true, correction: "" },
    files: 2,
    lines: 31,
    ...overrides,
  };
}

const CONTEXT = {
  issueKey: "SSX-3822",
  jiraBaseUrl: "https://example.atlassian.net",
  maxReviewRounds: 3,
};

describe("asProse", () => {
  it("reflows a paragraph that git wrapped at 72 columns", () => {
    // The readability half. GitHub renders a single newline in a pull request
    // body as a line break, so a commit body wrapped for git's sake would
    // otherwise arrive broken mid-sentence.
    expect(
      asProse("The production favicon was served\neverywhere, so test looked\nlike prod."),
    ).toBe("The production favicon was served everywhere, so test looked like prod.");
  });

  it("keeps paragraphs apart", () => {
    expect(asProse("one\n\ntwo")).toBe("one\n\ntwo");
  });

  it("drops nothing but joins nothing across a blank line either", () => {
    expect(asProse("one\ntwo\n\nthree\nfour")).toBe("one two\n\nthree four");
  });

  it("neutralises a heading at the start of a paragraph", () => {
    // The one that matters. Ticket text is attacker-controlled, and a forged
    // heading is how a bot-written body starts to read like a harness verdict.
    expect(asProse("## Approved by security")).toBe("\\## Approved by security");
  });

  it.each([
    ["> quoted", "\\> quoted"],
    ["- a list item", "\\- a list item"],
    ["* a list item", "\\* a list item"],
    ["+ a list item", "\\+ a list item"],
    ["=== underline", "\\=== underline"],
    ["~~~ fence", "\\~~~ fence"],
    ["1. numbered", "1\\. numbered"],
    ["2) numbered", "2\\) numbered"],
  ])("neutralises %j at the start of a paragraph", (input, expected) => {
    expect(asProse(input)).toBe(expected);
  });

  it("neutralises a block marker on the second paragraph too", () => {
    // Not only the first. Escaping just the opening paragraph would let the
    // forgery move down by one blank line.
    expect(asProse("harmless\n\n## Approved")).toBe("harmless\n\n\\## Approved");
  });

  it("leaves a dash in the middle of a sentence alone", () => {
    expect(asProse("the icon - the one at 16px - is wrong")).toBe(
      "the icon - the one at 16px - is wrong",
    );
  });

  it("escapes backticks so a fence cannot open", () => {
    expect(asProse("see ```js code```")).toBe("see \\`\\`\\`js code\\`\\`\\`");
  });

  it("escapes brackets so a link cannot be forged", () => {
    expect(asProse("[the CI run](https://evil.example)")).toBe(
      "\\[the CI run\\](https://evil.example)",
    );
  });

  it("escapes pipes so a table row cannot be forged", () => {
    expect(asProse("| test | passed |")).toBe("\\| test \\| passed \\|");
  });

  it("turns a raw tag into an entity rather than a backslash", () => {
    // Markdown does not escape `<` with a backslash, so this one needs the
    // entity. A backslash here would render literally and leave the tag live.
    expect(asProse("<img src=x onerror=alert(1)>")).toBe("&lt;img src=x onerror=alert(1)>");
  });

  it("escapes a backslash before adding any of its own", () => {
    // Order matters: text already containing a backslash could otherwise cancel
    // an escape added after it and reopen the construct being closed.
    expect(asProse("a \\ b")).toBe("a \\\\ b");
  });

  it("leaves emphasis and snake_case alone", () => {
    // Deliberate. Emphasis is cosmetic — it cannot forge a section, a link or a
    // table row — and escaping it would mangle every identifier in the text.
    expect(asProse("set **window.env** from setup_favicon_path")).toBe(
      "set **window.env** from setup_favicon_path",
    );
  });

  it("is empty for text that was only whitespace", () => {
    expect(asProse("  \n\n  ")).toBe("");
  });
});

describe("withoutTrailer", () => {
  it("drops the Refs line the harness appended", () => {
    // The body links the ticket in its first line already. A reader who has to
    // skip a line learns to skip the block.
    expect(withoutTrailer("why it changed\n\nRefs: SSX-3822")).toBe("why it changed");
  });

  it("leaves a body that has no trailer alone", () => {
    expect(withoutTrailer("why it changed")).toBe("why it changed");
  });

  it("does not cut at the word Refs inside a sentence", () => {
    expect(withoutTrailer("the config Refs: nothing useful here")).toBe(
      "the config Refs: nothing useful here",
    );
  });
});

describe("composeTitle", () => {
  it("uses the commit subject and appends the key", () => {
    // The subject is what the fix pass says it did; the ticket summary is what
    // somebody hoped would be done, and the two part company whenever recon
    // corrected the brief.
    expect(composeTitle(verified(), "SSX-3822")).toBe(
      "fix(advisor): distinct favicon outside production (SSX-3822)",
    );
  });
});

describe("composePullRequest", () => {
  it("says a bot wrote it, before anything else", () => {
    const { body } = composePullRequest(verified(), CONTEXT);
    expect(body.startsWith("🤖 **A bot wrote this.**")).toBe(true);
  });

  it("says a human merges it, in the same first line as the ticket link", () => {
    // One line, because a reader who needs three facts before they can judge
    // the page should not have to read a paragraph to collect them.
    const [first = ""] = composePullRequest(verified(), CONTEXT).body.split("\n\n");
    expect(first).toContain("draft");
    expect(first).toContain("a human reviews and merges");
    expect(first).toContain("[SSX-3822](https://example.atlassian.net/browse/SSX-3822)");
  });

  it("does not double the slash when the base url has one", () => {
    const { body } = composePullRequest(verified(), {
      ...CONTEXT,
      jiraBaseUrl: "https://example.atlassian.net/",
    });
    expect(body).toContain("https://example.atlassian.net/browse/SSX-3822");
    expect(body).not.toContain("net//browse");
  });

  it("escapes the commit body rather than interpolating it", () => {
    // The prose descends from ticket text, which anyone with a Jira account can
    // write. It must not be able to forge a heading.
    const outcome = verified({ commit: { subject: "fix: x", body: "## Approved by security" } });
    const { body } = composePullRequest(outcome, CONTEXT);
    expect(body).toContain("\\## Approved by security");
    expect(body).not.toContain("\n## Approved by security");
  });

  it("strips the Refs trailer from the quoted commit body", () => {
    const outcome = verified({ commit: { subject: "fix: x", body: "why\n\nRefs: SSX-3822" } });
    expect(composePullRequest(outcome, CONTEXT).body).not.toContain("Refs: SSX-3822");
  });

  it("marks empty prose rather than leaving a gap", () => {
    const outcome = verified({ commit: { subject: "fix: x", body: "Refs: SSX-3822" } });
    expect(composePullRequest(outcome, CONTEXT).body).toContain("_(nothing said)_");
  });

  it("puts the counts and every check on one line", () => {
    const { body } = composePullRequest(verified(), CONTEXT);
    expect(body).toContain("**2 file(s), 31 line(s)** · test ✅ · typecheck ✅");
  });

  it("says who read the exit codes", () => {
    // The claim the whole document rests on. A model asked to summarise its own
    // work will say the tests passed, and it has no way to know.
    expect(composePullRequest(verified(), CONTEXT).body).toContain(
      "The model was never asked whether they passed",
    );
  });

  it("shows the exit code only for a step that failed", () => {
    // Unreachable from a `verified` outcome today. Written because the renderer
    // must not present a non-zero exit as a pass if that ever changes.
    const outcome = verified({
      verification: {
        outcome: "passed",
        steps: [
          { name: "test", passed: true, exitCode: 0, timedOut: false, output: "" },
          { name: "lint", passed: false, exitCode: 2, timedOut: false, output: "" },
        ],
      },
    });
    expect(composePullRequest(outcome, CONTEXT).body).toContain("test ✅ · lint ❌ exit 2");
  });

  it("says so rather than showing an empty check line when there are no steps", () => {
    const outcome = verified({ verification: { outcome: "refused", reason: "no test script" } });
    expect(composePullRequest(outcome, CONTEXT).body).toContain(
      "_no verification steps were discovered_",
    );
  });

  it("says the triage assessment held when recon agreed", () => {
    expect(composePullRequest(verified(), CONTEXT).body).toContain("✅ Recon confirmed triage");
  });

  it("says on the page when recon disagreed, and collapses the detail", () => {
    // The calibration signal. Triage calls a ticket solvable without reading a
    // line of source; this is the only feedback that call ever gets. That it
    // happened stays visible; the correction itself is long and goes below.
    const outcome = verified({
      recon: {
        ...verified().recon,
        devLensAccurate: false,
        devLensCorrection: "the fault is in layout.tsx, not in the config",
      },
    });
    const { body } = composePullRequest(outcome, CONTEXT);
    expect(body).toContain("⚠️ **Recon disagreed with triage's read of this ticket**");
    expect(body).toContain("<summary>Where triage was wrong</summary>");
    expect(body).toContain("the fault is in layout.tsx, not in the config");
  });

  it("offers no correction section when recon agreed", () => {
    expect(composePullRequest(verified(), CONTEXT).body).not.toContain("Where triage was wrong");
  });

  it("suppresses a correction the model left behind after agreeing", () => {
    // The verdict decides, not the text. A model can set `devLensAccurate: true`
    // and still fill the correction field, and a section headed "where triage
    // was wrong" sitting under a tick saying triage was right is a page that
    // contradicts itself — with no way for the reader to tell which half to
    // believe.
    const outcome = verified({
      recon: { ...verified().recon, devLensAccurate: true, devLensCorrection: "left over" },
    });
    const { body } = composePullRequest(outcome, CONTEXT);
    expect(body).not.toContain("Where triage was wrong");
    expect(body).not.toContain("left over");
  });

  it("still says recon disagreed when it gave no correction", () => {
    const outcome = verified({
      recon: { ...verified().recon, devLensAccurate: false, devLensCorrection: "   " },
    });
    const { body } = composePullRequest(outcome, CONTEXT);
    expect(body).toContain("⚠️ **Recon disagreed");
    // And no empty widget for a correction that was never written.
    expect(body).not.toContain("Where triage was wrong");
  });

  it("names the round cap so the reader knows what undrafts it", () => {
    expect(composePullRequest(verified(), { ...CONTEXT, maxReviewRounds: 7 }).body).toContain(
      "at most 7 review rounds",
    );
  });

  it("collapses the fix pass's account of itself", () => {
    // Three blocks of this on the page is what made the first version
    // unreadable. Each is worth keeping and none is worth reading first.
    const outcome = verified({ fix: { ...verified().fix, summary: "a long account" } });
    const { body } = composePullRequest(outcome, CONTEXT);
    expect(body).toContain("<summary>What the fix pass says it did</summary>");
    expect(body).toContain("a long account");
  });

  it("puts a blank line inside the widget so markdown still renders", () => {
    // GitHub stops parsing markdown inside an HTML block until a blank line
    // reopens it. Without these the section renders as one run of literal text.
    const { body } = composePullRequest(verified(), CONTEXT);
    expect(body).toContain("</summary>\n\n");
    expect(body).toContain("\n\n</details>");
  });

  it("reports what the simplify pass changed", () => {
    expect(composePullRequest(verified(), CONTEXT).body).toContain(
      "<summary>What the simplify pass changed</summary>",
    );
  });

  it("reports a simplify pass that declined, rather than omitting it", () => {
    // "It looked and left it alone" and "it never ran" are different facts
    // about a diff a reviewer is about to read, and a missing section conflates
    // them.
    const outcome = verified({
      simplify: { changed: false, filesTouched: [], changes: [], declined: "nothing to remove" },
    });
    const { body } = composePullRequest(outcome, CONTEXT);
    expect(body).toContain("<summary>Why the simplify pass changed nothing</summary>");
    expect(body).toContain("nothing to remove");
  });

  it("surfaces the residual risk as its own section", () => {
    const outcome = verified({
      fix: { ...verified().fix, residualRisk: "the deployed path is untested" },
    });
    const { body } = composePullRequest(outcome, CONTEXT);
    expect(body).toContain("<summary>What a reviewer should check by hand</summary>");
    expect(body).toContain("the deployed path is untested");
  });

  it("omits the risk section entirely when there is no risk to report", () => {
    // An empty widget invites a click that returns nothing, and teaches the
    // reader that the widgets on this page are not worth opening.
    expect(composePullRequest(verified(), CONTEXT).body).not.toContain("check by hand");
  });

  it("leaves no gap where an omitted section used to be", () => {
    // Sections drop out — that is the whole point of `details` returning "" —
    // and a run of blank lines is the seam showing. Cosmetic, but the document
    // is arguing that it was assembled carefully.
    const { body } = composePullRequest(verified(), CONTEXT);
    expect(body).not.toContain("\n\n\n");
  });

  it("returns the same title composeTitle does", () => {
    expect(composePullRequest(verified(), CONTEXT).title).toBe(
      composeTitle(verified(), "SSX-3822"),
    );
  });

  it("says on the page when the new tests pass without the fix, and names them", () => {
    // The finding this whole check exists to surface, and it goes above the
    // fold rather than into a collapsed section: a reviewer who reads only the
    // green ticks would otherwise take a decorative test for a guard.
    const outcome = verified({
      failFirst: { outcome: "vacuous", tests: ["src/utils/tests/DateUtils.test.ts"] },
    });
    const { body } = composePullRequest(outcome, CONTEXT);
    expect(body).toContain("⚠️ **The new tests pass without the fix.**");
    expect(body).toContain("`src/utils/tests/DateUtils.test.ts`");
  });

  it("does not call the fix wrong when it says the test is", () => {
    // The two are separate findings and the wording has to keep them apart. A
    // vacuous test is a statement about the test; the fix may well be correct,
    // and a body that implies otherwise argues a reviewer out of a good change.
    const outcome = verified({
      failFirst: { outcome: "vacuous", tests: ["src/x.test.ts"] },
    });
    expect(composePullRequest(outcome, CONTEXT).body).toContain("The fix may still be right");
  });

  it("says nothing at all when the tests did fail without the fix", () => {
    // `guarded` is the weak verdict — a new test importing a new helper fails
    // against the base for the wrong reason — so rendering it beside the
    // verification ticks would claim more than the experiment established.
    const outcome = verified({
      failFirst: { outcome: "guarded", tests: ["src/x.test.ts"] },
    });
    expect(composePullRequest(outcome, CONTEXT).body).not.toContain("without the fix");
  });

  it("says nothing when the check was skipped or could not run", () => {
    for (const failFirst of [
      { outcome: "skipped", reason: "no tests changed" },
      { outcome: "inconclusive", reason: "could not write a tree" },
    ] as const) {
      expect(composePullRequest(verified({ failFirst }), CONTEXT).body).not.toContain(
        "without the fix",
      );
    }
  });
});
