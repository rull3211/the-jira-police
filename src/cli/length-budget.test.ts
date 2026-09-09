/**
 * The word budget, and the four properties that separate it from a number
 * somebody wrote down once.
 *
 * This guard has no incident of its own — it exists because of a *class* of
 * incident, a corpus that tripled while every check stayed green — so, as in
 * `pinned-prose.test.ts`, each case is written against the plausible wrong
 * implementation rather than against a defect that happened, and the version
 * that would pass without the guard is named in the case. The wrong
 * implementation is not hypothetical here: `KNOWN_DANGLING` in `docs-check.ts`
 * is it, written down, one file over.
 *
 * The mechanics are exercised against **synthetic budgets** and only the two
 * standing facts — that the tree is inside its bands, and that the count is
 * `wc -w` — are asserted against the real documents. A test that has to be
 * rewritten every time a sentence is cut is a test that gets rewritten until it
 * asserts nothing.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import {
  AGGREGATE_FLOOR,
  aggregateCeiling,
  type Budget,
  BUDGETS,
  budgetProblems,
  countWords,
  parseBudgets,
  raisedCeilings,
  raiseNotice,
  ratchetProblems,
  resolveBaseline,
  unresolvedBaselineProblem,
} from "./length-budget.ts";

const ROOT = new URL("../../", import.meta.url);

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8");
}

function wordsByWc(path: string): number {
  const out = execFileSync("wc", ["-w", path], { encoding: "utf8" });
  return Number(out.trim().split(/\s+/)[0]);
}

/**
 * Two documents standing in for the mandatory-reading path, shaped like it:
 * bands of `measured - 120` to `measured + 2%`, and an aggregate floor of the
 * measured total less one band. `one.md` measures 500 and `two.md` 1000.
 */
const FAKE: readonly Budget[] = [
  { path: "one.md", floor: 380, ceiling: 510 },
  { path: "two.md", floor: 880, ceiling: 1020 },
];
const FAKE_FLOOR = 1380;

function sizes(one: number, two: number): Map<string, number> {
  return new Map([
    ["one.md", one],
    ["two.md", two],
  ]);
}

/**
 * A document with everything anyone might argue should not count: frontmatter,
 * a table, a fenced block, and a paragraph the formatter hard-wrapped.
 */
const FIXTURE = [
  "---",
  "title: A budgeted document",
  "tags: [one, two]",
  "---",
  "",
  "# Heading",
  "",
  "A hard-wrapped paragraph that the formatter broke",
  "across two lines, because oxfmt reflows prose.",
  "",
  "| column | meaning        |",
  "| ------ | -------------- |",
  "| `path` | where it lives |",
  "",
  "```ts",
  "const answer = 42;",
  "```",
  "",
  "Done.",
  "",
].join("\n");

describe("the number everyone will argue about", () => {
  it("counts frontmatter, table pipes and fence contents, exactly like wc -w", () => {
    // Pinned twice on purpose: against a literal, so the definition cannot be
    // quietly reinterpreted, and against `wc -w` itself, so it cannot drift
    // from the command every reader will check it with. An implementation that
    // skipped frontmatter or fences would still be self-consistent — and every
    // word it stopped counting is still a word an agent has to read.
    const path = join(mkdtempSync(join(tmpdir(), "length-budget-")), "fixture.md");
    writeFileSync(path, FIXTURE);

    expect(countWords(FIXTURE)).toBe(49);
    expect(countWords(FIXTURE)).toBe(wordsByWc(path));
  });

  it("agrees with wc -w on every budgeted file", () => {
    for (const budget of BUDGETS) {
      const path = fileURLToPath(new URL(budget.path, ROOT));
      expect({ file: budget.path, words: countWords(read(budget.path)) }).toEqual({
        file: budget.path,
        words: wordsByWc(path),
      });
    }
  });
});

describe("the tree as it stands", () => {
  it("is inside every band, because the bands were read off the cut", () => {
    expect(budgetProblems(new Map(BUDGETS.map((b) => [b.path, countWords(read(b.path))])))).toEqual(
      [],
    );
  });

  it("has individual ceilings that sum to the aggregate ceiling", () => {
    // Not decoration. Any larger aggregate ceiling is slack layered on top of
    // the per-file bands, and slack is how one file gets robbed to pay another
    // with the total still green.
    expect(aggregateCeiling()).toBe(BUDGETS.reduce((total, b) => total + b.ceiling, 0));
    expect(AGGREGATE_FLOOR).toBeLessThan(aggregateCeiling());
  });
});

