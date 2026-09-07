/**
 * Bringing a pull request's branch up to date with its base, before a round
 * spends anything on it.
 *
 * ## The invoice that asked for this
 *
 * PR #2661, 2026-09-07. One inline nitpick from a human reviewer produced
 * seventeen consecutive identical review rounds and stopped only when
 * `MAX_PR_ROUNDS_TOTAL` fired at twenty, for about $16. Every round did the
 * same four things: attach, reserve, pay for a review pass that wrote the
 * correct rename, and then refuse at verification because `pnpm install` could
 * not run. No commit, no push, and — because the round never got far enough to
 * reply — no comment on the thread, so `unansweredThreads` handed the reviewer's
 * comment straight back to the next tick.
 *
 * The install failed for one reason: `origin/main` had gained
 * `"packageManager": "pnpm@9.15.9"`, which makes pnpm 11 switch versions and
 * read the lockfile correctly, and **the branch had been cut before that merge**.
 * The repository was fixed; the branch had not heard. Seven commits behind main
 * was the whole of it.
 *
 * That is not a pnpm story. A branch drifts from its base the moment somebody
 * merges anything, and everything a branch inherits from its base — the
 * toolchain declaration, the lockfile, CI config, the shared code the diff
 * compiles against — is a thing that can be fixed on `main` while a pull request
 * under review keeps failing on the old copy. The reviewer sees a red build and
 * a bot that keeps not fixing it.
 *
 * ## Merge and push, not merge and hold
 *
 * The merge is pushed in the same breath as it is made, and that ordering was
 * chosen rather than fallen into. `attachWorktree` reuses a checkout only after
 * proving it is **not ahead of `origin`**, on the argument that commits the
 * reviewer has never seen must not be built on. A merge left sitting locally
 * violates exactly that invariant, so the next tick would salvage the checkout,
 * move it aside, and rebuild — which is how one wedged pull request produced
 * fifteen `-salvaged-` directories in a week. Pushing keeps the invariant true
 * and keeps `origin` the single answer to *what is on this branch*.
 *
 * ## Why this runs before the reservation and not inside the round
 *
 * `advance` attaches at a point where a failure is a **failed start** —
 * `recordFailedStart`, bounded by `MAX_FAILED_STARTS` at three — and everything
 * after `runRound`'s reservation is a **round**, bounded at twenty and each one
 * paid for. #2661 spent twenty because its failure surfaced on the expensive
 * side of that line. Anything here that cannot be resolved must therefore refuse
 * from the attach path, where three cheap attempts stall the pull request for a
 * human instead of buying seventeen more copies of the same answer.
 *
 * ## Conflicts are reported, never resolved silently, and never left in place
 *
 * A conflicted merge is aborted before this function returns, and the paths are
 * handed back for a caller to act on. Two things it deliberately does not do:
 *
 * - **No `-X ours` or `-X theirs`.** A whole-side strategy resolves a conflict
 *   by discarding one author's change unread, and it does it to every file at
 *   once. That is the one outcome worse than refusing.
 * - **No half-finished merge left on disk.** Conflict markers in the working
 *   tree are uncommitted changes, so leaving them would make the next tick's
 *   reuse check salvage the checkout — the loop would tidy away the very state
 *   the resolver was supposed to look at. The merge is cheap to redo and
 *   deterministic, so the resolver re-runs it under its own supervision.
 */

import { logger } from "../logger.ts";
import { isWorkBranch } from "./branch.ts";
import type { BotIdentity } from "./pr.ts";
import { attachWorktree, BASE_REF, failed, why } from "./worktree.ts";
import type { AttachRequest, CommandOptions, CommandRunner, WorktreeResult } from "./worktree.ts";

export interface BaseSyncRequest {
  readonly issueKey: string;
  /** The branch the checkout is on, as a bare name. */
  readonly branch: string;
  /** The checkout to merge in, which is a linked worktree of the repository. */
  readonly worktreePath: string;
  /** The base to merge from, as a remote-tracking ref — `origin/main`. */
  readonly baseRef: string;
  /** Whose name goes on the merge commit. See `pr.ts`. */
  readonly identity: BotIdentity;
  readonly timeoutMs: number;
}

export type BaseSyncResult =
  /** Already contains the base. Nothing was run beyond the two reads. */
  | { readonly outcome: "current" }
  /** Merged and pushed; `origin` now has the merge. */
  | { readonly outcome: "merged"; readonly behind: number }
  /** The merge conflicts and has been aborted. `files` are the conflicted paths. */
  | { readonly outcome: "conflicted"; readonly behind: number; readonly files: readonly string[] }
  /** Nothing was changed, and the caller should treat this as a failed start. */
  | { readonly outcome: "refused"; readonly reason: string };

