/**
 * The check that lets `CLAUDE.md` copy `FINISHING.md`'s checklist, and the
 * first test this command has ever had — `docs-check.ts` notes at its own
 * `expectSites` comment that the class fix "arrives with this file's first
 * test", and `PLAN.md` §13 records the gap.
 *
 * Every case here is written against a **plausible wrong implementation**
 * rather than against a defect that happened, because this guard has no
 * incident behind it yet. `PROVING.md`'s rule is that a guard is not shipped
 * until a test fails when it is unplugged, and the version that would pass
 * without the guard is named in each case below. Three of them are real
 * candidates rather than straw ones: each is what this module would look like
 * if written the obvious way, and two of the three are mistakes this repository
 * has already made somewhere else.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CHECKLIST_QUESTIONS,
  checklistHeadlines,
  flatten,
  pinnedProseProblems,
} from "./pinned-prose.ts";

const ROOT = new URL("../../", import.meta.url);

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8");
}

const FINISHING = read(".claude/skills/dev-house-rules/FINISHING.md");
const CLAUDE = read("CLAUDE.md");

/** A minimal `CLAUDE.md`-shaped document carrying the given lines. */
function claudeCarrying(lines: readonly string[]): string {
  return `# the-jira-police\n\n## The four questions\n\n${lines.join("\n")}\n`;
}

describe("the tree as it stands", () => {
  it("extracts exactly the declared number of questions from FINISHING.md", () => {
    expect(checklistHeadlines(FINISHING)).toHaveLength(CHECKLIST_QUESTIONS);
  });

  it("extracts the headline only, not the explanation that follows it", () => {
    // The fourth question contains a second bold run — "**This is the one that
    // gets skipped in silence**". A greedy `(.+)\*\*` swallows the sentence
    // between them, and the copy in CLAUDE.md then cannot possibly match.
    const [, , , fourth] = checklistHeadlines(FINISHING);
    expect(fourth).toBe("Did something get through that these rules do not cover?");
  });

  it("finds every question in the real CLAUDE.md", () => {
    expect(pinnedProseProblems(FINISHING, CLAUDE)).toEqual([]);
  });
});

describe("what it catches", () => {
  it("reports a question CLAUDE.md has dropped", () => {
    const [first, ...rest] = checklistHeadlines(FINISHING);
    const problems = pinnedProseProblems(FINISHING, claudeCarrying(rest));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(first);
  });

  it("reports every dropped question, not just the first", () => {
    expect(pinnedProseProblems(FINISHING, claudeCarrying([]))).toHaveLength(CHECKLIST_QUESTIONS);
  });

  it("reports the extractor going blind when the heading is renamed", () => {
    // Unplugged: derive the expected count from what was found instead of
    // declaring it. Renaming the heading then extracts nothing, compares
    // nothing, finds nothing wrong, and reports green for as long as it exists.
    // This is the exact failure `docs-check.ts` built `expectSites` against.
    const renamed = FINISHING.replace("## The checklist", "## The last four questions");
    const problems = pinnedProseProblems(renamed, CLAUDE);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("extracted 0");
  });

  it("reports a question added to FINISHING.md and not copied across", () => {
    const grown = FINISHING.replace(
      "**And the rules",
      "- [ ] **A fifth question nobody copied?** With its own trailing sentence.\n\n**And the rules",
    );
    const problems = pinnedProseProblems(grown, CLAUDE);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`expected ${CHECKLIST_QUESTIONS} question(s), extracted 5`);
  });
});

describe("what it must not report", () => {
  it("accepts a copy the formatter has reflowed", () => {
    // Unplugged: compare with a plain `claude.includes(headline)`. `oxfmt`
    // reflows Markdown prose, so the wrap position in CLAUDE.md is the
    // formatter's to choose and not a fact about the copy. A literal comparison
    // turns the next `pnpm format` into a failing docs:check — which is how
    // this same command lost half its count coverage twice.
    const wrapped = checklistHeadlines(FINISHING).map((headline) => {
      const words = headline.split(" ");
      const half = Math.ceil(words.length / 2);
      return `- [ ] **${words.slice(0, half).join(" ")}\n      ${words.slice(half).join(" ")}**`;
    });

    expect(pinnedProseProblems(FINISHING, claudeCarrying(wrapped))).toEqual([]);
  });

  it("accepts a copy inside a blockquote", () => {
    const quoted = checklistHeadlines(FINISHING).map((headline) => `> ${headline}`);

    expect(pinnedProseProblems(FINISHING, claudeCarrying(quoted))).toEqual([]);
  });

  it("pins the words and not the formatting", () => {
    // Bold and the checkbox are presentation. Pinning them makes the check fail
    // on changes that are not drift, and a guard that cries wolf gets deleted.
    const plain = checklistHeadlines(FINISHING);

    expect(pinnedProseProblems(FINISHING, claudeCarrying(plain))).toEqual([]);
  });
});

describe("flatten", () => {
  it("joins a line the formatter wrapped", () => {
    expect(flatten("one two\n      three")).toBe("one two three");
  });

  it("joins a wrap that a blockquote marked as a continuation", () => {
    expect(flatten("one two\n> three")).toBe("one two three");
  });
});
