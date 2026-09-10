/**
 * A word budget for the documents an agent is required to read before it edits
 * anything, and the ratchet that stops the budget being raised to fit.
 *
 * **Why this exists.** The corpus went from 9,497 to 28,286 words in about a
 * day with every gate green, because every other check in `docs-check.ts` is a
 * consistency check: they ask whether the tree agrees with itself, and a
 * document that doubles in length agrees with itself perfectly. Nothing here
 * had a ceiling, so the one cost that matters for prose an agent must read —
 * how much of a cold context it eats before any work starts — was the only
 * property nobody measured.
 *
 * **What is budgeted, and nothing else.** `CLAUDE.md`, and the three phase
 * files a change actually has to load: the index, `STARTING.md`, `FINISHING.md`.
 * Plus their sum, so cutting one file and spending the words in another is
 * caught. `INCIDENTS.md`, `BUILDING.md`, `PROVING.md`, `ARCHITECTURE.md` and
 * `PLAN.md` are deliberately absent — they are read when a question sends you
 * there, not before every edit, and **a budget on a file nobody must read is a
 * budget nobody defends**. The first time it is inconvenient it gets raised,
 * and a budget that has been raised once teaches that budgets get raised.
 *
 * **The counting rule, written down because everyone will argue about it.**
 * Split on `/\s+/`, count the non-empty pieces, and count everything in the
 * file: frontmatter, table pipes, code fences, HTML comments. That is `wc -w`
 * exactly — verified against all four files by the test, not by inspection.
 * The rule is deliberately the crudest one available. Every refinement ("don't
 * count the tables", "don't count fences") is a lever for making the number
 * smaller without making the file shorter, and a number that can be argued
 * with is a number that gets argued up.
 *
 * **The band is two-sided, and the lower bound is the whole design.** This is
 * the argument `KNOWN_DANGLING` makes in its own docstring in `docs-check.ts`
 * — that a debt "goes to zero" — and then does not implement: it was written at
 * 39 and has not moved since, because nothing has ever required it to. A
 * ceiling alone ratchets in one direction only by convention, and convention is
 * what this whole file is a replacement for. So a file that drops below its
 * floor fails too, with "lower the budget in this commit": the cut and the
 * budget move together or neither moves. The band is about 120 words wide so
 * that ordinary wording fixes are not two-file diffs.
 *
 * **And a ceiling can only be lowered, which git enforces — against the fork
 * point, not against `HEAD`.** The first draft of this file compared the working
 * tree to `git show HEAD:...`, and an audit unplugged it and watched it stay
 * quiet: on any pushed ref the checkout _is_ `HEAD`, so that comparison is the
 * file against itself and returns nothing. It could only ever have fired in a
 * dirty local tree, which is the one place a convention was already enough. The
 * baseline is now `merge-base HEAD origin/main` — the state the branch forked
 * from — so a ceiling raised anywhere in a branch is still raised when CI reads
 * it. Raising takes `DOCS_CHECK_RAISE_BUDGET=<file>:<reason>` for one run, the
 * reason is printed in full and carries a fixed token so a CI log can be grepped
 * for it, and CI refuses a run that carries the variable at all.
 *
 * **When the baseline cannot be resolved the check says so instead of passing.**
 * A detached checkout with no remote yields no merge base, and the honest
 * report is "not enforced this run" — the failure this whole file exists to stop
 * is a check that answers a narrower question than it appears to, and a ratchet
 * that silently compares nothing is the purest form of it. It is a *problem*,
 * not a warning, so the run exits 1.
 *
 * **Which means this file depends on a line in `ci.yml`, and that line was
 * missing.** `actions/checkout@v4` defaults to `fetch-depth: 1`: a detached HEAD
 * and no `origin/main`, exactly the case above. Measured before it shipped — a
 * copy of this tree with no reachable baseline gives `no baseline to compare
 * ceilings against` and `exit=1`, so the shallow default would have failed the
 * Docs step on every pull request, starting with the one that added this file.
 * The checkout now sets `fetch-depth: 0` and says why. If that line is ever
 * removed, this check does not weaken — it goes red, which is the direction a
 * missing dependency should fail in, and the reason the unresolved case is a
 * problem rather than a warning.
 *
 * **The one silence left is the baseline that resolves and does not contain this
 * file**, which parses as no budgets and so permits every ceiling. On the branch
 * that introduces the file that is correct and unavoidable — there is no prior
 * ceiling to ratchet against, and the ratchet is inert here whatever it prints.
 * It starts working on the first commit after this file is in the default branch.
 * The case it cannot tell apart from that one is a rename, which resets every
 * ceiling to unbounded without a word; if this file moves, lower the ceilings by
 * hand in the same commit rather than trusting the green line.
 *
 * This module is separate from `docs-check.ts` for the reason `pinned-prose.ts`
 * is: that file is a top-level script with no exports, importing it runs
 * `vitest list`, and the two checks whose failure mode is silently matching
 * nothing are the last two that should be untestable.
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
 * The mandatory-reading path, and where the cut of 2026-09-09 actually landed.
 *
 * Every ceiling here is a measurement plus 2%, rounded down; every floor is a
 * measurement less 120. The corpus was cut first and the numbers were read off
 * the result. That ordering is the point: a budget set by projection is a budget
 * the work has to grow into, and a budget set from the landing is one the next
 * change has to argue with.
 *
 * **The first draft of these numbers was read off a landing that had missed.**
 * This branch committed in `PLAN.md`, before any measuring, to a mandatory-reading
 * path under 4,907 words. The cut landed at 4,913, and the bands were then drawn
 * around the 4,913 — which quietly converts a promise into whatever happened,
 * and is the same move as raising a ceiling to fit the corpus. The fix was to
 * hit the target first (`CLAUDE.md` to its 800-word brief, landing the path at
 * 4,811) and only then re-read the numbers. `aggregateCeiling` is now 4,905, so
 * the figure this branch promised in advance is the figure that fails the build.
 *
 * **The literal shape is load-bearing.** `parseBudgets` reads this array out of
 * the *committed* text of this file, so the ratchet depends on the entries
 * staying machine-readable. Nothing enforces a formatting convention, so the
 * test asserts that this module can parse its own source: reformat these
 * entries past the parser and the suite goes red rather than the ratchet going
 * quiet.
 */
