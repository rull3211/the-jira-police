/**
 * Locking and removing a directory staged for a model to read.
 *
 * Directories are made `0o555` rather than only their files `0o444`: on a POSIX filesystem it is
 * write permission on the *directory* that governs creating and unlinking entries, so files-only
 * would leave a model free to delete a staged file and write its own in its place.
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
 * Removes a staged tree, unlocking it first since `rm` cannot delete an entry inside a `0o555`
 * directory. Absence is not an error: this also runs on cleanup paths after staging refused
 * before creating anything.
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
