/**
 * Locking and removing a directory staged for a model to read.
 *
 * Two things here are staged: the `agent-solve` skill (`solve/skill-root.ts`)
 * and a ticket's image attachments (`attachments/stage.ts`). Both hand a
 * directory to a session that may pre-approve `Write`, so both want the same
 * guarantee, and one copy of it is the point of this module.
 *
 * Directories are `0o555` rather than only the files being `0o444`, because on
 * a POSIX filesystem it is write permission on the *directory* that governs
 * creating and unlinking entries. Files-only would leave a model free to delete
 * a staged file and write its own in its place.
 *
 * Verified 2026-09-04 against the skill root: a session with `Write`
 * pre-approved and the directory added could neither overwrite a file in it nor
 * create one, and the original content survived.
 */

import { chmod, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const DIRECTORY_MODE_READ_ONLY = 0o555;
const FILE_MODE_READ_ONLY = 0o444;
const DIRECTORY_MODE_WRITABLE = 0o755;
const FILE_MODE_WRITABLE = 0o644;

/** Read-only, depth-first: children before the directory that contains them. */
export async function lockDown(path: string): Promise<void> {
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
 * Removes a staged tree, unlocking it first.
 *
 * `rm` cannot delete an entry inside a `0o555` directory, so the unlock is not
 * tidiness — without it every run would leave one behind. Absence is not an
 * error: this is called on cleanup paths, including after staging refused
 * before it created anything.
 */
export async function removeReadOnlyTree(path: string): Promise<void> {
  try {
    await stat(path);
  } catch {
    return;
  }
  await unlock(path);
  await rm(path, { recursive: true, force: true });
}