describe("what it catches", () => {
  it("reports a file over its ceiling, with both bounds and the delta", () => {
    const problems = budgetProblems(sizes(560, 940), FAKE, FAKE_FLOOR);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("one.md is 560 words");
    expect(problems[0]).toContain("380-510");
    expect(problems[0]).toContain("50 over");
    expect(problems[0]).toContain("not a target to grow into");
    expect(problems[0]).toContain("DOCS_CHECK_RAISE_BUDGET=one.md:<reason>");
  });

  it("the budget must be lowered when the file shrinks", () => {
    // The anti-KNOWN_DANGLING assertion, and the first one someone will delete
    // when it is inconvenient. Unplugged: make this a ceiling instead of a
    // band. It passes on the day of the cut and every day after, the budget
    // goes on blessing words that were already removed, and the next several
    // hundred words of growth are free. That is not hypothetical — it is
    // `KNOWN_DANGLING`, which argues for exactly this in its own docstring,
    // implements the ceiling half, and has not moved since it was written.
    //
    // The aggregate is switched off here (floor 0) so the assertion is about
    // the per-file band alone; the two firing together has its own case below.
    const problems = budgetProblems(sizes(350, 1000), FAKE, 0);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("one.md is 350 words");
    expect(problems[0]).toContain("30 under");
    expect(problems[0]).toContain("Something was cut and the budget was not");
    expect(problems[0]).toContain("the next 160 words of growth are free");
  });

  it("reports the total when every individual file is inside its band", () => {
    // Both files lose 100 words. Both bands are satisfied — the per-file floors
    // sum to 1260, well under the total's 1380 — and 200 words have gone from
    // the path an agent must read with nothing per-file to see it. This is the
    // erosion only the aggregate catches, and the reason it carries a floor of
    // its own rather than the sum of the parts.
    const problems = budgetProblems(sizes(400, 900), FAKE, FAKE_FLOOR);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("the mandatory-reading path is 1300 words");
    expect(problems[0]).toContain("Something was cut and the budget was not");
  });

  it("catches words moved between two budgeted files, from both ends", () => {
    // The other half of that argument. A 200-word transfer leaves the total
    // untouched, so the aggregate cannot see it and the per-file bands must —
    // which is why the ceilings sum exactly rather than the total being a
    // second, looser opinion.
    const problems = budgetProblems(sizes(300, 1200), FAKE, FAKE_FLOOR);

    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("one.md is 300 words");
    expect(problems[0]).toContain("80 under");
    expect(problems[1]).toContain("two.md is 1200 words");
    expect(problems[1]).toContain("180 over");
  });

  it("reports the file and the total when a single cut is big enough to be both", () => {
    // Deliberately two messages and not one. A file 30 words under its floor
    // puts the total 30 under its own, because the bands are the same width;
    // both statements are true and both budgets have to move.
    const problems = budgetProblems(sizes(350, 1000), FAKE, FAKE_FLOOR);

    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("one.md");
    expect(problems[1]).toContain("the mandatory-reading path");
  });

  it("reports a budgeted file it could not measure, rather than passing", () => {
    const problems = budgetProblems(new Map([["two.md", 1000]]), FAKE, FAKE_FLOOR);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("one.md is budgeted and was not measured");
  });
});

describe("a ceiling can only be lowered", () => {
  const committed = `export const BUDGETS: readonly Budget[] = [
  { path: "one.md", floor: 380, ceiling: 510 },
  { path: "two.md", floor: 880, ceiling: 1020 },
];`;

  const raised: readonly Budget[] = [
    { path: "one.md", floor: 380, ceiling: 570 },
    ...FAKE.slice(1),
  ];

  it("reads its own source, so the ratchet cannot go quiet on a reformat", () => {
    // Unplugged: the whole mechanism reads the committed file as *text*. Put
    // the entries in a shape the parser does not match — a reformat, a helper,
    // a spread — and `raisedCeilings` compares against nothing, every raise is
    // allowed, and the check reports green forever. That is the fail-open the
    // rest of docs:check is built against, and this is what turns it red.
    expect(parseBudgets(read("src/cli/length-budget.ts"))).toEqual([...BUDGETS]);
  });

  it("parses a committed source that says nothing as no budgets at all", () => {
    expect(parseBudgets("")).toEqual([]);
  });

  it("fails when a working-tree ceiling is above the committed one", () => {
    const raises = raisedCeilings(parseBudgets(committed), raised);
    expect(raises).toEqual([{ path: "one.md", from: 510, to: 570 }]);

    const problems = ratchetProblems(raises, undefined);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("the budget ceiling is 570 here and 510 in git");
    expect(problems[0]).toContain("A ceiling can only be lowered");
    expect(problems[0]).toContain("DOCS_CHECK_RAISE_BUDGET=one.md:<reason>");
  });

  it("passes with the override, and prints the reason in full", () => {
    const raises = raisedCeilings(parseBudgets(committed), raised);
    const override = "one.md:the second non-advisory rule grew a paragraph, agreed in #33";

    expect(ratchetProblems(raises, override)).toEqual([]);
    expect(raiseNotice(raises, override) ?? "").toContain("BUDGET RAISED one.md 510 -> 570");
    expect(raiseNotice(raises, override) ?? "").toContain(
      "the second non-advisory rule grew a paragraph, agreed in #33",
    );
  });

  it("does not excuse a raise the override does not name", () => {
    const raises = raisedCeilings(parseBudgets(committed), raised);

    expect(ratchetProblems(raises, "two.md:cutting one.md instead")).toHaveLength(1);
    expect(raiseNotice(raises, "two.md:cutting one.md instead")).toBeNull();
  });

  it("does not accept an override with no reason", () => {
    // A bare file name is the form somebody reaches for when the point is to
    // get past the check rather than to justify anything, and it is the form
    // that leaves a log nobody can read afterwards.
    const raises = raisedCeilings(parseBudgets(committed), raised);

    expect(ratchetProblems(raises, "one.md")).toHaveLength(1);
    expect(ratchetProblems(raises, "one.md:")).toHaveLength(1);
    expect(ratchetProblems(raises, "one.md:   ")).toHaveLength(1);
  });

  it("allows lowering a ceiling, and budgeting a file that had none", () => {
    const lowered: readonly Budget[] = [
      { path: "one.md", floor: 380, ceiling: 450 },
      ...FAKE.slice(1),
    ];
    expect(raisedCeilings(parseBudgets(committed), lowered)).toEqual([]);

    const added: readonly Budget[] = [...lowered, { path: "NEW.md", floor: 100, ceiling: 200 }];
    expect(raisedCeilings(parseBudgets(committed), added)).toEqual([]);
  });

  it("says nothing when no ceiling moved, override or not", () => {
    const raises = raisedCeilings(parseBudgets(committed), FAKE);

    expect(raises).toEqual([]);
    expect(ratchetProblems(raises, "one.md:unused")).toEqual([]);
    expect(raiseNotice(raises, "one.md:unused")).toBeNull();
  });
});

