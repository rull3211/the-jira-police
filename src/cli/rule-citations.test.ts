import { describe, expect, it } from "vitest";

import {
  CITING_FILES,
  citedSlugs,
  GAP_WINDOW,
  incidentAddedArgs,
  incidentEntries,
  maskFences,
  median,
  PHASE_FILES,
  RULE_PARAGRAPHS,
  ruleCitationProblems,
  type RuleCitationInput,
  ruleCitedArgs,
  ruleParagraphs,
  UNRESOLVED_ON_PURPOSE,
} from "./rule-citations.ts";

const INCIDENTS = ".claude/skills/dev-house-rules/INCIDENTS.md";
const STARTING = ".claude/skills/dev-house-rules/STARTING.md";

/**
 * A stand-in for `docs-check.ts`'s `slugOf`, which is injected in production
 * precisely so there is one implementation of GitHub's anchor rule. It is not
 * copied here — these fixtures only need slugging to be *consistent*, and a
 * faithful copy in the test would be the second home this whole check exists to
 * catch.
 */
function slugOf(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replaceAll(/[^\w\s-]/gu, "")
    .replaceAll(/\s/gu, "-");
}

interface Fixture {
  /** Bodies by repository-relative path; the rest of `CITING_FILES` is empty. */
  readonly files?: Readonly<Record<string, string>>;
  readonly incidents?: string;
  readonly today?: string;
  readonly population?: Readonly<Record<string, number>>;
  readonly unresolvedOnPurpose?: number;
  readonly authoringGaps?: readonly number[];
}

/**
 * Builds an input whose pins agree with the fixture, so every test below
 * isolates the one thing it is about.
 *
 * Deriving the population here is safe only because one test overrides it with
 * a wrong value: that is where the pin is exercised, and without it this helper
 * would be quietly disabling the check it is setting up.
 */
function fixture(over: Fixture = {}): RuleCitationInput {
  const bodies = over.files ?? {};
  const citing = CITING_FILES.map((path) => ({ path, body: bodies[path] ?? "" }));
  const incidents = over.incidents ?? "";

  const derived: Record<string, number> = {};
  for (const path of PHASE_FILES) {
    derived[path] = ruleParagraphs(path, bodies[path] ?? "").length;
  }

  return {
    incidentsPath: INCIDENTS,
    incidents,
    citing,
    slugOf,
    today: new Date(over.today ?? "2026-09-09T12:00:00Z"),
    population: over.population ?? derived,
    unresolvedOnPurpose:
      over.unresolvedOnPurpose ??
      incidentEntries(incidents, slugOf).filter((entry) => entry.unresolved !== null).length,
    ...(over.authoringGaps === undefined ? {} : { authoringGaps: over.authoringGaps }),
  };
}

/** `**No rule yet** — …, and <date>.`, wrapped the way the formatter wraps it. */
function dated(on: string): string {
  return [
    "# Incidents",
    "",
    "### The silent guard",
    "",
    "**No rule yet** — the second instance would say whether this is craft or coincidence,",
    `and ${on}.`,
  ].join("\n");
}

/** An entry declaring itself unresolved until `denylist` reaches two instances. */
function declaration(title: string): string[] {
  return [
    `### ${title}`,
    "",
    "**No rule yet** — inverting a denylist needs a second instance to be worth a rule,",
    "and `denylist` at 2.",
    "",
  ];
}

/** Problems naming a file, so a test can say what it is *not* complaining about. */
function about(problems: readonly string[], needle: string): string[] {
  return problems.filter((problem) => problem.includes(needle));
}

