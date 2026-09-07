/**
 * Notices when a pass wrote somewhere it was never meant to reach.
 *
 * ## Why this exists, measured rather than assumed
 *
 * Probed 2026-09-07, three runs, each with the exact flag shape `buildSolveArgs`
 * produces:
 *
 * | probe | result |
 * |---|---|
 * | recon flags, cwd in one checkout, `Read` an absolute path in another | **read succeeded** |
 * | fix flags, cwd in a checkout, `Write` outside the worktree | **wrote** |
 * | the same without `--permission-mode dontAsk` | **wrote anyway** |
 *
 * So the worktree is not a boundary, `--add-dir` is not what makes one, and the
 * permission mode is not either. Three doc comments in `runner.ts` said
 * otherwise — the worktree was "the session's whole world", and the fix pass
 * could "change files in its worktree and do nothing else with them" — and they
 * were rewritten in the commit that added this file.
 *
 * The gap this closes is specific and it is not covered by anything else here.
 * `diff-gate.ts` is the only mechanical bound on what a run changed, and it
 * parses `git diff` **inside the worktree**. A write into a sibling checkout
 * never enters that diff, so it is not refused — it is invisible. Every check
 * this service runs would pass.
 *
 * ## Detection, not prevention, and the honest reason
 *
 * This notices afterwards. Preventing the write needs a `PreToolUse` hook, which
 * is the one mechanism observed to actually gate a solve subprocess — that is
 * what denied the SSX-3832 write pass its `Write` tool. Installing one from here
 * is a separate change and a bigger one, so this is the bound that exists in the
 * meantime rather than the bound that should exist forever.
 *
 * ## What it cannot see, stated rather than papered over
 *
 * `git status` does not report ignored files, so a write to an ignored path does
 * not appear here — and on a developer's checkout the ignored set includes local
 * configuration that holds secrets. Listing ignored files instead would mean
 * walking every dependency directory in every checkout on every pass, which is
 * not affordable and would make the guard something an operator switches off. So
 * this covers changes to tracked and untracked files, and the ignored-path case
 * stays open and is named in `PLAN.md` rather than quietly excluded.
 */

import type { CommandRunner } from "./worktree.ts";

/**
 * One checkout, as it looked at one instant.
 *
 * `status` is opaque on purpose: nothing here interprets it, it is only ever
 * compared with itself. Parsing it would create a second place that has to know
 * git's porcelain format, and the only question being asked is "is this the same
 * string as before".
 */
export interface RepoState {
  readonly path: string;
  readonly status: string;
}

/**
 * The marker recorded when a checkout cannot be inspected at all.
 *
 * A directory that is missing, or not a repository, still gets an entry rather
 * than being dropped. Dropping it would mean a guard that silently stops
 * guarding the moment a path is mistyped, which is the failure mode this
 * project keeps finding in its own tests. Two unreadable snapshots compare
 * equal, so a consistently broken path is quiet; a path that becomes readable
 * or stops being readable mid-run reads as a change, which is loud and correct
 * — something moved under the run.
 *
 * The leading space makes it unspellable by git: porcelain output never begins
 * a line with a space followed by a letter at column two, so no real working
 * tree can forge this value and compare equal to an unreadable one.
 */
export const UNREADABLE = " unreadable";

/**
 * Reads every checkout's working tree in one pass.
 *
 * `-uall` rather than the default: the default collapses a new directory to one
 * entry, and "a directory appeared" is exactly the shape a stray write takes.
 * `--porcelain` because the human-readable format is localised, and this string
 * is compared, not read.
 */
export async function snapshotRepos(
  commands: CommandRunner,
  dirs: readonly string[],
  timeoutMs: number,
): Promise<readonly RepoState[]> {
  const states: RepoState[] = [];
  for (const path of dirs) {
    // Sequential rather than concurrent. These are git invocations against
    // local disk, so the wall-clock saving is small, and a run that fans out
    // across every checkout the operator owns is a worse neighbour to whatever
    // else is using them.
    const result = await commands.run(["git", "-C", path, "status", "--porcelain", "-uall"], {
      cwd: path,
      timeoutMs,
    });
    states.push({
      path,
      // A timeout is not an empty working tree. Without this, killing the
      // status call would produce "", which compares equal to a clean checkout
      // and turns the guard off exactly when the machine is unhealthy.
      status: result.exitCode === 0 && !result.timedOut ? result.stdout : UNREADABLE,
    });
  }
  return states;
}

/**
 * The checkouts that changed between two snapshots.
 *
 * Compared by path rather than by position, so the two snapshots do not have to
 * have been taken over the same list in the same order. A path present in one
 * and absent from the other counts as changed: the alternative is to ignore it,
 * and an entry disappearing between the two reads is not a thing that should be
 * resolved into "nothing happened".
 */
export function escapedRepos(
  before: readonly RepoState[],
  after: readonly RepoState[],
): readonly string[] {
  const start = new Map(before.map((state) => [state.path, state.status]));
  const end = new Map(after.map((state) => [state.path, state.status]));
  const escaped: string[] = [];
  for (const path of new Set([...start.keys(), ...end.keys()])) {
    if (start.get(path) !== end.get(path)) {
      escaped.push(path);
    }
  }
  return escaped.toSorted();
}

/**
 * One sentence naming what moved, for a refusal a person has to act on.
 *
 * Names every path rather than a count. A refusal that says "2 repositories
 * changed" sends the reader to look for them, and the reader is the person who
 * has to decide whether it was the solve or their own editor.
 */
export function describeEscape(paths: readonly string[]): string {
  return `changed outside the worktree during this run: ${paths.join(", ")}`;
}
