/**
 * Merges a pull request's branch up to date with its base before a round runs.
 * Conflicts are never auto-resolved: `syncWithBase` aborts and reports paths,
 * `beginMerge` hands a resolver an in-progress merge owed a `commitMerge` or `abortMerge`.
 */

import { logger } from "../logger.ts";
import { isWorkBranch } from "./branch.ts";
import type { BotIdentity } from "./pr.ts";
import { attachWorktree, BASE_REF, failed, why } from "./worktree.ts";
import type {
  AttachRequest,
  CommandOptions,
  CommandResult,
  CommandRunner,
  Worktree,
  WorktreeResult,
} from "./worktree.ts";

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

/** Cap on reported conflicted paths; a conflict spanning half the repo is a statement about the branch, not a list to work through. */
const MAX_CONFLICT_FILES = 20;

/** Every refusal here is reachable only where no commit was made, or every commit made has been undone. */
const refuse = (reason: string): BaseSyncResult => ({ outcome: "refused", reason });

/** git, in the checkout, as nobody in particular — for reads and for `--abort`. */
const gitIn = (worktreePath: string, ...argv: readonly string[]): readonly string[] => [
  "git",
  "-C",
  worktreePath,
  ...argv,
];

/** `-c` must precede `-C`: after `-C` git reads them as subcommand args and the commit gets attributed to whatever global config the machine has, or nobody. */
const signedGit = (
  worktreePath: string,
  identity: BotIdentity,
  ...argv: readonly string[]
): readonly string[] => [
  "git",
  "-c",
  `user.name=${identity.name}`,
  "-c",
  `user.email=${identity.email}`,
  "-C",
  worktreePath,
  ...argv,
];

/** The paths git says are conflicted, capped. Empty on a failed read must not be taken as "resolved" — both callers fail closed on that. */
export async function conflictedPaths(
  runner: CommandRunner,
  worktreePath: string,
  timeoutMs: number,
): Promise<readonly string[]> {
  const conflicts = await runner.run(
    gitIn(worktreePath, "diff", "--name-only", "--diff-filter=U"),
    { cwd: worktreePath, timeoutMs },
  );
  if (failed(conflicts)) {
    return [];
  }
  return conflicts.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, MAX_CONFLICT_FILES);
}

/** Puts the checkout back the way it was found. Called on every path that leaves a merge unfinished, since a half-merged tree makes the next tick's reuse check salvage it. */
export async function abortMerge(
  runner: CommandRunner,
  worktreePath: string,
  timeoutMs: number,
): Promise<boolean> {
  const aborted = await runner.run(gitIn(worktreePath, "merge", "--abort"), {
    cwd: worktreePath,
    timeoutMs,
  });
  if (failed(aborted)) {
    logger.error("solve.base.abort_failed", { worktreePath, reason: why(aborted) });
    return false;
  }
  return true;
}

/** Commits a resolved merge. `--no-edit` keeps git's own merge wording, which commitlint's default ignores are written against. */
export async function commitMerge(
  runner: CommandRunner,
  request: Pick<BaseSyncRequest, "worktreePath" | "identity" | "timeoutMs">,
): Promise<CommandResult> {
  const { worktreePath, identity, timeoutMs } = request;
  return await runner.run(signedGit(worktreePath, identity, "commit", "--no-edit"), {
    cwd: worktreePath,
    timeoutMs,
  });
}

export type PushResult =
  | { readonly outcome: "pushed" }
  /** The push failed and the merge has been undone. Nothing is left locally. */
  | { readonly outcome: "refused"; readonly reason: string };

/**
 * Pushes the branch, undoing the merge if the push fails, so `origin` stays the single
 * answer to what's on the branch. `ORIG_HEAD` names the pre-merge commit and is untouched
 * by `git commit`, so this discards only our merge commit.
 */