describe("ruleParagraphs", () => {
  it("takes a bold sentence at column zero, and the citation after the blank line", () => {
    const rules = ruleParagraphs(
      STARTING,
      [
        "## A section",
        "",
        "**Run it before you believe it.** A green suite is a statement about the tests.",
        "",
        "[→](INCIDENTS.md#the-fail-first-replay)",
      ].join("\n"),
    );

    expect(rules).toHaveLength(1);
    expect(rules[0]?.headline).toBe("Run it before you believe it.");
    expect(rules[0]?.line).toBe(3);
    expect(rules[0]?.scope).toContain("#the-fail-first-replay");
  });

  it("reads a headline that wraps, because the formatter decides where it wraps", () => {
    const rules = ruleParagraphs(
      STARTING,
      [
        "**Structural facts — the module map, the entry points — belong in",
        "ARCHITECTURE.md.** Cite it.",
      ].join("\n"),
    );

    expect(rules).toHaveLength(1);
    expect(rules[0]?.headline).toBe(
      "Structural facts — the module map, the entry points — belong in ARCHITECTURE.md.",
    );
  });

  it("does not credit one rule's citation to the rule above it", () => {
    // Two rules back to back. If the second paragraph counted as the first
    // one's scope, the reported count of paragraphs citing nothing would be one
    // lower than the corpus is.
    const rules = ruleParagraphs(
      STARTING,
      [
        "**The uncited one.** No evidence named.",
        "",
        "**The cited one.** Evidence named.",
        "[→](INCIDENTS.md#the-fail-first-replay)",
      ].join("\n"),
    );

    expect(rules).toHaveLength(2);
    expect(rules[0]?.scope).not.toContain("#the-fail-first-replay");
    expect(rules[1]?.scope).toContain("#the-fail-first-replay");
  });

  it("does not count bold that opens a list item", () => {
    // The noise assertion. FINISHING.md's eleven-item checklist and CLAUDE.md's
    // four pinned questions are all `- **…**`, and counting them would put
    // fifteen items into a population that is reported as rules. They are
    // excluded by the definition rather than by an exemption list, so a new
    // checklist needs no maintenance here.
    const rules = ruleParagraphs(
      STARTING,
      [
        "- **Is this in `PLAN.md`?** If it is not a one-line fix, write the entry first.",
        "- [ ] **Any comment near the change that is now true of something else?**",
        "  - **A nested one.** Also not a rule.",
      ].join("\n"),
    );

    expect(rules).toEqual([]);
  });

  it("does not count bold inside a fence or inside a table", () => {
    const rules = ruleParagraphs(
      STARTING,
      [
        "| defect | what caught it |",
        "| ------ | -------------- |",
        "| **The unref that killed the loop** | running it once |",
        "",
        // The blank line inside the fence matters: without it the sample is a
        // continuation of the ``` line and would be excluded by the
        // column-zero rule rather than by the masking, and the assertion would
        // be green whether or not fences are masked at all. It was, once.
        "```md",
        "A sample of how a rule is written:",
        "",
        "**A rule in a sample.** Quoted, not made.",
        "```",
        "",
        "~~~",
        "A second sample:",
        "",
        "**Another sample.** Also quoted.",
        "~~~",
      ].join("\n"),
    );

    expect(rules).toEqual([]);
  });
});

describe("maskFences", () => {
  it("blanks a fence without moving any line number after it", () => {
    const masked = maskFences(["one", "```", "**inside**", "```", "two"].join("\n"));

    expect(masked.split("\n")).toHaveLength(5);
    expect(masked).not.toContain("**inside**");
    expect(masked.split("\n")[4]).toBe("two");
  });

  it("does not let a shorter fence of another character close the block", () => {
    const masked = maskFences(
      ["````md", "~~~", "**inside**", "~~~", "````", "**after**"].join("\n"),
    );

    expect(masked).not.toContain("**inside**");
    expect(masked).toContain("**after**");
  });
});

describe("citedSlugs", () => {
  it("resolves the link against the citing document's own directory", () => {
    // CLAUDE.md writes the whole path and the phase files write the bare
    // filename. Both have to resolve to the same document, and a link into some
    // other repository's INCIDENTS.md has to resolve to neither.
    const fromRoot = citedSlugs(
      { path: "CLAUDE.md", body: "[→](.claude/skills/dev-house-rules/INCIDENTS.md#a-slug)" },
      INCIDENTS,
    );
    const fromPhase = citedSlugs({ path: STARTING, body: "[→](INCIDENTS.md#b-slug)" }, INCIDENTS);
    const elsewhere = citedSlugs(
      { path: "CLAUDE.md", body: "[→](docs/backlog-governance/INCIDENTS.md#c-slug)" },
      INCIDENTS,
    );

    expect([...fromRoot]).toEqual(["a-slug"]);
    expect([...fromPhase]).toEqual(["b-slug"]);
    expect([...elsewhere]).toEqual([]);
  });

  it("does not count a link with no anchor", () => {
    expect([
      ...citedSlugs({ path: STARTING, body: "Evidence: [INCIDENTS.md](INCIDENTS.md)" }, INCIDENTS),
    ]).toEqual([]);
  });
});

