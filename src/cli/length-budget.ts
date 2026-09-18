/**
 * A word budget for the mandatory-reading path — `CLAUDE.md` plus the three phase files a change
 * must load — enforced per file and as a sum, so cutting one file to pad another is still caught.
 * Other docs (`INCIDENTS.md`, `ARCHITECTURE.md`, `PLAN.md`, ...) are deliberately unbudgeted: they
 * are read on demand, not before every edit.
 *
 * The band is two-sided: a file that drops below its floor fails too ("lower the budget in this
 * commit"), because a ceiling alone ratchets in one direction only by convention.
 *
 * A ceiling can only be lowered, checked against `merge-base HEAD origin/main` rather than `HEAD`
 * itself — comparing to `HEAD` is comparing the file to itself on any pushed ref and always passes.
 * Raising one takes `DOCS_CHECK_RAISE_BUDGET=<file>:<reason>` for one run; CI refuses a run that
 * carries the variable at all. When no baseline resolves, that is reported as a failure, not a
 * skip — a ratchet that silently compares nothing is the fail-quiet shape this file exists to stop.
 * This depends on `ci.yml` using `fetch-depth: 0`; the shallow default leaves no `origin/main` to
 * resolve, so removing that line turns the check red rather than weakening it.
 *
 * A baseline that resolves but doesn't yet contain this file parses as no budgets, so every ceiling
 * passes — correct on the branch that introduces the file, but indistinguishable from a rename. If
 * this file moves, lower the ceilings by hand in the same commit rather than trusting a green run.
 *
 * Separate from `docs-check.ts` because importing that file runs `vitest list` at import time.
 */

/** The lower and upper bound of one budget. Both are inclusive. */
export interface Band {
  readonly floor: number;
  readonly ceiling: number;
}

/** A band with the document it applies to, keyed by repository-relative path. */
export interface Budget extends Band {
  readonly path: string;
}

/**
 * The mandatory-reading path. Each ceiling is a measurement plus 2% (rounded down), each floor is
 * that measurement less 120 — set only after the corpus was cut, never as a target to grow into.
 *
 * The literal shape is load-bearing: `parseBudgets` reads this array out of committed source text,
 * so reformatting an entry past the regex silently breaks the ratchet rather than failing loudly.
 */
export const BUDGETS: readonly Budget[] = [
  { path: "CLAUDE.md", floor: 680, ceiling: 816 },
  { path: ".claude/skills/dev-house-rules/SKILL.md", floor: 494, ceiling: 626 },
  { path: ".claude/skills/dev-house-rules/STARTING.md", floor: 1678, ceiling: 1833 },
  { path: ".claude/skills/dev-house-rules/FINISHING.md", floor: 1479, ceiling: 1630 },
];

/**
 * The floor for the whole path, set independently of the per-file floors. Ceilings sum exactly
 * (`aggregateCeiling`), but floors do not: several files each shrinking a little would satisfy
 * every individual floor while the corpus quietly erodes, which only a separate total floor catches.
 */
export const AGGREGATE_FLOOR = 4691;

/** What the whole path is called in a failure message. */
export const AGGREGATE_LABEL = "the mandatory-reading path";

/** Derived rather than declared, so raising one file's ceiling is arithmetically the same act as raising the total's. */
export function aggregateCeiling(budgets: readonly Budget[] = BUDGETS): number {
  return budgets.reduce((total, budget) => total + budget.ceiling, 0);
}

/**
 * Whitespace-separated non-empty pieces, counted over the whole file — matches `wc -w` because no
 * budgeted file contains a non-ASCII space, which the test pins.
 */
export function countWords(text: string): number {
  return text.split(/\s+/u).filter((word) => word.length > 0).length;
}

function overMessage(what: string, size: number, band: Band, override: string): string {
  return (
    `${what} is ${size} words, and its budget is ${band.floor}-${band.ceiling}. ` +
    `That is ${size - band.ceiling} over.\n` +
    `  The band is where a cut landed, not a target to grow into: ${band.ceiling} is the number\n` +
    `  this was cut back to, and every word above it is one an agent reads before it is\n` +
    `  allowed to start. Cut ${size - band.ceiling} word(s) here, or move them to a document\n` +
    `  nobody is required to read first.\n` +
    `  If the growth is genuinely right, the ceiling moves with ${override}, once, and the\n` +
    `  reason is printed in the run.`
  );
}

