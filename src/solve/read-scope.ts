/**
 * Which checkouts a pass may read besides the one it is fixing.
 *
 * Resolve once and pass the value to both `--add-dir` and `escape.ts`'s
 * `snapshotRepos` — deriving them separately could let a directory open to
 * the pass go unwatched by the guard. Names are joined under `SOLVE_REPO_ROOT`
 * only after passing `isRepoName`, so a `.env` value can't select outside it.
 */

import { join } from "node:path";

import { isRepoName } from "./labels.ts";

export interface ReadScope {
  /** Absolute paths, in the order the operator wrote them, deduplicated. */
  readonly dirs: readonly string[];
  /** Entries that were refused, verbatim, so a typo can be seen and fixed. */
  readonly rejected: readonly string[];
}

/** Resolves the configured names against the checkout root; `solving` is excluded since its worktree is passed separately. */
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

/** The line a pass sees above the directory list; `SOLVE_INSTRUCTIONS.md` §0a quotes it verbatim. */
export const READ_SCOPE_HEADING = "Other checkouts on this machine, readable for context:";

/**
 * The sentence handed to a pass naming what it may read.
 *
 * Empty scope produces an empty string rather than a sentence about nothing to
 * read — a prompt that discusses absent capabilities invites a pass to reason about them.
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