describe("ruleCitationProblems — every citation resolves", () => {
  const incidents = ["# Incidents", "", "### The fail first replay", "", "Text."].join("\n");

  it("passes a rule that cites an entry which exists", () => {
    const report = ruleCitationProblems(
      fixture({
        incidents,
        files: {
          [STARTING]: [
            "**Run it before you believe it.** A green suite is a statement about the tests.",
            "[→](INCIDENTS.md#the-fail-first-replay)",
          ].join("\n"),
        },
      }),
    );

    expect(report.problems).toEqual([]);
    expect(report.summary).toContain("1 entries, 1 cited");
  });

  it("counts a rule that cites nothing and does not fail on it", () => {
    // The direction this check does not have. "Every rule cites an incident" is
    // 41% true of the corpus, so the count is printed and nothing goes red —
    // and the count is the only evidence the extractor is still looking.
    const report = ruleCitationProblems(
      fixture({
        incidents,
        files: {
          [STARTING]: [
            "**Run it before you believe it.** No evidence named.",
            "",
            "**Nor does this one.** Also none.",
            "",
            "**This one names it.** [→](INCIDENTS.md#the-fail-first-replay)",
          ].join("\n"),
        },
      }),
    );

    expect(about(report.problems, STARTING)).toEqual([]);
    expect(report.summary).toContain(
      "3 rule paragraphs, 2 citing no incident (reported, not guarded)",
    );
  });

  it("reports the dead slug in a document that also cites a live one", () => {
    // The bug this replaced: the old check compared a rule's dangling links
    // against *all* of its links and said nothing unless every one was broken,
    // so a rule citing one real entry carried a broken sibling for free.
    const report = ruleCitationProblems(
      fixture({
        incidents,
        files: {
          [STARTING]: [
            "**Run it before you believe it.** Two citations, one of them wrong.",
            "[→](INCIDENTS.md#the-fail-first-replay); [→](INCIDENTS.md#a-story-nobody-wrote)",
          ].join("\n"),
        },
      }),
    );

    expect(about(report.problems, "which is not an entry there")).toHaveLength(1);
    expect(about(report.problems, "#a-story-nobody-wrote")).toHaveLength(1);
    expect(about(report.problems, "#the-fail-first-replay")).toEqual([]);
  });

  it("checks a citation in a table row, which no rule paragraph contains", () => {
    // 13 of the 69 citations in the tree are table rows and none of them opens
    // a rule paragraph, so a check scoped to rules inspects none of them. A
    // table is exactly where a retitled heading goes unnoticed: the row still
    // reads correctly.
    const report = ruleCitationProblems(
      fixture({
        incidents,
        files: {
          [".claude/skills/dev-house-rules/SKILL.md"]: [
            "| rule | evidence |",
            "| ---- | -------- |",
            "| Run it | [→](INCIDENTS.md#a-story-nobody-wrote) |",
          ].join("\n"),
        },
        unresolvedOnPurpose: 0,
      }),
    );

    expect(about(report.problems, "which is not an entry there")).toHaveLength(1);
    expect(about(report.problems, "SKILL.md cites")).toHaveLength(1);
  });
});