export const BUDGETS: readonly Budget[] = [
  { path: "CLAUDE.md", floor: 680, ceiling: 816 },
  { path: ".claude/skills/dev-house-rules/SKILL.md", floor: 494, ceiling: 626 },
  { path: ".claude/skills/dev-house-rules/STARTING.md", floor: 1678, ceiling: 1833 },
  { path: ".claude/skills/dev-house-rules/FINISHING.md", floor: 1479, ceiling: 1630 },
];

/**
 * The floor for the whole mandatory-reading path: the measured landing, less
 * one band.
 *
 * Written out, where the aggregate *ceiling* is derived, and the asymmetry is
 * deliberate. The ceilings sum exactly (`aggregateCeiling`), so the total can
 * never be over while every file is under — the aggregate cannot be slack
 * layered on top, and one file cannot be robbed to pay another. The floors do
 * not sum: four files each shrinking by 100 words is 400 words gone with every
 * individual band still satisfied, and that is precisely the drift a per-file
 * floor cannot see. So the total carries its own floor, tighter than the sum of
 * the parts, and it is the only thing that notices a corpus quietly eroding
 * without its budget following.
 */
export const AGGREGATE_FLOOR = 4691;

/** What the whole path is called in a failure message. */
export const AGGREGATE_LABEL = "the mandatory-reading path";

/**
 * The ceiling for the sum, derived rather than declared, so that raising one
 * file's ceiling is arithmetically the same act as raising the total's.
 */
export function aggregateCeiling(budgets: readonly Budget[] = BUDGETS): number {
  return budgets.reduce((total, budget) => total + budget.ceiling, 0);
}

