/**
 * Whether the scope prose the solver reads still describes the gate that runs.
 *
 * `fb772b3` deleted the diff gate's size caps and updated `ARCHITECTURE.md`; it
 * missed `.claude/skills/agent-solve/SOLVE_INSTRUCTIONS.md` and that skill's
 * `SKILL.md`, which went on telling every solve pass about a cap that no longer
 * existed for a week. Nothing went red, because `docs:check` reads those two
 * files only for their `§N` headings — never for what they claim.
 *
 * **The consequence is a run that ends, not a document that misleads**, which
 * is why this is a check rather than a note. A bound the agent believes in is
 * obeyed whether or not it is enforced: recon bails, the ticket is released as
 * found, and it is offered again at full solve cost on the next tick. The
 * reasoning is quoted here rather than cited to the plan entry that asked for
 * it: `PLAN.md` entries are deleted in the last commit before the push, so a
 * citation to the one behind this module would have dangled the same day it
 * was written.
 *
 * ## Both halves are derived, and that is the point
 *
 * The temptation here is to grep the prose for words like "cap" or "limit" and
 * fail on a match. That guard would fire on the sentence that says there is no
 * cap — the prose is *about* size bounds — and `BUILDING.md` has the rule for
 * text matchers that refuse the description instead of the deed: a false
 * positive is how a guard earns the contempt that gets it switched off. So
 * nothing here matches on vocabulary.
 *
 * Instead:
 *
 *   1. **Paths.** The prose enumerates example paths. Each one is run through
 *      the gate's own rule tables, and each rule table entry must be exercised
 *      by at least one example. Both directions, against the real patterns, so
 *      neither side can move without the other.
 *   2. **Size.** The caller asks the real `checkDiff` whether an enormous diff
 *      of innocuous paths is refused, and the answer — not a reading of the
 *      source — decides which sentence the prose is required to carry.
 *
 * Passed its inputs rather than reading them, and separate from
 * `docs-check.ts`, for the reason `pinned-prose.ts` gives in its own header:
 * that file is a script, and importing it from a test runs `vitest list`, which
 * spawns vitest inside vitest.
 */

import { flatten } from "./pinned-prose.ts";

/**
 * The shape of one gate rule.
 *
 * Structurally identical to `diff-gate.ts`'s own `Rule`, which is not exported.
 * Declared here rather than exporting that one because this module must not
 * import the gate: keeping it dependency-free is what lets the test hand it a
 * two-rule fixture and assert on the failure text. The caller passes the real
 * tables in.
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
  /**
   * Whether the real gate refuses a very large diff of otherwise-clean paths.
   * Measured by the caller against `checkDiff`, never read out of the source.
   */
  readonly refusesBySize: boolean;
}

export interface ScopeBoundsResult {
  readonly problems: readonly string[];
  readonly summary: string;
}

/**
 * Where the enumerated paths start and stop.
 *
 * The closing marker is the next heading rather than `---`, so that adding a
 * subsection between them truncates the list loudly — every rule below the cut
 * reports as unexercised — instead of quietly shortening it.
 */
const LIST_OPENS = "### What the gate refuses by path";
const LIST_CLOSES = "### The bounds that are not path rules";

/**
 * The sentence each document must carry while the gate refuses nothing on size.
 *
 * Pinned text, not a pattern, for the reason in the header. Flattened on both
 * sides before comparison because `oxfmt` reflows markdown and a correct
 * sentence wrapped in a new place is not a defect.
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
 * Takes *all* of them rather than filtering to things that look like paths: a
 * "looks like a path" heuristic is a silent way to drop an entry, and the whole
 * failure being designed against is an entry nobody noticed was missing. So the
 * agent-facing part of the section must hold nothing in backticks but paths,
 * and a stray `pnpm docs:check` written into it fails this check loudly rather
 * than weakening it.
 *
 * **HTML comments are cut first, and that exemption is load-bearing rather than
 * a convenience.** The list carries a maintainer note naming `FORBIDDEN_PATHS`,
 * `VERIFICATION_PATHS` and `src/solve/diff-gate.ts` — the citation that tells
 * the next person where the other half of this pair lives. Those are the right
 * words in the right place and none of them is a path the gate refuses; the
 * first run of this check reported all four as defects. A comment is invisible
 * to the solver reading the rendered skill, so it is not part of what the
 * solver was told, which is the only thing this check is about.
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

  // Direction 1: the prose must not name a path the gate allows. This is the
  // failure the plan entry is named for — prose stating a bound the gate does
  // not enforce — and the agent pays for it by declining work that was allowed.
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

  // The size half. `refusesBySize` is a measurement of `checkDiff`, so this
  // compares the prose against behaviour rather than against the source.
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