export async function pushBranch(
  runner: CommandRunner,
  request: Pick<BaseSyncRequest, "issueKey" | "branch" | "worktreePath" | "timeoutMs">,
): Promise<PushResult> {
  const { issueKey, branch, worktreePath, timeoutMs } = request;
  const opts: CommandOptions = { cwd: worktreePath, timeoutMs };

  const pushed = await runner.run(gitIn(worktreePath, "push", "origin", branch), opts);
  if (!failed(pushed)) {
    return { outcome: "pushed" };
  }

  const undone = await runner.run(gitIn(worktreePath, "reset", "--hard", "ORIG_HEAD"), opts);
  if (failed(undone)) {
    logger.error("solve.base.undo_failed", { issueKey, branch, reason: why(undone) });
  }
  return {
    outcome: "refused",
    reason: `merged into ${branch} but could not push it (${why(pushed)})`,
  };
}

export type ResolutionCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** Every `false` from {@link acceptResolution} leaves a merge in progress; the caller owes the checkout an abort. */
const decline = (reason: string): ResolutionCheck => ({ ok: false, reason });

/** `=======` is deliberately excluded — it's a legal Markdown heading underline and would falsely refuse correct resolutions. */
const CONFLICT_MARKER = "^(<<<<<<<|>>>>>>>|\\|\\|\\|\\|\\|\\|\\|) ";

/**
 * Checks that a resolution resolved the conflict and nothing else, asking git rather
 * than trusting the model's own report of what it changed.
 * Verifies: no paths still unmerged, no conflict markers left staged, nothing outside
 * the conflicted set touched (staged or new).
 */
export async function acceptResolution(
  runner: CommandRunner,
  request: {
    readonly worktreePath: string;
    /** The paths git marked conflicted, read before the pass ran. */
    readonly conflicted: readonly string[];
    readonly timeoutMs: number;
  },
): Promise<ResolutionCheck> {
  const { worktreePath, conflicted, timeoutMs } = request;
  const opts: CommandOptions = { cwd: worktreePath, timeoutMs };

  // Exactly the paths git marked, never `-A` — staging is what says "resolved", so staging an uncomplained-about path answers a question nobody asked.
  const staged = await runner.run(gitIn(worktreePath, "add", "--", ...conflicted), opts);
  if (failed(staged)) {
    return decline(`could not stage the resolved files (${why(staged)})`);
  }

  const unmerged = await conflictedPaths(runner, worktreePath, timeoutMs);
  if (unmerged.length > 0) {
    return decline(`still unmerged after the pass: ${unmerged.join(", ")}`);
  }

  // Exit 1 from `git grep` is "no matches"; anything above 1 is git failing to look, which fails closed.
  const markers = await runner.run(
    gitIn(worktreePath, "grep", "-I", "-n", "-E", CONFLICT_MARKER, "--", ...conflicted),
    opts,
  );
  if (markers.timedOut || markers.exitCode > 1) {
    return decline(`could not check for leftover conflict markers (${why(markers)})`);
  }
  if (markers.exitCode === 0) {
    return decline(
      `conflict markers are still in the tree: ${markers.stdout.trim().slice(0, 300)}`,
    );
  }

  const stray = await runner.run(gitIn(worktreePath, "diff", "--name-only"), opts);
  if (failed(stray)) {
    return decline(`could not check what else the pass changed (${why(stray)})`);
  }
  if (stray.stdout.trim() !== "") {
    return decline(
      `the pass changed files the merge did not conflict on: ${stray.stdout.trim().split("\n").join(", ").slice(0, 300)}`,
    );
  }

  const untracked = await runner.run(
    gitIn(worktreePath, "ls-files", "--others", "--exclude-standard"),
    opts,
  );
  if (failed(untracked)) {
    return decline(`could not check for new files (${why(untracked)})`);
  }
  if (untracked.stdout.trim() !== "") {
    return decline(
      `the pass left new files behind: ${untracked.stdout.trim().split("\n").join(", ").slice(0, 300)}`,
    );
  }

  return { ok: true };
}

/**
 * Merges the base in and stops there, including when it conflicts — the only function here
 * that can return with a merge still in progress, a handover owed a {@link commitMerge} or
 * {@link abortMerge}. See {@link syncWithBase} for a version that resolves both endings itself.
 */
