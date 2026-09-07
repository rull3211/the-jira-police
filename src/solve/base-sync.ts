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
 * ## Conflicts are never resolved silently, and never left lying about
 *
 * - **No `-X ours` or `-X theirs`.** A whole-side strategy resolves a conflict
 *   by discarding one author's change unread, and it does it to every file at
 *   once. That is the one outcome worse than refusing. A conflict is resolved
 *   by something that read both sides, or it is not resolved.
 * - **No half-finished merge left on disk.** Conflict markers in the working
 *   tree are uncommitted changes, so leaving them makes the next tick's reuse
 *   check salvage the checkout — the loop tidies away the very state a resolver
 *   was supposed to look at.
 *
 * That second rule is why the merge is split in two. {@link syncWithBase} is
 * for callers who cannot resolve anything: it aborts a conflict and reports the
 * paths. {@link beginMerge} is for the one caller that can, and is the only
 * function here that returns with a merge still in progress — a handover,
 * owed either a {@link commitMerge} or an {@link abortMerge} by whoever took
 * it. Both spellings of *merge the base in* are the same six commands, because
 * the alternative is two of them drifting over what counts as a conflict.
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

/** git, in the checkout, as nobody in particular — for reads and for `--abort`. */
const gitIn = (worktreePath: string, ...argv: readonly string[]): readonly string[] => [
  "git",
  "-C",
  worktreePath,
  ...argv,
];

/**
 * git, in the checkout, with a name on whatever it commits.
 *
 * `-c` before `-C`, copied from `pr.ts` and load-bearing rather than
 * stylistic: after `-C`, git parses these as arguments to the subcommand and
 * the commit is attributed to whatever global config the machine happens to
 * carry, or to nobody at all. Passing the identity per invocation also keeps it
 * out of the worktree's own config, where it would outlive this command and
 * sign whatever ran next.
 */
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

/**
 * The paths git says are conflicted, capped, newest read each time.
 *
 * Empty when the read itself failed, which callers must not read as *resolved*:
 * every one of them uses this either to describe a conflict that has already
 * been reported by a non-zero merge, or to confirm a resolution — and in the
 * second case an unreadable answer has to fail closed. Both call sites do.
 */
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

/**
 * Puts the checkout back the way it was found, and says whether it managed to.
 *
 * Called on every path that leaves a merge unfinished, including the ones that
 * are already refusing for some other reason: a half-merged tree is
 * uncommitted changes, so leaving one makes the next tick's reuse check salvage
 * the checkout rather than reuse it.
 */
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

/**
 * Commits a merge whose conflicts somebody has resolved in the working tree.
 *
 * `--no-edit` for the reason the merge itself uses it: git's own merge wording
 * is what commitlint's default ignores are written against, and a subject of
 * our own invention would have to be Conventional Commits to survive the pilot
 * repository's hook. It is also not ours to invent — the accurate description
 * of this commit is *merge, with conflicts resolved*, and git already says that.
 */
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
 * Pushes the branch, and undoes the merge if it will not go.
 *
 * The undo is what keeps *"origin is the single answer to what is on this
 * branch"* true. `ORIG_HEAD` is set by `git merge` and names the commit the
 * branch was on immediately before it — and `git commit` does not move it, so
 * this discards our own merge commit and nothing else whether the merge
 * committed itself or a resolver committed it afterwards. The tree was proved
 * clean before the merge began, so there is no other work here to lose.
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

/**
 * The resolution is not accepted, and the caller owes the checkout an abort.
 *
 * Every `false` from {@link acceptResolution} leaves a merge in progress, which
 * is the one thing about that function a caller cannot forget and be fine.
 */
const decline = (reason: string): ResolutionCheck => ({ ok: false, reason });

/**
 * A conflict marker at the start of a line, which is git's own spelling.
 *
 * `=======` is deliberately absent: it is a legal Markdown heading underline
 * and a legal line of a hundred other things, so matching it would refuse
 * resolutions that are correct. The two arrow markers and the `|||||||` of a
 * diff3 merge cannot occur by accident at the start of a line followed by a
 * space, and one of them is always present when a hunk is left unresolved.
 */
const CONFLICT_MARKER = "^(<<<<<<<|>>>>>>>|\\|\\|\\|\\|\\|\\|\\|) ";

