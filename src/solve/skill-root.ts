/**
 * A throwaway, read-only copy of the `agent-solve` skill, for the pass to read.
 *
 * The pass runs with its working directory set to the worktree, so Claude Code's skill discovery
 * (working directory and `--add-dir`) never points at this repository's own `.claude/skills/`.
 * `--add-dir <the-jira-police>` would fix that, but the fix/simplify/review passes pre-approve
 * `Write`/`Edit`, so it would also make this repository — including `runner.ts` and `diff-gate.ts` —
 * writable by the pass with no check ever seeing the edit, since the diff gate only inspects the
 * worktree. So the pass gets a directory containing only the skill, staged read-only per run so
 * `fix` cannot rewrite the skill that `simplify`/`review` read later in the same run.
 * The source path is derived from `import.meta.dirname`, never configurable, so a typo can't repoint
 * which instructions the solver follows.
 */

import { cp, mkdir, mkdtemp, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { logger } from "../logger.ts";
import { lockDown, removeReadOnlyTree } from "../read-only-tree.ts";

/** The only skill a solve pass is given. */
export const SKILL_NAME = "agent-solve";

/** Exported so a test can assert the skill is actually there; the failure mode of a wrong path is a pass that resolves no skill. */
export function sourceSkillDirectory(): string {
  return join(import.meta.dirname, "..", "..", ".claude", "skills", SKILL_NAME);
}

export type SkillRootResult =
  | { readonly outcome: "prepared"; readonly path: string }
  | { readonly outcome: "refused"; readonly reason: string };

/**
 * Builds the skill root for one run, or refuses (matching `createWorktree`) rather than throwing.
 *
 * The root's path is unique per call (`mkdtemp`, the only atomic option) rather than derived from
 * `<parentDirectory>/<issueKey>-skill`, because two concurrent runs sharing a derived path could
 * race to `rm -rf`/`cp -r`/`chmod` it — the loser returns `refused` instead of corrupting the
 * winner's tree. Callers must treat the returned path as opaque.
 *
 * Residual risk, not closed: the old derived name was self-cleaning across a hard-killed run;
 * unique names leak one directory per `SIGKILL` between staging and the caller's `finally` instead.
 * `sweep-once` (`cli/sweep-once.ts`) reclaims a leaked root by age, so it lasts until the next
 * `sweep-once --write` rather than forever.
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
    // `mkdtemp` will not create the parent, and on the first solve of a run nothing else has.
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
    // A `refused` result carries no path, so the caller's `finally` cannot clean this up itself.
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
