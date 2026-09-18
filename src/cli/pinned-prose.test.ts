/**
 * The check that lets `CLAUDE.md` copy `FINISHING.md`'s checklist (`PLAN.md` §13).
 *
 * Each case is written against a plausible wrong implementation, named in the case, rather than a
 * defect that happened — several are mistakes this repository has already made elsewhere.
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
    // The fourth question has a second bold run after it; a greedy `(.+)\*\*` would swallow both.
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
    // Unplugged (deriving the expected count instead of declaring it): renaming the heading extracts nothing and reports green.
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
    // Unplugged (a literal `claude.includes(headline)`): the next `pnpm format` would fail docs:check.
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
    // Bold and the checkbox are presentation; pinning them would fail on changes that are not drift.
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