/**
 * How many conflicted paths are reported.
 *
 * A conflict spanning half the repository is a statement about the branch
 * rather than a list to work through, and the number is in `behind` either way.
 */
const MAX_CONFLICT_FILES = 20;

/**
 * Nothing was changed and the caller should count a failed start.
 *
 * Every refusal in this module is reachable only from a point where no commit
 * has been made or every commit made has been undone, which is the property
 * that lets the caller treat all of them the same way.
 */
const refuse = (reason: string): BaseSyncResult => ({ outcome: "refused", reason });

/**
 * Merges the base into the checkout and pushes the result, or explains itself.
 *
 * Reads first and writes only if it must: a branch that already contains its
 * base costs two `rev-parse`-class commands and returns `current`.
 */
export async function syncWithBase(
  runner: CommandRunner,
  request: BaseSyncRequest,
): Promise<BaseSyncResult> {
  const { issueKey, branch, worktreePath, baseRef, identity, timeoutMs } = request;
  const opts: CommandOptions = { cwd: worktreePath, timeoutMs };
  const git = (...argv: readonly string[]): readonly string[] => [
    "git",
    "-C",
    worktreePath,
    ...argv,
  ];

  // Re-checked here rather than assumed of the caller, for the reason
  // `attachWorktree` re-checks it: this function makes a commit and pushes it,
  // and *"the agent may never work on main or any protected branch, never"* is
  // not a rule that can rest on one call site having got it right.
  if (!isWorkBranch(branch)) {
    return refuse(
      `${JSON.stringify(branch)} is not an implementation branch, so nothing will be merged into it`,
    );
  }
  if (!BASE_REF.test(baseRef)) {
    return refuse(
      `${JSON.stringify(baseRef)} is not a remote-tracking ref — the base is configuration, and a malformed one is a misconfiguration rather than something to interpret`,
    );
  }

  // The caller fetched. Resolving the base explicitly separates "the base is
  // gone" from "the merge failed", which git reports with the same exit code.
  const base = await runner.run(
    git("rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`),
    opts,
  );
  if (failed(base)) {
    return refuse(`base ref ${baseRef} does not resolve to a commit (${why(base)})`);
  }

  // Checked even though `attachWorktree` has just proved the checkout clean,
  // because a merge onto a dirty tree commits whatever it finds — and a merge
  // commit is the least likely place anyone would look for a human's lost
  // afternoon. Cheap, and the alternative is unrecoverable.
  const status = await runner.run(git("status", "--porcelain"), opts);
  if (failed(status)) {
    return refuse(`could not read the state of ${worktreePath} (${why(status)})`);
  }
  if (status.stdout.trim() !== "") {
    return refuse(
      `${worktreePath} has uncommitted changes, and a merge would sweep them into a commit nobody would think to look in`,
    );
  }

  const counted = await runner.run(git("rev-list", "--count", `HEAD..${baseRef}`), opts);
  if (failed(counted)) {
    return refuse(`could not compare ${worktreePath} with ${baseRef} (${why(counted)})`);
  }
  const behind = Number(counted.stdout.trim());
  if (!Number.isInteger(behind)) {
    // Refused rather than read as zero. Zero is the answer that skips the merge
    // entirely, so an unparseable count read that way is #2661 again: a stale
    // branch declared current, and the round pays to discover otherwise.
    return refuse(
      `could not read how far ${worktreePath} is behind ${baseRef} — git answered ${JSON.stringify(counted.stdout.trim().slice(0, 100))}`,
    );
  }
  if (behind === 0) {
    return { outcome: "current" };
  }

  // `--no-edit` takes git's own summary line. Not a message of our own: the
  // pilot repository runs commitlint on every commit, whose default ignores
  // cover git's merge wording and would reject a hand-written subject that did
  // not happen to be Conventional Commits.
  //
  // `-c` before `-C`, per `pr.ts`: passing the identity per invocation means it
  // cannot be left behind in the worktree's config for whatever runs next.
  const merged = await runner.run(
    [
      "git",
      "-c",
      `user.name=${identity.name}`,
      "-c",
      `user.email=${identity.email}`,
      "-C",
      worktreePath,
      "merge",
      "--no-edit",
      baseRef,
    ],
    opts,
  );
  if (failed(merged)) {
    const conflicts = await runner.run(git("diff", "--name-only", "--diff-filter=U"), opts);
    const files = failed(conflicts)
      ? []
      : conflicts.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "");

    // Aborted whether or not the paths could be read, and the abort's own
    // failure does not change the answer: what matters is that no half-merged
    // tree is left for the next tick's reuse check to salvage. A failed abort
    // is logged and the checkout is unusable either way, which the caller finds
    // out on the next attach rather than being told twice here.
    const aborted = await runner.run(git("merge", "--abort"), opts);
    if (failed(aborted)) {
      logger.error("solve.base.abort_failed", { issueKey, branch, reason: why(aborted) });
    }

    if (files.length === 0) {
      // No conflicted paths means the merge failed for some other reason — a
      // hook, a lock, an unrelated local modification git noticed first — and
      // that is not something a resolver can be handed.
      return refuse(`could not merge ${baseRef} into ${branch} (${why(merged)})`);
    }
    logger.warn("solve.base.conflicted", {
      issueKey,
      branch,
      baseRef,
      behind,
      files: files.slice(0, MAX_CONFLICT_FILES),
    });
    return { outcome: "conflicted", behind, files: files.slice(0, MAX_CONFLICT_FILES) };
  }

  const pushed = await runner.run(git("push", "origin", branch), opts);
  if (failed(pushed)) {
    // Undone, because a merge that only exists locally is the state
    // `attachWorktree` salvages: next tick sees the checkout ahead of `origin`,
    // moves it aside and rebuilds. `ORIG_HEAD` is set by the merge itself and
    // names the commit this branch was on a moment ago, so this discards our
    // own merge commit and nothing else — the tree was proved clean above, so
    // there is no other work here to lose.
    const undone = await runner.run(git("reset", "--hard", "ORIG_HEAD"), opts);
    if (failed(undone)) {
      logger.error("solve.base.undo_failed", { issueKey, branch, reason: why(undone) });
    }
    return refuse(`merged ${baseRef} into ${branch} but could not push it (${why(pushed)})`);
  }

  logger.info("solve.base.merged", { issueKey, branch, baseRef, behind });
  return { outcome: "merged", behind };
}