describe("ruleCitationProblems — incident to rule", () => {
  const entry = ["# Incidents", "", "### The silent guard", "", "Text."].join("\n");

  it("counts an entry cited only from outside CITING_FILES as uncited", () => {
    // The whole value of the list. claude-validation-work and scaffolding-audit
    // both link into INCIDENTS.md and are on no reading path; admitting them
    // turns entries green on a citation nobody is routed to.
    expect(CITING_FILES).not.toContain(".claude/skills/claude-validation-work/SKILL.md");
    expect(CITING_FILES).not.toContain(".claude/skills/scaffolding-audit/SKILL.md");

    const base = fixture({
      incidents: entry,
      files: { [STARTING]: "**A rule.** Citing nothing, which is not itself a failure." },
      unresolvedOnPurpose: 0,
    });

    // Handed to the check *and* citing the entry, and still it does not count:
    // the filter is against CITING_FILES, not against what the caller passed.
    // An exclusion a caller can undo with one more argument is not one.
    const report = ruleCitationProblems({
      ...base,
      citing: [
        ...base.citing,
        {
          path: ".claude/skills/scaffolding-audit/SKILL.md",
          body: "[→](../dev-house-rules/INCIDENTS.md#the-silent-guard)",
        },
      ],
    });

    expect(about(report.problems, "has produced no rule that cites it")).toHaveLength(1);
    expect(report.summary).toContain("1 entries, 0 cited");
  });

  it("fails when a citing document was not handed to the check at all", () => {
    const report = ruleCitationProblems({
      ...fixture({ incidents: entry, unresolvedOnPurpose: 0 }),
      citing: [{ path: STARTING, body: "" }],
    });

    expect(about(report.problems, "was not handed to the check")).toHaveLength(
      CITING_FILES.length - 1,
    );
  });

  it("fails a dated **No rule yet** once it is more than thirty days old", () => {
    const fresh = ruleCitationProblems(
      fixture({ incidents: dated("2026-09-01"), today: "2026-09-09T12:00:00Z" }),
    );
    const stale = ruleCitationProblems(
      fixture({ incidents: dated("2026-07-01"), today: "2026-09-09T12:00:00Z" }),
    );

    expect(fresh.problems).toEqual([]);
    expect(
      about(stale.problems, "has been waiting for a rule since 2026-07-01 — 70 days"),
    ).toHaveLength(1);
  });

  it("fails a counted **No rule yet** once that many entries share the tag", () => {
    // INCIDENTS.md already says this in prose — "at instance two, write it" —
    // about the entry that waited seven instances. This is the sentence with a
    // command behind it.
    const one = ruleCitationProblems(
      fixture({ incidents: ["# Incidents", "", ...declaration("The first")].join("\n") }),
    );
    const two = ruleCitationProblems(
      fixture({
        incidents: [
          "# Incidents",
          "",
          ...declaration("The first"),
          ...declaration("The second"),
        ].join("\n"),
      }),
    );

    expect(one.problems).toEqual([]);
    expect(
      about(two.problems, "waits for 2 instance(s) of `denylist`, and there are 2"),
    ).toHaveLength(2);
  });

  it("refuses a **No rule yet** line that does not parse", () => {
    const report = ruleCitationProblems(
      fixture({
        incidents: [
          "# Incidents",
          "",
          "### The silent guard",
          "",
          "**No rule yet** — nobody has written one.",
        ].join("\n"),
      }),
    );

    expect(about(report.problems, "does not parse")).toHaveLength(1);
  });

  it("refuses a declaration on an entry a rule already cites", () => {
    const report = ruleCitationProblems(
      fixture({
        incidents: [
          "# Incidents",
          "",
          "### The silent guard",
          "",
          "**No rule yet** — nothing has generalised it, and 2026-09-08.",
        ].join("\n"),
        files: { [STARTING]: "**A rule.** [→](INCIDENTS.md#the-silent-guard)" },
      }),
    );

    expect(about(report.problems, "says **No rule yet**, and a rule cites it")).toHaveLength(1);
  });

  it("fails in both directions when UNRESOLVED_ON_PURPOSE stops matching", () => {
    const incidents = [
      "# Incidents",
      "",
      "### The silent guard",
      "",
      "**No rule yet** — nothing has generalised it, and 2026-09-08.",
    ].join("\n");

    const tooHigh = ruleCitationProblems(fixture({ incidents, unresolvedOnPurpose: 4 }));
    const tooLow = ruleCitationProblems(fixture({ incidents, unresolvedOnPurpose: 0 }));

    expect(about(tooHigh.problems, "a declaration was removed")).toHaveLength(1);
    expect(about(tooLow.problems, "debt going up")).toHaveLength(1);
  });

  it("counts declarations written in the file, not entries nothing cites", () => {
    // The confusion that gave the constant its first value: it was set to the
    // number of uncited entries, on a tree carrying no declaration at all, and
    // the message printed was "some were paid" — nothing had ever been paid or
    // promised. Two orphans, no declarations, and the number says two.
    const report = ruleCitationProblems(
      fixture({
        incidents: [
          "# Incidents",
          "",
          "### The silent guard",
          "",
          "Text.",
          "",
          "### The second silent guard",
          "",
          "Text.",
        ].join("\n"),
        unresolvedOnPurpose: 2,
      }),
    );

    expect(about(report.problems, "has produced no rule that cites it")).toHaveLength(2);
    expect(about(report.problems, "0 written in")).toHaveLength(1);
    expect(about(report.problems, "never written")).toHaveLength(1);
    expect(about(report.problems, "a declaration was removed")).toEqual([]);
  });
});

