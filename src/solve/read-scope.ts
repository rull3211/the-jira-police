/**
 * Which checkouts a pass may read besides the one it is fixing.
 *
 * ## The case this exists for
 *
 * PR #2663 fixed a frontend field and asserted, in prose, how the backend
 * handles the property it stops sending. The assertion was wrong, and the code
 * that would have settled it — `CarMapper` in another checkout on the same disk
 * — was never opened. Not because the pass could not open it: a probe on
 * 2026-09-07 read an absolute path in a sibling checkout under the exact recon
 * flags this harness passes, and it worked. It was never opened because nothing
 * told the pass it was there, and the prompt said the worktree was its world.
 *
 * So this is a *prompt* fact before it is a permission fact. The directories
 * resolved here are named to the pass, and named to the guard that watches them.
 *
 * ## One list, two consumers, and they must not be computed twice
 *
 * The same array feeds `--add-dir` on the read-only pass and `snapshotRepos` in
 * `escape.ts`. If those were derived separately they could drift, and the way
 * they would drift is the bad way round: a directory opened to a pass and not
 * watched by the guard is exactly the case the guard exists for. Resolve once,
 * pass the value.
 *
 * ## Names, not paths
 *
 * The setting takes repository names and joins them under `SOLVE_REPO_ROOT`, so
 * a value from `.env` structurally cannot select a directory outside that root.
 * That property is enforced here rather than described: `isRepoName` is the same
 * predicate `repoFromLabels` applies to a name a stranger can edit in Jira, and
 * it is what rules out `..`, absolute paths, and a leading `-`.
 *
 * An unusable entry is **dropped and reported**, not thrown. A typo in an
 * optional read list should cost a pass some context, not the whole run — but a
 * silent drop would leave an operator reading a solve that had quietly stopped
 * consulting the backend, so the caller is handed the rejects to log.
 */

import { join } from "node:path";

import { isRepoName } from "./labels.ts";

export interface ReadScope {
  /** Absolute paths, in the order the operator wrote them, deduplicated. */
  readonly dirs: readonly string[];
  /** Entries that were refused, verbatim, so a typo can be seen and fixed. */
  readonly rejected: readonly string[];
}

/**
 * Resolves the configured names against the checkout root.
 *
 * `solving` is the repository this run is already working in. It is excluded
 * because its worktree is passed separately and adding the checkout itself
 * would hand the pass a second, *writable-looking* copy of the code it is
 * editing — two paths to the same file, one of which is not the worktree, which
 * is the most plausible way a well-behaved pass ends up editing the wrong tree.
 */
export function readScope(
  root: string,
  names: readonly string[],
  solving: string | null,
): ReadScope {
  const dirs: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (!isRepoName(name)) {
      rejected.push(name);
      continue;
    }
    if (name === solving || seen.has(name)) {
      continue;
    }
    seen.add(name);
    dirs.push(join(root, name));
  }
  return { dirs, rejected };
}

/**
 * The line a pass sees above the directory list, and the skill quotes verbatim.
 *
 * A constant rather than an inline string because it is a join between two
 * things that cannot see each other: this module writes the block into the
 * prompt, and `SOLVE_INSTRUCTIONS.md` §0a tells the pass what to do with it by
 * quoting this heading to say which block it means. Reworded here and the
 * contract points at a section of the prompt that no longer exists, silently,
 * because one side is a string literal and the other is Markdown. A test in
 * `skill-root.test.ts` fails instead.
 */
export const READ_SCOPE_HEADING = "Other checkouts on this machine, readable for context:";

/**
 * The sentence handed to a pass naming what it may read.
 *
 * Says *read* twice and says why, because the failure to guard against is not a
 * pass that ignores the list — it is a pass that treats a readable checkout as
 * a place to make the fix land. The paths are absolute since that is what the
 * tools take, and the pass's own working directory is elsewhere.
 *
 * Empty scope produces an empty string rather than a sentence explaining that
 * there is nothing to read. A prompt that discusses absent capabilities invites
 * a pass to reason about them.
 */
export function describeReadScope(dirs: readonly string[]): string {
  if (dirs.length === 0) {
    return "";
  }
  return [
    READ_SCOPE_HEADING,
    ...dirs.map((dir) => `- ${dir}`),
    "",
    "Read them to check a claim about another service instead of asserting one.",
    "They are READ-ONLY. Every change you make belongs in your worktree; a fix",
    "written into one of these directories is not part of this ticket's change,",
    "will not be reviewed, and will be reported as an escape.",
  ].join("\n");
}