export interface SyncedAttachRequest extends AttachRequest {
  readonly baseRef: string;
  readonly identity: BotIdentity;
}

/**
 * A checkout for a review round: attached to the branch, and current with base.
 *
 * **One function because there are two call sites**, `runAdvance` and the
 * daemon's review act, and they are already near-identical closures that a
 * change has to be made to twice. `createReviewAct`'s refused-checkout branch is
 * the last thing that drifted between that pair, and it ran against PR #2663
 * every two minutes for four days recording nothing; the fix for a duplicated
 * branch is to stop duplicating it, not to remember harder.
 *
 * The signature is `attachWorktree`'s, so callers keep the `WorktreeSource`
 * shape and nothing downstream learns a new outcome. That is a deliberate limit
 * on this change rather than the finished design: a conflicted merge is
 * currently a refusal, which stalls the pull request for a human after
 * `MAX_FAILED_STARTS` attempts. Handing the conflict to a pass that tries to
 * resolve it needs an outcome `delivery.ts` can route on, and that is the next
 * commit — the point of doing it second is that the resolver must not be the
 * thing that first proves this plumbing works.
 */
export async function attachSynced(
  runner: CommandRunner,
  request: SyncedAttachRequest,
): Promise<WorktreeResult> {
  const attached = await attachWorktree(runner, request);
  if (attached.outcome === "refused") {
    return attached;
  }

  const synced = await syncWithBase(runner, {
    issueKey: attached.worktree.issueKey,
    // The attached worktree's branch, not the request's. They agree today, and
    // the one that decides what gets a merge commit should be the one git
    // confirmed rather than the one a pull request supplied.
    branch: attached.worktree.branch,
    worktreePath: attached.worktree.path,
    baseRef: request.baseRef,
    identity: request.identity,
    timeoutMs: request.timeoutMs,
  });

  if (synced.outcome === "refused") {
    return { outcome: "refused", issueKey: request.issueKey, reason: synced.reason };
  }
  if (synced.outcome === "conflicted") {
    return {
      outcome: "refused",
      issueKey: request.issueKey,
      reason: `${request.branch} is ${String(synced.behind)} commit(s) behind ${request.baseRef} and the merge conflicts in ${synced.files.join(", ")} — the branch has to be brought up to date before a round can verify anything against it`,
    };
  }

  return attached;
}
