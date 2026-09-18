/**
 * Each case here is written against a plausible wrong implementation, named in the case, rather
 * than a defect that happened — `KNOWN_DANGLING` in `docs-check.ts` is one such implementation,
 * written down, one file over.
 *
 * Exercised against synthetic budgets; only the two standing facts (the tree is inside its bands,
 * and the count matches `wc -w`) are asserted against the real documents.
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

/** Two documents standing in for the mandatory-reading path: `one.md` measures 500, `two.md` 1000. */
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

/** A document with everything anyone might argue should not count: frontmatter, a table, a fence. */
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
    // Pinned against both a literal and `wc -w` itself, so it can't drift from either.
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
    // A larger aggregate ceiling would be slack one file could be robbed to pay another with.
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
    // The anti-KNOWN_DANGLING assertion: unplug the floor and a ceiling alone keeps blessing
    // words already removed. Aggregate floor is 0 here so this is about the per-file band alone.
    const problems = budgetProblems(sizes(350, 1000), FAKE, 0);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("one.md is 350 words");
    expect(problems[0]).toContain("30 under");
    expect(problems[0]).toContain("Something was cut and the budget was not");
    expect(problems[0]).toContain("the next 160 words of growth are free");
  });

  it("reports the total when every individual file is inside its band", () => {
    // Both per-file floors are satisfied while 200 words erode from the path — only the aggregate floor catches this.
    const problems = budgetProblems(sizes(400, 900), FAKE, FAKE_FLOOR);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("the mandatory-reading path is 1300 words");
    expect(problems[0]).toContain("Something was cut and the budget was not");
  });

  it("catches words moved between two budgeted files, from both ends", () => {
    // A transfer between files leaves the total untouched, so only the per-file bands can catch it.
    const problems = budgetProblems(sizes(300, 1200), FAKE, FAKE_FLOOR);

    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("one.md is 300 words");
    expect(problems[0]).toContain("80 under");
    expect(problems[1]).toContain("two.md is 1200 words");
    expect(problems[1]).toContain("180 over");
  });

  it("reports the file and the total when a single cut is big enough to be both", () => {
    // Deliberately two messages, not one: both budgets have to move.
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
    // Unplugged: a reformat the parser doesn't match leaves `raisedCeilings` comparing against nothing, and every raise passes.
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
    // A bare file name is the form reached for to get past the check rather than to justify anything.
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
 * The first version of this baseline read `git show HEAD:...`, which on any CI ref is the working
 * tree comparing itself to itself and always passes; these assertions pin which revision is asked for.
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
    // Correct here (no prior ceiling exists yet) but the same silence also covers a rename.
    expect(
      raisedCeilings(parseBudgets(""), [{ path: "one.md", floor: 1, ceiling: 99_999 }]),
    ).toEqual([]);
  });

  it("catches a raise made earlier in a branch, which comparing to HEAD could not", () => {
    const raised: readonly Budget[] = [
      { path: "one.md", floor: 100, ceiling: 900 },
      ...FAKE.slice(1),
    ];

    // The tip against itself: always empty, always green.
    expect(raisedCeilings(parseBudgets(sourceFor(raised)), raised)).toEqual([]);

    // The tip against where the branch forked from.
    expect(raisedCeilings(parseBudgets(forkPoint), raised)).toEqual([
      { path: "one.md", from: 510, to: 900 },
    ]);
  });
});
