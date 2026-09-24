/**
 * A review round's declared widening, checked against who GitHub says spoke and what the pull request
 * already changed. Pure, like `diff-gate.ts`; a widening the pass does not declare is not seen here.
 */

import type { WidenedChange } from "./runner.ts";

/** `Comment 3` and `comment 3` cite the same comment; a thread id is compared exactly. */
function sourceOf(requestedBy: string): string {
  const trimmed = requestedBy.trim();
  const numbered = /^comment\s+(\d+)$/iu.exec(trimmed);
  return numbered === null ? trimmed : `comment ${String(Number(numbered[1]))}`;
}

/** Every reason the declared widenings exceed what `memberSources` and the pull request's own files grant, collected rather than the first. */
export function checkWidening(
  widened: readonly WidenedChange[],
  members: ReadonlySet<string>,
  pullRequestFiles: ReadonlySet<string>,
): readonly string[] {
  return widened.flatMap((change) => [
    ...(members.has(sourceOf(change.requestedBy))
      ? []
      : [
          `${JSON.stringify(change.path)} was widened on the word of ${JSON.stringify(change.requestedBy)}, which is not a comment or thread a repository member wrote in the feedback this round was shown`,
        ]),
    ...(pullRequestFiles.has(change.path)
      ? []
      : [
          `${JSON.stringify(change.path)} was widened, but the pull request had not changed it before this round — a member's request reaches only the files already under review`,
        ]),
  ]);
}
