/**
 * A throwaway, read-only copy of the `agent-solve` skill, for the pass to read.
 *
 * ## The bug this exists to fix
 *
 * Every solve pass sends `/agent-solve <KEY> --<pass>` as the first line of its
 * prompt. The skill lives in *this* repository's `.claude/skills/`, but the
 * pass runs with its working directory set to the worktree — deliberately, it
 * is `passes.ts` containment property 1 — and Claude Code discovers skills from
 * the working directory and from `--add-dir`, neither of which pointed here.
 *
 * Probed 2026-09-04 from a foreign directory: `Unknown command: /agent-solve`.
 * So the four passes would have shipped sending a slash command that resolves
 * to nothing. That is exactly the divergence this project exists to catch —
 * prose describing a skill-driven pipeline, behaviour sending a dead string —
 * and it was invisible because nothing had run the solver end to end yet.
 *
 * ## Why not simply add the repository
 *
 * `--add-dir <the-jira-police>` makes the skill resolve. It also hands the pass
 * the rest of this repository, and the same probe run established what that
 * means:
 *
 * ```
 * --add-dir <dir>, no --allowedTools           → Write denied
 * --add-dir <dir>, --allowedTools "…,Write"    → Write SUCCEEDED
 * ```
 *
 * The fix, simplify and review passes all pre-approve `Write` and `Edit`, so an
 * added directory is a writable directory for exactly the passes that matter. A
 * solver pointed at this repository could edit `runner.ts` — the file holding
 * its own denylists — or `diff-gate.ts`, the bound on what it may change, and
 * neither edit would appear in any check, because the diff gate only ever
 * inspects the worktree. It would also put everything else in the repository
 * root in front of a model, which is a decision no one has made and this module
 * is not the place to make it.
 *
 * So the pass gets a directory containing the skill and nothing else.
 *
 * ## Why read-only, and how much that buys
 *
 * A writable copy would still be a self-modification path with a real horizon:
 * the `fix` pass could rewrite the skill that `simplify` and `review` then read,
 * within the same run. Copying per-run bounds that to one run; `chmod` removes
 * it. Verified 2026-09-04 by asking a session with `Write` pre-approved and this
 * directory added to overwrite a file in it and to create a new one — both
 * failed `EACCES`, and the original content survived.
 *
 * Directories are `0o555` rather than only the files being `0o444`, because on
 * a POSIX filesystem it is write permission on the *directory* that governs
 * creating and unlinking entries. Files-only would have left the model free to
 * delete the skill and write its own in its place.
 *
 * ## The source path is derived, never configured
 *
 * `sourceSkillDirectory` resolves from `import.meta.dirname`. A setting would
 * make "which instructions does the solver follow" an operator-supplied string,
 * and therefore something a typo could repoint at an arbitrary directory. It
 * ships with the code because it is part of the code.
 */

import { chmod, cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { logger } from "../logger.ts";

/** The only skill a solve pass is given. */
export const SKILL_NAME = "agent-solve";

const DIRECTORY_MODE_READ_ONLY = 0o555;
const FILE_MODE_READ_ONLY = 0o444;
const DIRECTORY_MODE_WRITABLE = 0o755;
const FILE_MODE_WRITABLE = 0o644;

/**
 * Where the skill ships, relative to this file.
 *
 * `src/solve/skill-root.ts` → up two → the repository root, then the standard
 * skill location. Exported so a test can assert the skill is actually there:
 * this whole module is useless if the path is wrong, and the failure mode is a
 * pass that resolves no skill — which is the bug being fixed.
 */
export function sourceSkillDirectory(): string {
  return join(import.meta.dirname, "..", "..", ".claude", "skills", SKILL_NAME);
}

export type SkillRootResult =
  | { readonly outcome: "prepared"; readonly path: string }
  | { readonly outcome: "refused"; readonly reason: string };

/** Read-only, depth-first: children before the directory that contains them. */
async function lockDown(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      await lockDown(child);
    } else {
      await chmod(child, FILE_MODE_READ_ONLY);
    }
  }
  // Last. Locking this first would deny us permission to touch its children.
  await chmod(path, DIRECTORY_MODE_READ_ONLY);
}

/** The inverse, and it must run outermost-first for the same reason. */
async function unlock(path: string): Promise<void> {
  await chmod(path, DIRECTORY_MODE_WRITABLE);
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      await unlock(child);
    } else {
      await chmod(child, FILE_MODE_WRITABLE);
    }
  }
}

/**
 * Builds the skill root for one run, or refuses.
 *
 * The layout is fixed by Claude Code's discovery rules, not chosen here: a
 * directory is searched for `.claude/skills/<name>/`, so the path handed to
 * `--add-dir` is the grandparent of the skill and must contain nothing else.
 *
 * Refuses rather than throws, matching `createWorktree`. A missing skill
 * directory is a broken installation and the run should stop with a sentence
 * saying so, not a stack trace three layers up.
 */
export async function prepareSkillRoot(
  parentDirectory: string,
  issueKey: string,
): Promise<SkillRootResult> {
  const source = sourceSkillDirectory();

  try {
    const info = await stat(source);
    if (!info.isDirectory()) {
      return { outcome: "refused", reason: `${source} is not a directory` };
    }
  } catch {
    return {
      outcome: "refused",
      reason: `the ${SKILL_NAME} skill is not installed at ${source} — every pass sends /${SKILL_NAME} as its first line, so a run without it would resolve no skill`,
    };
  }

  const root = join(parentDirectory, `${issueKey}-skill`);
  const destination = join(root, ".claude", "skills", SKILL_NAME);

  try {
    // A leftover from an interrupted run is read-only, so clear it the same way
    // `removeSkillRoot` would rather than letting `cp` fail on EACCES.
    await removeSkillRoot(root);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true });
    await lockDown(root);
  } catch (error) {
    return {
      outcome: "refused",
      reason: `could not stage the skill at ${root}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  logger.info("solve.skillRoot.prepared", { issueKey, path: root });
  return { outcome: "prepared", path: root };
}

/**
 * Removes the staged skill, unlocking it first.
 *
 * `rm` cannot delete an entry inside a `0o555` directory, so the unlock is not
 * tidiness — without it every run would leave one of these behind. Absence is
 * not an error: this is called on the cleanup path, including after a
 * `prepareSkillRoot` that refused before creating anything.
 */
export async function removeSkillRoot(root: string): Promise<void> {
  try {
    await stat(root);
  } catch {
    return;
  }
  await unlock(root);
  await rm(root, { recursive: true, force: true });
}