/**
 * Words in a document: whitespace-separated non-empty pieces, counted over the
 * whole file.
 *
 * This must equal `wc -w` to the word. It does, because both count runs of
 * non-whitespace, and because none of the budgeted files contain a non-ASCII
 * space — which is the one input that would separate the two definitions, and
 * which the test pins.
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
    // The wrap goes before "the next", never inside it. A phrase a reader — or
    // a test — greps for must not have a newline dropped into the middle of it
    // by however wide the number turns out to be, which is the same bet on a
    // literal space that disabled half the count check in `docs-check.ts`.
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
 * Every way the mandatory-reading path can be the wrong length, as messages
 * ready to print.
 *
 * A budgeted file missing from `sizes` is a problem rather than a skip, for the
 * reason `preToolUseRegistrations` throws rather than returning 0: a check that
 * treats "I could not measure it" as "it is fine" is the fail-quiet shape this
 * whole command keeps producing. It also means the aggregate is not computed
 * from a partial sum and quietly reported as under.
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
 * A `{ path, floor, ceiling }` entry, however the formatter has wrapped it.
 *
 * Built to tolerate whitespace everywhere and to require nothing that is not a
 * word or punctuation, because a literal space in a pattern is a bet that
 * `oxfmt` will not put a newline there, and that is a bet this repository has
 * already lost twice inside `docs-check.ts`.
 */
const ENTRY = /\{\s*path:\s*"([^"]+)"\s*,\s*floor:\s*(\d+)\s*,\s*ceiling:\s*(\d+)\s*,?\s*\}/gu;

/**
 * The budgets declared in a copy of this file's source — normally the committed
 * one, read with `git show`.
 *
 * Parsing text rather than importing the old module because there is no way to
 * import a previous revision, and because the alternative — a separate
 * committed data file holding the numbers — is a second place for them to live.
 */
export function parseBudgets(source: string): Budget[] {
  return [...source.matchAll(ENTRY)].map((match) => ({
    path: match[1] ?? "",
    floor: Number(match[2]),
    ceiling: Number(match[3]),
  }));
}

/**
 * Refs the ratchet will try to fork from, best first.
 *
 * `origin/main` before `main` because a local `main` can lag the remote by any
 * amount, and a stale baseline forgives every raise made since it was last
 * fetched. Both are tried because a fresh clone in CI may have only one.
 */
export const BASELINE_REFS: readonly string[] = ["origin/main", "main"];

/** The revision the ratchet compares against, and how it was found. */
export interface Baseline {
  readonly rev: string;
  readonly describedAs: string;
}

/**
 * The fork point this branch's ceilings are judged against.
 *
 * `run` returns the command's stdout, or `null` if it failed — the caller owns
 * talking to git, so this stays a pure function over that one effect and the
 * tests do not need a repository.
 *
 * Returns `null` when no candidate resolves, which the caller must report rather
 * than treat as "no raises". Those two states produce the same empty list and
 * mean opposite things, which is exactly how the first version of this ratchet
 * managed to be inert without anybody noticing.
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
 * Ceilings the working tree has raised.
 *
 * A path with no committed entry is not a raise: a newly budgeted file has no
 * previous ceiling to be above, and refusing one would mean nothing new could
 * ever be budgeted. Lowering, and removing an entry, are both free — the
 * ratchet only ever turns one way.
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
 * Raised ceilings the override does not excuse.
 *
 * The override names one file, so raising two ceilings in one run takes two
 * runs — which is the intended friction. An override naming a file that was not
 * raised is not an error here: it is inert, and reporting it would turn a stale
 * shell variable into a failure the message could not explain.
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
 * The line printed when an override was used, or `null` when it was not.
 *
 * `BUDGET RAISED` is a fixed token on purpose: a raise is a local escape hatch
 * for the one commit that widens a ceiling deliberately, and it must never be
 * how a branch goes green on a machine nobody is watching. The token is what
 * makes a build that used one greppable, and `.github/workflows/ci.yml` refuses
 * a run that carries the variable at all.
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
