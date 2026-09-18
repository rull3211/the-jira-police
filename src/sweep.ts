/**
 * Walks both staging parent directories, classifies what it finds, and —
 * when told to — removes what is stale.
 *
 * A library module rather than logic inlined in `cli/sweep-once.ts`, the same
 * split `watch/sweep.ts` makes for the sendback watch: the I/O here — a
 * `readdir`, a `stat` per entry, and, under `write`, an actual removal — is
 * exactly the half worth testing against a real directory, and
 * `cli/sweep-once.ts` ends in a top-level `await`, which is what makes
 * importing it into a test run the command instead of just the logic.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { removeReadOnlyTree } from "./read-only-tree.ts";
import { planSweep, type StagingEntry, type StagingVerdict } from "./staging-sweep.ts";

export interface SweepGroup {
  readonly parentDirectory: string;
  readonly verdicts: readonly StagingVerdict[];
}

export interface SweepResult {
  readonly groups: readonly SweepGroup[];
  readonly removed: number;
}

/**
 * A parent directory's entries with their mtime, or none if the directory
 * does not exist yet — the common case on a machine that has never solved or
 * staged anything.
 */
async function listEntries(parentDirectory: string): Promise<readonly StagingEntry[]> {
  let names: readonly string[];
  try {
    names = await readdir(parentDirectory);
  } catch {
    return [];
  }
  const entries: StagingEntry[] = [];
  for (const name of names) {
    try {
      const info = await stat(join(parentDirectory, name));
      entries.push({ name, mtimeMs: info.mtimeMs });
    } catch {
      // Gone since the `readdir` — most likely another run's own cleanup
      // landing between the two calls. Nothing to report on an entry that no
      // longer exists.
    }
  }
  return entries;
}

/**
 * Reports on, and when `write` is true removes, every stale entry
 * `staging-sweep.ts` recognises under each parent directory.
 *
 * Every directory in `parentDirectories` is walked and reported, including
 * one that does not exist — an empty group rather than a throw, so a fresh
 * checkout that has never solved or staged anything reports cleanly rather
 * than failing on the directory it has not created yet.
 */
export async function runSweep(
  parentDirectories: readonly string[],
  now: number,
  maxAgeMs: number,
  write: boolean,
): Promise<SweepResult> {
  const groups: SweepGroup[] = [];
  let removed = 0;

  for (const parentDirectory of parentDirectories) {
    const entries = await listEntries(parentDirectory);
    const verdicts = planSweep(entries, now, maxAgeMs);
    groups.push({ parentDirectory, verdicts });

    if (!write) {
      continue;
    }
    for (const verdict of verdicts) {
      if (!verdict.sweep) {
        continue;
      }
      await removeReadOnlyTree(join(parentDirectory, verdict.name));
      removed += 1;
    }
  }

  return { groups, removed };
}