function underMessage(what: string, size: number, band: Band): string {
  return (
    `${what} is ${size} words, and its budget is ${band.floor}-${band.ceiling}. ` +
    `That is ${band.floor - size} under.\n` +
    // Wrap before "the next", not inside it — a greppable phrase must not get a newline
    // dropped into it by however wide the number turns out to be.
    `  Something was cut and the budget was not. Lower the band in this commit,\n` +
    `  or the next ${band.ceiling - size} words of growth are free.`
  );
}

const RAISE_VARIABLE = "DOCS_CHECK_RAISE_BUDGET";

/** The override as a message names it, for one file. */
function raiseHint(path: string): string {
  return `${RAISE_VARIABLE}=${path}:<reason>`;
}

/**
 * Every way the mandatory-reading path can be the wrong length, as messages ready to print.
 *
 * A budgeted file missing from `sizes` is a problem, not a skip — treating "not measured" as "fine"
 * would also let the aggregate total compute from a partial sum and report a false under.
 */
export function budgetProblems(
  sizes: ReadonlyMap<string, number>,
  budgets: readonly Budget[] = BUDGETS,
  aggregateFloor: number = AGGREGATE_FLOOR,
): string[] {
  const problems: string[] = [];
  let total = 0;
  let measuredAll = true;

  for (const budget of budgets) {
    const size = sizes.get(budget.path);
    if (size === undefined) {
      measuredAll = false;
      problems.push(
        `${budget.path} is budgeted and was not measured.\n` +
          `  Either it was renamed or deleted — in which case remove its entry from BUDGETS in\n` +
          `  src/cli/length-budget.ts and lower the total — or this check has stopped being able\n` +
          `  to find the file it is supposed to be bounding.`,
      );
      continue;
    }

    total += size;
    if (size > budget.ceiling) {
      problems.push(overMessage(budget.path, size, budget, raiseHint(budget.path)));
    } else if (size < budget.floor) {
      problems.push(underMessage(budget.path, size, budget));
    }
  }

  if (!measuredAll) {
    return problems;
  }

  const band: Band = { floor: aggregateFloor, ceiling: aggregateCeiling(budgets) };
  if (total > band.ceiling) {
    problems.push(overMessage(AGGREGATE_LABEL, total, band, raiseHint("<file>")));
  } else if (total < band.floor) {
    problems.push(underMessage(AGGREGATE_LABEL, total, band));
  }

  return problems;
}

/**
 * A `{ path, floor, ceiling }` entry, however the formatter has wrapped it. Tolerates whitespace
 * anywhere rather than matching a literal space, which is a bet against `oxfmt` this repository
 * has already lost inside `docs-check.ts`.
 */
const ENTRY = /\{\s*path:\s*"([^"]+)"\s*,\s*floor:\s*(\d+)\s*,\s*ceiling:\s*(\d+)\s*,?\s*\}/gu;

/**
 * The budgets declared in a copy of this file's source — normally the committed one, read with
 * `git show`. Parses text rather than importing a prior revision, since there is no way to import
 * one, and a separate data file would be a second place for the numbers to live.
 */
export function parseBudgets(source: string): Budget[] {
  return [...source.matchAll(ENTRY)].map((match) => ({
    path: match[1] ?? "",
    floor: Number(match[2]),
    ceiling: Number(match[3]),
  }));
}

/**
 * Refs the ratchet will try to fork from, best first. `origin/main` before `main` because a stale
 * local `main` would forgive every raise made since it was last fetched.
 */
export const BASELINE_REFS: readonly string[] = ["origin/main", "main"];

/** The revision the ratchet compares against, and how it was found. */
export interface Baseline {
  readonly rev: string;
  readonly describedAs: string;
}

/**
 * The fork point this branch's ceilings are judged against. `run` returns the command's stdout, or
 * `null` if it failed, so this stays pure and testable without a repository.
 *
 * Returns `null` when no candidate resolves, which the caller must report rather than treat as "no
 * raises" — conflating those let an earlier version of this ratchet go inert unnoticed.
 */