export async function beginMerge(
  runner: CommandRunner,
  request: BaseSyncRequest,
): Promise<BaseSyncResult> {
  const { issueKey, branch, worktreePath, baseRef, identity, timeoutMs } = request;
  const opts: CommandOptions = { cwd: worktreePath, timeoutMs };
  const git = (...argv: readonly string[]): readonly string[] => gitIn(worktreePath, ...argv);

  // Re-checked rather than assumed of the caller: this function commits and pushes, and "never work on a protected branch" cannot rest on one call site.
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

  // Resolving the base explicitly separates "the base is gone" from "the merge failed", which git reports with the same exit code.
  const base = await runner.run(
    git("rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`),
    opts,
  );
  if (failed(base)) {
    return refuse(`base ref ${baseRef} does not resolve to a commit (${why(base)})`);
  }

  // Re-checked despite `attachWorktree`'s prior clean check: a merge onto a dirty tree commits whatever it finds, unrecoverably.
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
    // Refused rather than read as zero, which would skip the merge and declare a stale branch current.
    return refuse(
      `could not read how far ${worktreePath} is behind ${baseRef} — git answered ${JSON.stringify(counted.stdout.trim().slice(0, 100))}`,
    );
  }
  if (behind === 0) {
    return { outcome: "current" };
  }

  // `--no-edit` keeps git's own summary line, which commitlint's default ignores are written against.
  const merged = await runner.run(
    signedGit(worktreePath, identity, "merge", "--no-edit", baseRef),
    opts,
  );
  if (!failed(merged)) {
    return { outcome: "merged", behind };
  }

  const files = await conflictedPaths(runner, worktreePath, timeoutMs);
  if (files.length === 0) {
    // No conflicted paths means the merge failed for some other reason (hook, lock, ...) that a resolver can't be handed.
    await abortMerge(runner, worktreePath, timeoutMs);
    return refuse(`could not merge ${baseRef} into ${branch} (${why(merged)})`);
  }
  logger.warn("solve.base.conflicted", { issueKey, branch, baseRef, behind, files });
  return { outcome: "conflicted", behind, files };
}

/** {@link beginMerge} plus the two endings a caller who cannot resolve a conflict needs: push what merged cleanly, abort what did not. */
export async function syncWithBase(
  runner: CommandRunner,
  request: BaseSyncRequest,
): Promise<BaseSyncResult> {
  const { issueKey, branch, worktreePath, baseRef, timeoutMs } = request;

  const started = await beginMerge(runner, request);
  if (started.outcome === "conflicted") {
    // Aborted regardless of outcome, so no half-merged tree is left for the next tick's reuse check to salvage.
    await abortMerge(runner, worktreePath, timeoutMs);
    return started;
  }
  if (started.outcome !== "merged") {
    return started;
  }

  const pushed = await pushBranch(runner, request);
  if (pushed.outcome === "refused") {
    return refuse(pushed.reason);
  }

  logger.info("solve.base.merged", { issueKey, branch, baseRef, behind: started.behind });
  return started;
}

export interface SyncedAttachRequest extends AttachRequest {
  readonly baseRef: string;
  readonly identity: BotIdentity;
}

/** A checkout, a refusal, or a checkout whose base will not merge into it — a superset of `WorktreeResult`. */
export type SyncedAttachResult =
  | WorktreeResult
  | {
      readonly outcome: "conflicted";
      /** Attached and clean. The merge was aborted before this was returned. */
      readonly worktree: Worktree;
      readonly behind: number;
      /** The paths git flagged, capped. Read from git, never from a model. */
      readonly files: readonly string[];
    };

/**
 * A checkout for a review round: attached to the branch, and current with base.
 * `conflicted` is a third outcome rather than a refusal, since the checkout is fine
 * and only the merge failed; `syncWithBase` aborts it first, so nothing is left
 * in progress for the reuse check to salvage.
 */
export async function attachSynced(
  runner: CommandRunner,
  request: SyncedAttachRequest,
): Promise<SyncedAttachResult> {
  const attached = await attachWorktree(runner, request);
  if (attached.outcome === "refused") {
    return attached;
  }

  const synced = await syncWithBase(runner, {
    issueKey: attached.worktree.issueKey,
    // The attached worktree's branch, not the request's — the one git confirmed, not the one supplied.
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
      outcome: "conflicted",
      worktree: attached.worktree,
      behind: synced.behind,
      files: synced.files,
    };
  }

  return attached;
}
