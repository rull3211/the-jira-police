/**
 * Whether the scope prose the solver reads still describes the gate that runs.
 *
 * `fb772b3` deleted the diff gate's size caps but missed two prose files, which went on
 * describing a cap that no longer existed — `docs:check` reads those files only for their
 * `§N` headings, never for what they claim. A bound the agent believes in is obeyed whether or
 * not it is enforced, so a stale bound costs a run rather than just misleading a reader.
 *
 * Checked by measurement, not by matching vocabulary like "cap" or "limit" — a sentence saying
 * there is no cap would fail a naive text match, the false positive `BUILDING.md` warns against.
 * Instead: every example path in the prose is run through the gate's real rule tables, both
 * directions, and the size sentence is required only when `checkDiff` itself refuses a large diff.
 *
 * Passed its inputs rather than reading them, and separate from `docs-check.ts` for the reason
 * `pinned-prose.ts` gives: importing a script from a test spawns vitest inside vitest.
 */

import { flatten } from "./pinned-prose.ts";

/**
 * The shape of one gate rule, structurally identical to `diff-gate.ts`'s own unexported `Rule`.
 *
 * Declared here rather than imported so this module stays dependency-free — the test can hand it
 * a two-rule fixture without importing the gate itself.
 */
export interface ScopeRule {
  readonly pattern: RegExp;
  readonly why: string;
}

/** One of the gate's rule tables, named so a failure can say which. */
export interface RuleTable {
  readonly name: string;
  readonly rules: readonly ScopeRule[];
}

export interface ScopeBoundsInput {
  /** Repository-relative, for the failure text only. */
  readonly instructionsPath: string;
  readonly instructions: string;
  readonly skillPath: string;
  readonly skill: string;
  readonly tables: readonly RuleTable[];
  /** Whether the real gate refuses a very large diff — measured by the caller, never read from source. */
  readonly refusesBySize: boolean;
}

export interface ScopeBoundsResult {
  readonly problems: readonly string[];
  readonly summary: string;
}

/**
 * Where the enumerated paths start and stop.
 *
 * Closes on the next heading rather than `---`, so a subsection inserted between them truncates
 * the list loudly instead of shortening it quietly.
 */
const LIST_OPENS = "### What the gate refuses by path";
const LIST_CLOSES = "### The bounds that are not path rules";

/**
 * The sentence each document must carry while the gate refuses nothing on size.
 *
 * Flattened on both sides before comparison, since `oxfmt` can rewrap a correct sentence onto a
 * new line without that being a defect.
 */
const NEVER_BY_SIZE = {
  [".claude/skills/agent-solve/SOLVE_INSTRUCTIONS.md"]:
    "**The gate refuses by path, and never by size.**",
  [".claude/skills/agent-solve/SKILL.md"]:
    "It does **not** refuse on size: there is no file cap and no line cap",
} as const;

/**
 * Every backticked token in the enumerated section.
 *
 * Takes all of them rather than filtering to things that look like paths, since that heuristic
 * is a silent way to drop an entry unnoticed. HTML comments are cut first — a maintainer note
 * naming `FORBIDDEN_PATHS` etc. is invisible to the solver reading the rendered skill, so it
 * isn't part of what the solver was actually told.
 */
export function refusalExamples(instructions: string): readonly string[] {
  const opens = instructions.indexOf(LIST_OPENS);
  if (opens === -1) {
    return [];
  }
  const rest = instructions.slice(opens + LIST_OPENS.length);
  const closes = rest.indexOf(LIST_CLOSES);
  const section = (closes === -1 ? rest : rest.slice(0, closes)).replaceAll(
    /<!--[\s\S]*?-->/gu,
    "",
  );

  const tokens: string[] = [];
  for (const match of section.matchAll(/`([^`\n]+)`/gu)) {
    const token = match[1];
    if (token !== undefined) {
      tokens.push(token);
    }
  }
  return tokens;
}

function ruleLabel(table: RuleTable, index: number): string {
  return `${table.name}[${index}] (${table.rules[index]?.pattern.source ?? "?"})`;
}

export function scopeBoundsProblems(input: ScopeBoundsInput): ScopeBoundsResult {
  const { instructionsPath, instructions, skillPath, skill, tables, refusesBySize } = input;
  const problems: string[] = [];

  const sectionPresent = instructions.includes(LIST_OPENS) && instructions.includes(LIST_CLOSES);
  if (!sectionPresent) {
    problems.push(
      `${instructionsPath}: could not find the enumerated refusal list between "${LIST_OPENS}" and ` +
        `"${LIST_CLOSES}". Either a heading was renamed or the list was removed — this check cannot ` +
        `compare the prose against the gate without it, and a missing section must fail rather than ` +
        `pass with nothing to say.`,
    );
  }

  const examples = refusalExamples(instructions);

  // Direction 1: the prose must not name a path the gate allows, or the agent declines work
  // it was actually allowed to do.
  for (const example of examples) {
    const refused = tables.some((table) => table.rules.some((rule) => rule.pattern.test(example)));
    if (!refused) {
      problems.push(
        `${instructionsPath}: the refusal list names \`${example}\`, and no rule in ` +
          `${tables.map((table) => table.name).join(" or ")} refuses it. Either the gate lost a rule ` +
          `and the prose kept it — the fb772b3 failure this check exists for — or the example is ` +
          `wrong. A path the agent believes is refused is a path it will decline to touch.`,
      );
    }
  }

  // Direction 2: the gate must not refuse something the prose never mentions.
  // Weaker consequence — the run is discarded rather than never attempted — but
  // it is the direction that decays silently as rules are added.
  for (const table of tables) {
    for (const [index, rule] of table.rules.entries()) {
      if (!examples.some((example) => rule.pattern.test(example))) {
        problems.push(
          `${instructionsPath}: gate rule ${ruleLabel(table, index)} is refused by the harness and ` +
            `matched by no example in the refusal list, so the solver is never told about it — ` +
            `"${rule.why}". Add an example path that matches it, in the commit that added the rule.`,
        );
      }
    }
  }

  // refusesBySize is measured against the real checkDiff, so this compares the prose against
  // behaviour rather than against the source.
  for (const [path, body] of [
    [instructionsPath, instructions],
    [skillPath, skill],
  ] as const) {
    const sentence = NEVER_BY_SIZE[path as keyof typeof NEVER_BY_SIZE];
    if (sentence === undefined) {
      continue;
    }
    const states = flatten(body).includes(flatten(sentence));
    if (refusesBySize && states) {
      problems.push(
        `${path}: the gate refuses a large diff of otherwise-clean paths, and this document still ` +
          `says it never refuses on size. A size cap was reinstated without the prose following it.`,
      );
    }
    if (!refusesBySize && !states) {
      problems.push(
        `${path}: the gate refuses nothing on size, and this document no longer carries the ` +
          `sentence saying so — expected "${sentence}". The caps were deleted on 2026-09-06; a ` +
          `document that goes quiet about it is how four sites kept claiming one for a week.`,
      );
    }
  }

  const ruleCount = tables.reduce((total, table) => total + table.rules.length, 0);
  return {
    problems,
    summary:
      `${examples.length} example path(s) against ${ruleCount} gate rule(s) in ${tables.length} ` +
      `table(s), both directions; size refusal measured as ${refusesBySize}`,
  };
}
