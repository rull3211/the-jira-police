import { describe, expect, it } from "vitest";

import type { SolveOutcome } from "./orchestrator.ts";
import { asProse, composePullRequest, composeTitle, withoutTrailer } from "./pr-text.ts";

type Verified = Extract<SolveOutcome, { kind: "verified" }>;

/** A `verified` outcome, built by hand so each assertion's dependency on a field stays visible. */
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
    bumps: [],
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
    // GitHub renders a single newline as a line break, so a git-wrapped body would arrive broken.
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
    // Ticket text is attacker-controlled; a forged heading could read as a harness verdict.
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
    // Escaping only the opening paragraph would let a forgery move down one blank line.
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
    // Markdown doesn't escape `<` with a backslash; that would render literally and leave the tag live.
    expect(asProse("<img src=x onerror=alert(1)>")).toBe("&lt;img src=x onerror=alert(1)>");
  });

  it("escapes a backslash before adding any of its own", () => {
    // Order matters: an existing backslash could otherwise cancel a later escape.
    expect(asProse("a \\ b")).toBe("a \\\\ b");
  });

  it("leaves emphasis and snake_case alone", () => {
    // Emphasis is cosmetic and can't forge structure; escaping it would mangle every identifier.
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
    // The subject is what was actually done; the summary is what was hoped for.
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
    expect(composePullRequest(verified(), CONTEXT).body).toContain(
      "The model was never asked whether they passed",
    );
  });

  it("shows the exit code only for a step that failed", () => {
    // Unreachable from a `verified` outcome today; guards against ever showing a non-zero exit as a pass.
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
    // The verdict field decides, not the text — a model can set devLensAccurate: true and still fill the correction.
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
    // No empty widget for a correction that was never written.
    expect(body).not.toContain("Where triage was wrong");
  });

  it("names the round cap so the reader knows what undrafts it", () => {
    expect(composePullRequest(verified(), { ...CONTEXT, maxReviewRounds: 7 }).body).toContain(
      "at most 7 review rounds",
    );
  });

  it("collapses the fix pass's account of itself", () => {
    const outcome = verified({ fix: { ...verified().fix, summary: "a long account" } });
    const { body } = composePullRequest(outcome, CONTEXT);
    expect(body).toContain("<summary>What the fix pass says it did</summary>");
    expect(body).toContain("a long account");
  });

  it("puts a blank line inside the widget so markdown still renders", () => {
    // GitHub stops parsing markdown inside an HTML block until a blank line reopens it.
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
    // "It looked and left it alone" and "it never ran" are different facts a missing section would conflate.
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
    expect(composePullRequest(verified(), CONTEXT).body).not.toContain("check by hand");
  });

  it("leaves no gap where an omitted section used to be", () => {
    const { body } = composePullRequest(verified(), CONTEXT);
    expect(body).not.toContain("\n\n\n");
  });

  it("returns the same title composeTitle does", () => {
    expect(composePullRequest(verified(), CONTEXT).title).toBe(
      composeTitle(verified(), "SSX-3822"),
    );
  });

  it("says on the page when the new tests pass without the fix, and names them", () => {
    // Above the fold, not collapsed: a reviewer reading only green ticks could mistake a decorative test for a guard.
    const outcome = verified({
      failFirst: { outcome: "vacuous", tests: ["src/utils/tests/DateUtils.test.ts"] },
    });
    const { body } = composePullRequest(outcome, CONTEXT);
    expect(body).toContain("⚠️ **The new tests pass without the fix.**");
    expect(body).toContain("`src/utils/tests/DateUtils.test.ts`");
  });

  it("does not call the fix wrong when it says the test is", () => {
    // A vacuous test is a statement about the test, not the fix, which may well be correct.
    const outcome = verified({
      failFirst: { outcome: "vacuous", tests: ["src/x.test.ts"] },
    });
    expect(composePullRequest(outcome, CONTEXT).body).toContain("The fix may still be right");
  });

  it("says nothing at all when the tests did fail without the fix", () => {
    // `guarded` is the weak verdict; rendering it beside the ticks would claim more than was established.
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

/** A verified outcome a promoted repair round produced: `commit` is the repair's, on top of the fix. */
function repaired(overrides: Partial<Verified> = {}): Verified {
  const base = verified();
  return verified({
    commit: {
      subject: "test(advisor): restore the premise the favicon test was written against",
      body: "The stub only the old behaviour reached was stranded.\n\nRefs: SSX-3822",
    },
    repair: {
      ...base.fix,
      filesTouched: ["src/app/layout.test.tsx"],
      summary: "Set up the environment the test names instead of relying on the default.",
      commitSubject: "test(advisor): restore the premise the favicon test was written against",
      commitBody: "The stub only the old behaviour reached was stranded.",
      residualRisk: "This edits a test the fix made fail.",
    },
    repairedFailure: "test did not pass (exit 1)",
    ...overrides,
  });
}

describe("composePullRequest, for a change a repair round finished", () => {
  it("warns second on the page, directly under the bot line and above any model prose", () => {
    // The only slot above the fold that is not the model's: green checks beside a plausible diff
    // are where a reviewer is weakest, and this is the diff most likely to be both.
    const [, second = ""] = composePullRequest(repaired(), CONTEXT).body.split("\n\n");
    expect(second).toContain("repair");
    expect(second).toContain("second commit");
  });

  it("names the failure the fix alone hit, and the weakened-test shape to look for", () => {
    const [, second = ""] = composePullRequest(repaired(), CONTEXT).body.split("\n\n");
    expect(second).toContain("test did not pass (exit 1)");
    expect(second).toContain("assertion");
  });

  it("neutralises the failure reason, which quotes a tool's output", () => {
    const outcome = repaired({ repairedFailure: "test failed: see [here](https://evil.example)" });
    expect(composePullRequest(outcome, CONTEXT).body).not.toContain("[here](");
  });

  it("titles and describes the pull request by the fix, not by the repair committed on top", () => {
    // `commit` is what `publish` commits next, which on this path is the repair; the pull request
    // is still the fix, and a title naming only the correction would hide what it corrects.
    const outcome = repaired();
    const { title, body } = composePullRequest(outcome, CONTEXT);
    expect(title).toBe(`${outcome.fix.commitSubject} (SSX-3822)`);
    expect(composeTitle(outcome, "SSX-3822")).toBe(title);
    expect(body.split("\n\n")).toContain("body");
    expect(body).not.toContain("The stub only the old behaviour reached");
  });

  it("collapses the repair pass's account and its risk under headings naming that pass", () => {
    const { body } = composePullRequest(repaired(), CONTEXT);
    expect(body).toContain("<summary>What the repair pass says it did</summary>");
    expect(body).toContain("Set up the environment the test names");
    expect(body).toContain("<summary>What a reviewer should check about the repair</summary>");
    expect(body).toContain("This edits a test the fix made fail.");
  });

  it("says nothing about a repair on an ordinary solve", () => {
    expect(composePullRequest(verified(), CONTEXT).body).not.toMatch(/repair/iu);
  });
});

describe("composePullRequest, for a change that moves a dependency version", () => {
  const bump = {
    path: "pom.xml",
    line: 33,
    property: "lisa-services-api.version",
    dependencies: ["storebrand.lisa.services:lisa-services-api"],
    from: "3.181",
    to: "3.203",
  };

  it("names each bump second on the page, above any model prose", () => {
    const [, second = ""] = composePullRequest(verified({ bumps: [bump] }), CONTEXT).body.split(
      "\n\n",
    );
    expect(second).toContain("moves a dependency version");
    expect(second).toContain("read none of the releases in between");
  });

  it("says which version moved, from what, to what, and for which dependency", () => {
    const { body } = composePullRequest(verified({ bumps: [bump] }), CONTEXT);
    expect(body).toContain(
      "- `lisa-services-api.version` `3.181` → `3.203` in `pom.xml`, for `storebrand.lisa.services:lisa-services-api`",
    );
  });

  it("marks a literal version as one", () => {
    const { body } = composePullRequest(
      verified({
        bumps: [{ ...bump, property: null, dependencies: ["org.mockito:mockito-core"] }],
      }),
      CONTEXT,
    );
    expect(body).toContain("- `<version>` `3.181` → `3.203`");
  });

  it("keeps a coordinate from closing its code span", () => {
    const { body } = composePullRequest(
      verified({ bumps: [{ ...bump, dependencies: ["g:a` [x](https://evil.example) `"] }] }),
      CONTEXT,
    );
    expect(body).toContain("`g:a [x](https://evil.example) `");
  });

  it("says nothing about dependencies on a change that moved none", () => {
    expect(composePullRequest(verified(), CONTEXT).body).not.toContain("dependency version");
  });
});