export function resolveBaseline(run: (args: readonly string[]) => string | null): Baseline | null {
  for (const ref of BASELINE_REFS) {
    const found = run(["merge-base", "HEAD", ref])?.trim();
    if (found !== undefined && found.length > 0) {
      return { rev: found, describedAs: `merge-base with ${ref}` };
    }
  }
  return null;
}

/** The one report for a run where the ratchet could not be applied at all. */
export function unresolvedBaselineProblem(): string {
  return (
    "length budget ratchet: no baseline to compare ceilings against.\n" +
    `  Tried ${BASELINE_REFS.map((ref) => `merge-base HEAD ${ref}`).join(", ")} and none resolved.\n` +
    "  The band still applies; what is NOT enforced this run is that a ceiling only ever\n" +
    "  goes down, so a raised ceiling would pass here. Fetch the default branch and re-run\n" +
    "  before trusting a green line from this check."
  );
}

/** A ceiling that is higher in the working tree than it is at the baseline. */
export interface Raise {
  readonly path: string;
  readonly from: number;
  readonly to: number;
}

/**
 * Ceilings the working tree has raised. A path with no committed entry is not a raise — a newly
 * budgeted file has no prior ceiling to exceed. Lowering, or removing an entry, are both free.
 */
export function raisedCeilings(
  committed: readonly Budget[],
  working: readonly Budget[] = BUDGETS,
): Raise[] {
  const before = new Map(committed.map((budget) => [budget.path, budget.ceiling]));
  const raises: Raise[] = [];
  for (const budget of working) {
    const from = before.get(budget.path);
    if (from !== undefined && budget.ceiling > from) {
      raises.push({ path: budget.path, from, to: budget.ceiling });
    }
  }
  return raises;
}

/** `<file>:<reason>`, split at the first colon so the reason may contain one. */
function parseOverride(raw: string | undefined): { path: string; reason: string } | null {
  const at = raw === undefined ? -1 : raw.indexOf(":");
  if (raw === undefined || at <= 0) {
    return null;
  }
  const reason = raw.slice(at + 1).trim();
  return reason.length === 0 ? null : { path: raw.slice(0, at).trim(), reason };
}

/**
 * Raised ceilings the override does not excuse. The override names one file, so raising two in one
 * run takes two runs; naming a file that wasn't raised is inert here, not an error.
 */
export function ratchetProblems(
  raises: readonly Raise[],
  override: string | undefined = process.env[RAISE_VARIABLE],
): string[] {
  const excused = parseOverride(override)?.path;
  return raises
    .filter((raise) => raise.path !== excused)
    .map(
      (raise) =>
        `${raise.path}: the budget ceiling is ${raise.to} here and ${raise.from} in git.\n` +
        `  A ceiling can only be lowered. The number is not a plan, it is where a cut already\n` +
        `  landed, and a number that can be edited upward in the same commit as the growth it\n` +
        `  excuses is not a budget — that is exactly how KNOWN_DANGLING in src/cli/docs-check.ts\n` +
        `  came to sit unchanged since the day it was written.\n` +
        `  If this raise is right, run it once with\n` +
        `    ${raiseHint(raise.path)}\n` +
        `  and put the same sentence in the commit message.`,
    );
}

/**
 * The line printed when an override was used, or `null` when it was not. `BUDGET RAISED` is a
 * fixed token so a build that used one is greppable; CI itself refuses any run carrying the variable.
 */
export function raiseNotice(
  raises: readonly Raise[],
  override: string | undefined = process.env[RAISE_VARIABLE],
): string | null {
  const parsed = parseOverride(override);
  if (parsed === null) {
    return null;
  }
  const used = raises.filter((raise) => raise.path === parsed.path);
  if (used.length === 0) {
    return null;
  }
  const moved = used.map((raise) => `${raise.from} -> ${raise.to}`).join(", ");
  return `BUDGET RAISED ${parsed.path} ${moved} (${RAISE_VARIABLE}): ${parsed.reason}`;
}
