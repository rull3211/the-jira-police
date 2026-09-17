import { describe, expect, it } from "vitest";

import { checkDiff, FORBIDDEN_PATHS, VERIFICATION_PATHS } from "../solve/diff-gate.ts";
import {
  refusalExamples,
  type RuleTable,
  type ScopeBoundsInput,
  scopeBoundsProblems,
} from "./scope-bounds.ts";

/**
 * A minimal document pair in the shape the real ones have, built once so a pinned-sentence change
 * fails in one place; the real pair is exercised separately below.
 */
function documents(options: {
  readonly examples?: readonly string[];
  readonly saysNeverBySize?: boolean;
  readonly skillSaysNeverBySize?: boolean;
  readonly openHeading?: string;
  readonly note?: string;
}): Pick<ScopeBoundsInput, "instructionsPath" | "instructions" | "skillPath" | "skill"> {
  const {
    examples = [".github/workflows/ci.yml"],
    saysNeverBySize = true,
    skillSaysNeverBySize = true,
    openHeading = "### What the gate refuses by path",
    note = "",
  } = options;

  const instructions = [
    "## 4. Scope bounds",
    "",
    saysNeverBySize ? "**The gate refuses by path, and never by size.**" : "Some other sentence.",
    "",
    openHeading,
    "",
    note,
    ...examples.map((example) => `- \`${example}\` — because`),
    "",
    "### The bounds that are not path rules",
    "",
    "- no binary files",
  ].join("\n");

  const skill = [
    "- **Stay inside the stated scope.** The harness refuses a list of paths outright.",
    skillSaysNeverBySize
      ? "  It does **not** refuse on size: there is no file cap and no line cap."
      : "  It refuses diffs over a small file and line cap.",
  ].join("\n");

  return {
    instructionsPath: ".claude/skills/agent-solve/SOLVE_INSTRUCTIONS.md",
    instructions,
    skillPath: ".claude/skills/agent-solve/SKILL.md",
    skill,
  };
}

const oneRule: readonly RuleTable[] = [
  {
    name: "FORBIDDEN_PATHS",
    rules: [{ pattern: /(^|\/)\.github(\/|$)/u, why: "CI privilege, not code" }],
  },
];

function run(
  options: Parameters<typeof documents>[0],
  tables: readonly RuleTable[] = oneRule,
  refusesBySize = false,
) {
  return scopeBoundsProblems({ ...documents(options), tables, refusesBySize });
}

describe("refusalExamples", () => {
  it("takes every backticked token in the enumerated section", () => {
    const { instructions } = documents({ examples: ["a/b.yml", "c.lock"] });
    expect(refusalExamples(instructions)).toEqual(["a/b.yml", "c.lock"]);
  });

  it("stops at the next heading rather than running to the end of the file", () => {
    const { instructions } = documents({ examples: ["a/b.yml"] });
    // `no binary files` lives under the following heading and is not a path.
    expect(refusalExamples(instructions)).not.toContain("no binary files");
  });

  it("ignores backticked names inside an HTML comment", () => {
    const note = "<!-- checked against `FORBIDDEN_PATHS` in `src/solve/diff-gate.ts` -->";
    const { instructions } = documents({ examples: ["a/b.yml"], note });
    expect(refusalExamples(instructions)).toEqual(["a/b.yml"]);
  });

  it("returns nothing when the opening heading was renamed", () => {
    const { instructions } = documents({ openHeading: "### Paths the gate refuses" });
    expect(refusalExamples(instructions)).toEqual([]);
  });
});