/**
 * The ratchet's baseline, which an audit caught comparing a file to itself.
 *
 * The first version read `git show HEAD:...`. On any ref CI checks out the
 * working tree *is* `HEAD`, so it compared the file to itself, returned no
 * raises, and passed — the whole argument for why this file is not
 * `KNOWN_DANGLING`, inert on the only ref that matters. These assertions are
 * about which revision is asked for, because that is the entire defect: the
 * comparison was always correct and was always handed the wrong input.
 */
/** A committed `length-budget.ts`, in the shape `parseBudgets` reads. */
const sourceFor = (budgets: readonly Budget[]): string =>
  `export const BUDGETS: readonly Budget[] = [\n${budgets
    .map((b) => `  { path: "${b.path}", floor: ${b.floor}, ceiling: ${b.ceiling} },`)
    .join("\n")}\n];`;

describe("the baseline the ceiling is judged against", () => {
  const forkPoint = sourceFor(FAKE);

  const calls: string[][] = [];
  const recording =
    (reply: (args: readonly string[]) => string | null) => (args: readonly string[]) => {
      calls.push([...args]);
      return reply(args);
    };

  beforeEach(() => {
    calls.length = 0;
  });

  it("asks for the fork point, and never for HEAD alone", () => {
    const baseline = resolveBaseline(recording(() => "abc1234\n"));

    expect(baseline).toEqual({ rev: "abc1234", describedAs: "merge-base with origin/main" });
    expect(calls).toEqual([["merge-base", "HEAD", "origin/main"]]);
    expect(calls.flat()).not.toContain("HEAD:src/cli/length-budget.ts");
  });

  it("prefers the remote default branch to a local one that may lag it", () => {
    const baseline = resolveBaseline(
      recording((args) => (args.includes("origin/main") ? null : "def5678\n")),
    );

    expect(baseline?.describedAs).toBe("merge-base with main");
    expect(calls).toEqual([
      ["merge-base", "HEAD", "origin/main"],
      ["merge-base", "HEAD", "main"],
    ]);
  });

  it("reports that it is not enforced rather than returning no raises", () => {
    expect(resolveBaseline(() => null)).toBeNull();
    expect(unresolvedBaselineProblem()).toContain("no baseline");
    expect(unresolvedBaselineProblem()).toContain("is NOT enforced this run");
  });

  it("treats an empty reply as unresolved, not as a revision named nothing", () => {
    expect(resolveBaseline(() => "\n")).toBeNull();
  });

  it("permits everything when the baseline predates this file, which is this branch", () => {
    // Not a bug and not a pass: `git show <base>:src/cli/length-budget.ts` fails
    // on the branch that adds the file, so there is no prior ceiling and the
    // ratchet is inert until this lands on the default branch. Pinned because
    // the same silence covers a rename, which would reset every ceiling.
    expect(
      raisedCeilings(parseBudgets(""), [{ path: "one.md", floor: 1, ceiling: 99_999 }]),
    ).toEqual([]);
  });

  it("catches a raise made earlier in a branch, which comparing to HEAD could not", () => {
    const raised: readonly Budget[] = [
      { path: "one.md", floor: 100, ceiling: 900 },
      ...FAKE.slice(1),
    ];

    // What the old wiring did: the tip against itself. Always empty, always green.
    expect(raisedCeilings(parseBudgets(sourceFor(raised)), raised)).toEqual([]);

    // What it does now: the tip against where the branch forked from.
    expect(raisedCeilings(parseBudgets(forkPoint), raised)).toEqual([
      { path: "one.md", from: 510, to: 900 },
    ]);
  });
});
