/**
 * Notices when a pass wrote somewhere it was never meant to reach — `diff-gate.ts` only ever
 * inspects the worktree, so an escaped write is invisible to every other check this service runs.
 * Detects afterward rather than preventing; prevention needs a `PreToolUse` hook.
 * `git status` does not report ignored files, so a write to an ignored path is invisible here
 * too (tracked in `PLAN.md`).
 */

import type { CommandRunner } from "./worktree.ts";

/** One checkout, as it looked at one instant. `status` is opaque: only ever compared, never parsed. */
export interface RepoState {
  readonly path: string;
  readonly status: string;
}

/**
 * The marker recorded when a checkout cannot be inspected at all — a mistyped path stays
 * watched rather than being dropped. The leading space makes it unspellable by real git
 * porcelain output, so no working tree can forge this value.
 */
export const UNREADABLE = " unreadable";

/**
 * Reads every checkout's working tree in one pass.
 * `-uall`: the default collapses a new directory into one entry, hiding the shape a stray
 * write takes. `--porcelain`: the human-readable format is localised, and this string is
 * only ever compared, never read.
 */
export async function snapshotRepos(
  commands: CommandRunner,
  dirs: readonly string[],
  timeoutMs: number,
): Promise<readonly RepoState[]> {
  const states: RepoState[] = [];
  for (const path of dirs) {
    // Sequential, not concurrent: fanning out across every checkout the operator owns is a worse neighbour for negligible savings.
    const result = await commands.run(["git", "-C", path, "status", "--porcelain", "-uall"], {
      cwd: path,
      timeoutMs,
    });
    states.push({
      path,
      // A timeout must not read as "", which would compare equal to a clean checkout.
      status: result.exitCode === 0 && !result.timedOut ? result.stdout : UNREADABLE,
    });
  }
  return states;
}

/**
 * The checkouts that changed between two snapshots, compared by path (not position). A path
 * present in only one counts as changed rather than being ignored.
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

/** One sentence naming what moved, for a refusal a person has to act on. Names every path rather than a count. */
export function describeEscape(paths: readonly string[]): string {
  return `changed outside the worktree during this run: ${paths.join(", ")}`;
}