describe("the pinned population", () => {
  it("fails when the population changes in either direction", () => {
    // The anti-silent-stop assertion. Every other check here is satisfiable by
    // an extractor that matches nothing; this is the one that is not.
    const body = ["**One rule.** Text.", "", "**Two rules.** Text."].join("\n");

    const grew = ruleCitationProblems(
      fixture({
        files: { [STARTING]: body },
        population: { [STARTING]: 1 },
        unresolvedOnPurpose: 0,
      }),
    );
    const shrank = ruleCitationProblems(
      fixture({
        files: { [STARTING]: body },
        population: { [STARTING]: 3 },
        unresolvedOnPurpose: 0,
      }),
    );

    expect(about(grew.problems, "says 1 rule paragraph(s), extracted 2")).toHaveLength(1);
    expect(about(shrank.problems, "says 3 rule paragraph(s), extracted 2")).toHaveLength(1);
    expect(about(shrank.problems, "can no longer see it")).toHaveLength(1);
  });

  it("pins every phase file and nothing else", () => {
    expect(Object.keys(RULE_PARAGRAPHS).toSorted()).toEqual([...PHASE_FILES].toSorted());
    expect(UNRESOLVED_ON_PURPOSE).toBeGreaterThanOrEqual(0);
  });
});

describe("the reported authoring gap", () => {
  it("takes the median of the most recent window and never fails on it", () => {
    // Rejected as a guard on purpose: an incident found this afternoon whose
    // rule is written this afternoon is the wanted behaviour, so the number is
    // not decidable at the moment it would fire.
    const gaps = Array.from({ length: GAP_WINDOW + 5 }, (_, index) =>
      index < GAP_WINDOW ? 10 : 9000,
    );
    const report = ruleCitationProblems(fixture({ authoringGaps: gaps, unresolvedOnPurpose: 0 }));

    expect(report.summary).toContain(`median authoring gap 10 min over the last ${GAP_WINDOW}`);
    expect(report.problems).toEqual([]);
  });

  it("says so rather than inventing a number when there is nothing to measure", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(ruleCitationProblems(fixture({ unresolvedOnPurpose: 0 })).summary).toContain(
      "authoring gap not measured",
    );
  });

  it("builds git arguments that pin the search to the right paths", () => {
    const entry = {
      line: 1,
      title: "The silent guard",
      slug: "the-silent-guard",
      unresolved: null,
    };

    expect(incidentAddedArgs(entry, INCIDENTS)).toEqual([
      "log",
      "--reverse",
      "--format=%ct",
      "-S### The silent guard",
      "--",
      INCIDENTS,
    ]);
    expect(ruleCitedArgs(entry, [STARTING])).toEqual([
      "log",
      "--reverse",
      "--format=%ct",
      "-S#the-silent-guard",
      "--",
      STARTING,
    ]);
  });
});