describe("scopeBoundsProblems", () => {
  it("passes a document whose examples and rules line up exactly", () => {
    expect(run({}).problems).toEqual([]);
  });

  /** The direction that costs work: the prose claims a refusal the gate does not make. */
  it("fails when the prose names a path no rule refuses", () => {
    const problems = run({
      examples: [".github/workflows/ci.yml", "deployment/manifestor.yaml"],
    }).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("deployment/manifestor.yaml");
    expect(problems[0]).toContain("no rule in FORBIDDEN_PATHS");
  });

  /** The quieter direction: a gate rule with no matching example means the solver is never told. */
  it("fails when a gate rule is matched by no example", () => {
    const twoRules: readonly RuleTable[] = [
      {
        name: "FORBIDDEN_PATHS",
        rules: [
          ...oneRule[0]!.rules,
          { pattern: /(^|\/)\.env($|\.)/u, why: "environment files hold credentials" },
        ],
      },
    ];
    const problems = run({}, twoRules).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("FORBIDDEN_PATHS[1]");
    expect(problems[0]).toContain("environment files hold credentials");
  });

  it("names the table a silently unexercised rule came from", () => {
    const tables: readonly RuleTable[] = [
      ...oneRule,
      {
        name: "VERIFICATION_PATHS",
        rules: [{ pattern: /(^|\/)package\.json$/u, why: "defines what passing means" }],
      },
    ];
    expect(run({}, tables).problems[0]).toContain("VERIFICATION_PATHS[0]");
  });

  /**
   * A missing section must not read as "nothing to check": it fails in its own right, and every
   * rule then reports as unexercised rather than passing vacuously.
   */
  it("fails loudly when the enumerated section cannot be found", () => {
    const problems = run({ openHeading: "### Paths the gate refuses" }).problems;
    expect(problems.length).toBeGreaterThanOrEqual(2);
    expect(problems.some((problem) => problem.includes("could not find the enumerated"))).toBe(
      true,
    );
    expect(problems.some((problem) => problem.includes("FORBIDDEN_PATHS[0]"))).toBe(true);
  });

  describe("the size sentence", () => {
    it("fails when the instructions stop saying the gate never refuses on size", () => {
      const problems = run({ saysNeverBySize: false }).problems;
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("SOLVE_INSTRUCTIONS.md");
      expect(problems[0]).toContain("no longer carries the");
    });

    it("fails when the skill summary stops saying it", () => {
      const problems = run({ skillSaysNeverBySize: false }).problems;
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("SKILL.md");
    });

    /**
     * `refusesBySize` is measured from `checkDiff`, so this is what `docs:check` reports the day a
     * cap comes back while the prose still denies one.
     */
    it("fails when a cap is reinstated and both documents still deny one", () => {
      const problems = run({}, oneRule, true).problems;
      expect(problems).toHaveLength(2);
      for (const problem of problems) {
        expect(problem).toContain("still");
      }
    });

    it("passes when a reinstated cap is reflected in both documents", () => {
      const problems = run(
        { saysNeverBySize: false, skillSaysNeverBySize: false },
        oneRule,
        true,
      ).problems;
      expect(problems).toEqual([]);
    });

    /** `oxfmt` reflows markdown, so a rewrapped pinned sentence is not a defect; both sides are flattened before comparison. */
    it("accepts the sentence rewrapped across a line break", () => {
      const base = documents({});
      const wrapped = base.instructions.replace(
        "**The gate refuses by path, and never by size.**",
        "**The gate refuses by path,\nand never by size.**",
      );
      const problems = scopeBoundsProblems({
        ...base,
        instructions: wrapped,
        tables: oneRule,
        refusesBySize: false,
      }).problems;
      expect(problems).toEqual([]);
    });
  });
});

/**
 * The real documents against the real gate — `docs:check` runs exactly this. Duplicated
 * deliberately: the fixtures above never read the shipped prose, so none would catch it drifting.
 */
describe("the shipped skill against the shipped gate", () => {
  it("refuses nothing on size, measured rather than read", () => {
    const huge = Array.from({ length: 500 }, (_, index) => ({
      path: `src/generated/module-${index}.ts`,
      added: 400,
      removed: 400,
    }));
    const verdict = checkDiff(huge);
    expect(verdict.ok).toBe(true);
  });

  it("covers every rule in both tables, in both directions", async () => {
    const { readFile } = await import("node:fs/promises");
    const root = new URL("../../", import.meta.url);
    const read = async (path: string) => readFile(new URL(path, root), "utf8");

    const result = scopeBoundsProblems({
      instructionsPath: ".claude/skills/agent-solve/SOLVE_INSTRUCTIONS.md",
      instructions: await read(".claude/skills/agent-solve/SOLVE_INSTRUCTIONS.md"),
      skillPath: ".claude/skills/agent-solve/SKILL.md",
      skill: await read(".claude/skills/agent-solve/SKILL.md"),
      tables: [
        { name: "FORBIDDEN_PATHS", rules: FORBIDDEN_PATHS },
        { name: "VERIFICATION_PATHS", rules: VERIFICATION_PATHS },
      ],
      refusesBySize: false,
    });

    expect(result.problems).toEqual([]);
  });
});