/**
 * Checks that a resolution resolved the conflict, and nothing else.
 *
 * The model's own report is not consulted here on purpose. A pass that says it
 * resolved three files has made a claim about a working tree it also had write
 * access to, which is the one kind of assertion this service never takes on
 * trust — so every question below is asked of git, and the answers are exit
 * codes rather than prose.
 *
 * Four questions, and the last two are the bound rather than the check:
 *
 * 1. **Are any paths still unmerged?** The direct question, asked after the
 *    conflicted paths are staged, since staging is what marks one resolved.
 * 2. **Is a conflict marker left in any of them?** A pass can stage a file with
 *    the markers still in it, and git will commit that happily. It compiles in
 *    almost no language, so verification would usually catch it — *usually* is
 *    not the standard for a commit that lands on a branch under review.
 * 3. **Was anything outside the conflicted set changed?** The merge itself
 *    already changed other files, and those arrive staged; an *unstaged* change
 *    is one the pass made, and this round is not the place to make it.
 * 4. **Was a new file left behind?** Same rule, by the route the diff gate
 *    learned the hard way: a bound that only looks at tracked files does not
 *    bound anything, because writing a new file evades it entirely.
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

  // Exactly the paths git marked, never `-A`. Staging is the act that says
  // "this one is resolved", so staging a path git did not complain about would
  // be answering a question nobody asked.
  const staged = await runner.run(gitIn(worktreePath, "add", "--", ...conflicted), opts);
  if (failed(staged)) {
    return decline(`could not stage the resolved files (${why(staged)})`);
  }

  const unmerged = await conflictedPaths(runner, worktreePath, timeoutMs);
  if (unmerged.length > 0) {
    return decline(`still unmerged after the pass: ${unmerged.join(", ")}`);
  }

  // `git grep` with no revision searches the working tree. Exit 1 is "no
  // matches", which is the answer being hoped for; anything above 1 is git
  // failing to look, and an unanswered question fails closed.
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
 * Merges the base in and stops there — **including when it conflicts**.
 *
 * The one function in this module that can return with a merge still in
 * progress on disk, which is the whole reason it is separate from
 * {@link syncWithBase}: a resolver needs the conflict markers to look at, and
 * every other caller needs them gone. So `conflicted` here is a *handover*, and
 * whoever receives it owes the checkout either {@link commitMerge} or
 * {@link abortMerge} before it is left alone.
 *
 * Reads first and writes only if it must: a branch that already contains its
 * base costs three read-only commands and returns `current`.
 */
export async function beginMerge(
  runner: CommandRunner,
  request: BaseSyncRequest,
): Promise<BaseSyncResult> {
  const { issueKey, branch, worktreePath, baseRef, identity, timeoutMs } = request;
  const opts: CommandOptions = { cwd: worktreePath, timeoutMs };
  const git = (...argv: readonly string[]): readonly string[] => gitIn(worktreePath, ...argv);

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
  const merged = await runner.run(
    signedGit(worktreePath, identity, "merge", "--no-edit", baseRef),
    opts,
  );
  if (!failed(merged)) {
    return { outcome: "merged", behind };
  }

  const files = await conflictedPaths(runner, worktreePath, timeoutMs);
  if (files.length === 0) {
    // No conflicted paths means the merge failed for some other reason — a
    // hook, a lock, an unrelated local modification git noticed first — and
    // that is not something a resolver can be handed. Aborted here rather than
    // by the caller, because the caller is being told there is no conflict and
    // would have no reason to think there was anything to clean up.
    await abortMerge(runner, worktreePath, timeoutMs);
    return refuse(`could not merge ${baseRef} into ${branch} (${why(merged)})`);
  }
  logger.warn("solve.base.conflicted", { issueKey, branch, baseRef, behind, files });
  return { outcome: "conflicted", behind, files };
}

/**
 * Merges the base into the checkout and pushes the result, or explains itself.
 *
 * {@link beginMerge} plus the two endings a caller who cannot resolve a
 * conflict needs: push what merged cleanly, abort what did not. Everything
 * that only wants a current branch calls this one.
 */
export async function syncWithBase(
  runner: CommandRunner,
  request: BaseSyncRequest,
): Promise<BaseSyncResult> {
  const { issueKey, branch, worktreePath, baseRef, timeoutMs } = request;

  const started = await beginMerge(runner, request);
  if (started.outcome === "conflicted") {
    // Aborted whether or not the abort works: what matters is that no
    // half-merged tree is left for the next tick's reuse check to salvage, and
    // a checkout that would not abort is unusable either way — which the caller
    // finds out on the next attach rather than being told twice here.
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

/**
 * A checkout, a refusal, or a checkout whose base will not merge into it.
 *
 * A superset of `WorktreeResult` rather than a replacement for it, so a caller
 * that still hands out a plain `attachWorktree` keeps type-checking and only
 * the callers that can *do* something with a conflict have to handle one.
 */
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
 *
 * **One function because there are two call sites**, `runAdvance` and the
 * daemon's review act, and they are already near-identical closures that a
 * change has to be made to twice. `createReviewAct`'s refused-checkout branch is
 * the last thing that drifted between that pair, and it ran against PR #2663
 * every two minutes for four days recording nothing; the fix for a duplicated
 * branch is to stop duplicating it, not to remember harder.
 *
 * ## A conflict is a third outcome rather than a refusal
 *
 * It used to be one. A refusal costs nothing and is counted as a failed start,
 * so a branch whose base would not merge stalled the pull request for a human
 * after `MAX_FAILED_STARTS` ticks — correct while nothing could resolve a
 * conflict, and wrong now that something can. `conflicted` carries the attached
 * worktree with it, because the checkout is fine: the merge is what failed, and
 * the resolver needs exactly that checkout to try it again.
 *
 * **The merge is not left in progress here.** `syncWithBase` aborts it, so the
 * tree handed back is clean and the reuse check on the next tick has nothing to
 * salvage. The resolver re-runs the merge behind its own reservation, which is
 * what keeps a conflicted tree from sitting through a model start-up.
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
      outcome: "conflicted",
      worktree: attached.worktree,
      behind: synced.behind,
      files: synced.files,
    };
  }

  return attached;
}
