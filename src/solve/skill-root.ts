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
 * The locking itself is `read-only-tree.ts`, shared with the image stager,
 * which carries why a directory mode rather than a file mode is what makes the
 * guarantee.
 *
 * ## The source path is derived, never configured
 *
 * `sourceSkillDirectory` resolves from `import.meta.dirname`. A setting would
 * make "which instructions does the solver follow" an operator-supplied string,
 * and therefore something a typo could repoint at an arbitrary directory. It
 * ships with the code because it is part of the code.
 */

import { cp, mkdir, mkdtemp, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { logger } from "../logger.ts";
import { lockDown, removeReadOnlyTree } from "../read-only-tree.ts";

/** The only skill a solve pass is given. */
export const SKILL_NAME = "agent-solve";

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
 *
 * ## The root is unique per call, and that is load-bearing
 *
 * It used to be `<parentDirectory>/<issueKey>-skill` — derived entirely from the
 * two arguments, so two runs sharing them shared a directory, and this function
 * `rm -rf`s it, `cp -r`s into it and then `chmod`s it read-only. Two of those
 * interleaved is one run deleting another's tree, or copying into one that has
 * already been locked. The loser does not crash: it returns `refused`, the
 * caller reads that as a broken installation, and the pass silently never runs.
 *
 * Measured 2026-09-10, two concurrent calls against one root, 40 rounds: 40
 * prepared, 40 refused, `EEXIST` every time — exactly one loser per pair. It
 * reached us as a flaky test (`orchestrator.test.ts` and `delivery.test.ts` both
 * drive `resolveReview` for `SSX-3822` under `/tmp/solve`) which had passed on
 * the same commit an hour earlier, but nothing about it was specific to tests.
 *
 * `mkdtemp` is the fix because it is the only one that is atomic: checking
 * whether the path is free and then creating it is the same race with a smaller
 * window. Callers must treat the returned path as opaque.
 *
 * **The residual risk, which is not closed.** The old name was self-cleaning —
 * a leftover from a hard-killed run was removed by the next run for the same
 * issue, because it landed on the same path. Unique names give that up, so a
 * `SIGKILL` between staging and the caller's `finally` now leaks one directory
 * per kill instead of overwriting one per issue. That is survivable only by
 * default, where `parentDirectory` is under `tmpdir()` (`wiring.ts`); an
 * operator who configures it elsewhere gets unbounded growth. `sweep-once`
 * (`cli/sweep-once.ts`) is the age-based sweep that answers this, built
 * separately once the collision fix above had its own tests — a hard kill
 * now leaks a directory until an operator runs `sweep-once --write`, rather
 * than forever.
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

  let root: string;
  try {
    // `mkdtemp` will not create the parent, and on the first solve of a run
    // nothing else has.
    await mkdir(parentDirectory, { recursive: true });
    root = await mkdtemp(join(parentDirectory, `${issueKey}-skill-`));
  } catch (error) {
    return {
      outcome: "refused",
      reason: `could not stage the skill under ${parentDirectory}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const destination = join(root, ".claude", "skills", SKILL_NAME);

  try {
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true });
    await lockDown(root);
  } catch (error) {
    // The directory exists by now, and a `refused` result carries no path, so
    // the caller's `finally` has nothing to clean up with. Fail without
    // leaving a locked-down husk behind.
    await removeSkillRoot(root).catch(() => undefined);
    return {
      outcome: "refused",
      reason: `could not stage the skill at ${root}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  logger.info("solve.skillRoot.prepared", { issueKey, path: root });
  return { outcome: "prepared", path: root };
}

/** Removes the staged skill. Absence is not an error; see `removeReadOnlyTree`. */
export async function removeSkillRoot(root: string): Promise<void> {
  await removeReadOnlyTree(root);
}
