/**
 * Isolation for a solve run: a throwaway git worktree cut from the pristine base, used once and discarded.
 * Every git command is an argv array handed to an injected runner, never a shell string, since a Jira summary is attacker-controlled.
 */

import { createLogger } from "../logger.ts";
import { isWorkBranch, WORK_BRANCH_PREFIXES } from "./branch.ts";

const log = createLogger("solve");

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True if the runner killed it. Distinct from a non-zero exit. */
  readonly timedOut: boolean;
}

export interface CommandOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
}

/** The one capability this module needs. `argv`, not a command string, so nothing has to split a ticket summary into extra arguments. */
export interface CommandRunner {
  run: (argv: readonly string[], options: CommandOptions) => Promise<CommandResult>;
}

export interface Worktree {
  readonly issueKey: string;
  /** Absolute path to the worktree. Derived, never supplied by a model. */
  readonly path: string;
  readonly branch: string;
  /** The repository this worktree belongs to — needed to remove it again. */
  readonly repoPath: string;
}

export type WorktreeResult =
  | { readonly outcome: "created"; readonly worktree: Worktree }
  | { readonly outcome: "refused"; readonly issueKey: string; readonly reason: string };

export type RemoveResult =
  | {
      readonly outcome: "removed";
      readonly path: string;
      /** Whether the branch went too: `git worktree remove` leaves it behind, and a leftover collides with the next run's `worktree add -b`. */
      readonly branch: BranchRemoval;
    }
  | { readonly outcome: "kept"; readonly path: string; readonly reason: string };

export type BranchRemoval =
  | { readonly outcome: "deleted" }
  | { readonly outcome: "kept"; readonly reason: string };

export interface WorktreeRequest {
  readonly issueKey: string;
  /** The ticket summary. Attacker-controlled text; only ever reaches `slugify`. */
  readonly summary: string;
  readonly repoPath: string;
  /** Directory the worktree is created inside. One level up from the worktree. */
  readonly parentDirectory: string;
  /** Remote-tracking ref to cut from, e.g. `origin/main`. */
  readonly baseRef: string;
  /** Branch type — `fix` for a `Feil`, `feat` for an `Oppgave`; must be on `WORK_BRANCH_PREFIXES` or the worktree is refused, not defaulted. */
  readonly branchPrefix?: string;
  readonly timeoutMs: number;
}

/** Jira keys this service will act on. Anything else is refused unparsed. */
const ISSUE_KEY = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/u;

/** Remote-tracking refs only, made of safe characters; exported so `base-sync.ts` checks bases against the same rule this module cuts from. */
export const BASE_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

/** What a finished branch name is allowed to look like, checked as a whole. */
const BRANCH = /^[a-z]+\/[a-z][a-z0-9]*-\d{1,7}-[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const MAX_SLUG_LENGTH = 40;

/**
 * Turns a ticket summary into a branch-name fragment. An allowlist, not an escape: everything outside `[a-z0-9]` becomes a separator.
 * Returns `""` for a summary with no usable characters; the caller refuses on empty rather than substituting a placeholder, since two tickets would then race for one branch name.
 */
export function slugify(summary: string): string {
  return summary
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/u, "");
}

/**
 * The branch for a ticket, or `null` if a safe one cannot be formed, following the `{type}/{jira-id}-{slug}` convention.
 * The trailing `isWorkBranch` check cannot fire while `BRANCH` holds, but stays because the never-work-on-a-protected-branch rule must not rest on a regex three constants away.
 */
export function branchNameFor(issueKey: string, summary: string, prefix = "fix"): string | null {
  if (!ISSUE_KEY.test(issueKey)) {
    return null;
  }
  if (!WORK_BRANCH_PREFIXES.has(prefix)) {
    return null;
  }
  const slug = slugify(summary);
  if (slug === "") {
    return null;
  }
  const branch = `${prefix}/${issueKey.toLowerCase()}-${slug}`;
  if (!BRANCH.test(branch)) {
    return null;
  }
  return isWorkBranch(branch) ? branch : null;
}

/** A command that did not do what it was asked. Exported for `base-sync.ts`, which must read a failure the same way. */
export function failed(result: CommandResult): boolean {
  return result.timedOut || result.exitCode !== 0;
}

/** Why a command failed, in a clause short enough to put in a refusal. */
export function why(result: CommandResult): string {
  if (result.timedOut) {
    return "timed out";
  }
  const detail = (result.stderr.trim() === "" ? result.stdout : result.stderr).trim();
  return `exit ${String(result.exitCode)}${detail === "" ? "" : `: ${detail.slice(0, 300)}`}`;
}

/**
 * Creates the worktree, or refuses and leaves the machine untouched.
 *
 * Five commands: fetch, verify the base resolves, list existing worktrees, salvage one at our path if unusable, then `worktree add -b` —
 * `-b` deliberately fails on an existing branch, so a second run for the same ticket cannot quietly reuse one that may carry commits.
 * Refusals are returned, not thrown: a ticket whose summary yields no usable slug is an ordinary occurrence, not a fault.
 */
export async function createWorktree(
  runner: CommandRunner,
  request: WorktreeRequest,
): Promise<WorktreeResult> {
  const { issueKey, summary, repoPath, parentDirectory, baseRef, timeoutMs } = request;

  const refuse = (reason: string): WorktreeResult => ({ outcome: "refused", issueKey, reason });

  if (!ISSUE_KEY.test(issueKey)) {
    return refuse(`${JSON.stringify(issueKey)} is not an issue key this service will act on`);
  }
  if (!BASE_REF.test(baseRef)) {
    return refuse(
      `${JSON.stringify(baseRef)} is not a remote-tracking ref — the base is configuration, and a malformed one is a misconfiguration rather than something to interpret`,
    );
  }
  const branch = branchNameFor(issueKey, summary, request.branchPrefix);
  if (branch === null) {
    return refuse(
      `the summary yields no usable ${String(request.branchPrefix ?? "fix")}/ branch name — refused rather than substituted, since two tickets sharing a placeholder would race for one branch, and an unrecognised prefix is a caller mistake rather than a naming preference`,
    );
  }

  const path = `${parentDirectory}/${issueKey}`;
  const opts = { cwd: repoPath, timeoutMs };

  const fetched = await runner.run(["git", "-C", repoPath, "fetch", "origin", "--quiet"], opts);
  if (failed(fetched)) {
    return refuse(`could not fetch origin (${why(fetched)})`);
  }

  const base = await runner.run(
    ["git", "-C", repoPath, "rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`],
    opts,
  );
  if (failed(base)) {
    return refuse(`base ref ${baseRef} does not resolve to a commit (${why(base)})`);
  }

  // Read before the add: a checkout of ours here is debris to move aside, but a bare ref of that name is what `-b` below exists to refuse.
  const listed = await runner.run(["git", "-C", repoPath, "worktree", "list", "--porcelain"], opts);
  if (failed(listed)) {
    return refuse(`could not list the repository's worktrees (${why(listed)})`);
  }

  const existing = worktreeAt(listed.stdout, path);
  if (existing.present) {
    const salvaged = await salvageWorktree(
      runner,
      { issueKey, branch, repoPath, parentDirectory },
      existing.branch,
      "was left behind by an earlier run for this ticket, which kept it and never came back",
      opts,
    );
    if (salvaged !== null) {
      return salvaged;
    }
  }

  const added = await runner.run(
    ["git", "-C", repoPath, "worktree", "add", path, "-b", branch, baseRef],
    opts,
  );
  if (failed(added)) {
    // Nothing of ours is at the path now, so a failure here is the branch name, a leftover with no worktree on it.
    return refuse(`could not create the worktree (${why(added)})`);
  }

  log.info("solve.worktree.created", { issueKey, path, branch, baseRef });
  return { outcome: "created", worktree: { issueKey, path, branch, repoPath } };
}

export interface AttachRequest {
  readonly issueKey: string;
  /** The branch to attach to, as a bare name — `fix/ssx-3822-slug`, never `origin/fix/...`. Untrusted; see the function's header. */
  readonly branch: string;
  readonly repoPath: string;
  readonly parentDirectory: string;
  readonly timeoutMs: number;
}

/**
 * A worktree on a branch that already exists on the remote — the counterpart to {@link createWorktree}, for a review round answering an
 * earlier run's pull request. The branch name is remote data (chosen by whoever opened the PR), so `isWorkBranch` is re-checked here.
 * An existing checkout at the path is reused only if on the expected branch, clean, and not ahead of `origin`; a behind checkout is
 * fast-forwarded, never rewritten. A *state* failure salvages the checkout aside so the cold path can rebuild; a *read* failure still
 * refuses, since it might succeed next tick — a tick's progress must not depend on the previous tick having tidied up.
 */
export async function attachWorktree(
  runner: CommandRunner,
  request: AttachRequest,
): Promise<WorktreeResult> {
  const { issueKey, branch, repoPath, parentDirectory, timeoutMs } = request;

  const refuse = (reason: string): WorktreeResult => ({ outcome: "refused", issueKey, reason });

  if (!ISSUE_KEY.test(issueKey)) {
    return refuse(`${JSON.stringify(issueKey)} is not an issue key this service will act on`);
  }
  if (!isWorkBranch(branch)) {
    return refuse(
      `${JSON.stringify(branch)} is not an implementation branch — this service commits only to ${[...WORK_BRANCH_PREFIXES].join("/")}-prefixed branches, and this name came from a pull request rather than from us`,
    );
  }

  const path = `${parentDirectory}/${issueKey}`;
  const opts = { cwd: repoPath, timeoutMs };

  const fetched = await runner.run(["git", "-C", repoPath, "fetch", "origin", "--quiet"], opts);
  if (failed(fetched)) {
    return refuse(`could not fetch origin (${why(fetched)})`);
  }

  // Resolved through the remote-tracking ref, not a same-named local branch, which could be stale, ahead, or unrelated.
  const remote = `origin/${branch}`;
  const head = await runner.run(
    ["git", "-C", repoPath, "rev-parse", "--verify", "--quiet", `${remote}^{commit}`],
    opts,
  );
  if (failed(head)) {
    return refuse(
      `${remote} does not resolve to a commit (${why(head)}) — the pull request's branch is not on the remote, so there is nothing here to review`,
    );
  }

  const listed = await runner.run(["git", "-C", repoPath, "worktree", "list", "--porcelain"], opts);
  if (failed(listed)) {
    return refuse(`could not list the repository's worktrees (${why(listed)})`);
  }

  const existing = worktreeAt(listed.stdout, path);
  if (existing.present) {
    const reused = await reuseWorktree(runner, request, existing.branch, opts);
    if (reused.outcome !== "salvage") {
      return reused;
    }
    // Moved out of the way rather than refused: refusing here wedges the loop, since the next tick would find the same checkout again.
    const salvaged = await salvageWorktree(runner, request, existing.branch, reused.reason, opts);
    if (salvaged !== null) {
      return salvaged;
    }
  }

  const added = await runner.run(
    ["git", "-C", repoPath, "worktree", "add", path, "--track", "-b", branch, remote],
    opts,
  );
  if (failed(added)) {
    // No worktree is at the path — just checked — so a branch collision here is genuinely a leftover.
    return refuse(
      `could not attach a worktree to ${branch} (${why(added)}) — a local branch of that name with no worktree on it is the usual cause, and that is a leftover from an earlier run rather than something to work around`,
    );
  }

  log.info("solve.worktree.attached", { issueKey, path, branch, remote, reused: false });
  return { outcome: "created", worktree: { issueKey, path, branch, repoPath } };
}

/**
 * The worktree registered at `path`, read from `git worktree list --porcelain`. Porcelain rather than the human format, since the plain
 * listing's `<path> <sha> [<branch>]` would be ambiguous for a path containing a space.
 * The caller owes it a resolved path: matching is exact string equality, and macOS's `tmpdir()` (`/var/folders/…`) is a symlink to what
 * git prints (`/private/var/…`), so an unresolved path silently falls through as if nothing were there. `worktreeRoot` in `wiring.ts` resolves it once.
 */
export function worktreeAt(
  porcelain: string,
  path: string,
): { readonly present: false } | { readonly present: true; readonly branch: string | null } {
  const marker = "worktree ";
  const head = "branch refs/heads/";
  let ours = false;
  for (const line of porcelain.split("\n")) {
    const text = line.trim();
    if (text.startsWith(marker)) {
      // A new record begins; if we were inside ours it ended without naming a branch, a detached or bare checkout.
      if (ours) {
        return { present: true, branch: null };
      }
      ours = text.slice(marker.length) === path;
      continue;
    }
    if (!ours) {
      continue;
    }
    if (text.startsWith(head)) {
      return { present: true, branch: text.slice(head.length) };
    }
    if (text === "") {
      return { present: true, branch: null };
    }
  }
  return ours ? { present: true, branch: null } : { present: false };
}

/** A checkout that cannot be reused, distinct from a refusal: a failed *read* might succeed next tick, but a bad *state* never clears itself. */
interface SalvageNeeded {
  readonly outcome: "salvage";
  /** Why it cannot be reused, as a clause that follows "the checkout at <path>". */
  readonly reason: string;
}

const salvage = (reason: string): SalvageNeeded => ({ outcome: "salvage", reason });

/**
 * Reuses the checkout already at the path, or says what is wrong with it. Cleanliness is checked before the fast-forward, so a worktree
 * somebody is working in is never merged into, and the ahead/behind counts are read in one command so both describe the same instant.
 */
async function reuseWorktree(
  runner: CommandRunner,
  request: AttachRequest,
  branchAt: string | null,
  opts: CommandOptions,
): Promise<WorktreeResult | SalvageNeeded> {
  const { issueKey, branch, repoPath, parentDirectory } = request;
  const path = `${parentDirectory}/${issueKey}`;
  const remote = `origin/${branch}`;
  const refuse = (reason: string): WorktreeResult => ({ outcome: "refused", issueKey, reason });

  if (branchAt !== branch) {
    return salvage(
      `it is on ${branchAt === null ? "a detached HEAD" : branchAt} rather than ${branch}`,
    );
  }

  const status = await runner.run(["git", "-C", path, "status", "--porcelain"], opts);
  if (failed(status)) {
    return refuse(`could not read the state of the worktree at ${path} (${why(status)})`);
  }
  if (status.stdout.trim() !== "") {
    // A review round commits everything it finds, so this guards against answering a reviewer with somebody else's work in progress.
    return salvage("it has uncommitted changes");
  }

  const counts = await runner.run(
    ["git", "-C", path, "rev-list", "--left-right", "--count", `HEAD...${remote}`],
    opts,
  );
  if (failed(counts)) {
    return refuse(`could not compare ${path} with ${remote} (${why(counts)})`);
  }
  const [aheadText, behindText] = counts.stdout.trim().split(/\s+/u);
  const ahead = Number(aheadText);
  const behind = Number(behindText);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) {
    // Refused rather than assumed zero: reading an unparseable count as "in sync" would let unpushed commits get pushed to a PR under review.
    return refuse(
      `could not read how ${path} compares with ${remote} — git answered ${JSON.stringify(counts.stdout.trim().slice(0, 100))}`,
    );
  }

  if (ahead > 0) {
    return salvage(
      `it is ${String(ahead)} commit(s) ahead of ${remote}, which the reviewer has not seen`,
    );
  }

  if (behind > 0) {
    const merged = await runner.run(["git", "-C", path, "merge", "--ff-only", remote], opts);
    if (failed(merged)) {
      // A fast-forward that will not apply is a statement about the checkout, not git being unavailable, so it salvages rather than refuses.
      return salvage(`it cannot be fast-forwarded to ${remote} (${why(merged)})`);
    }
  }

  log.info("solve.worktree.attached", { issueKey, path, branch, remote, reused: true, behind });
  return { outcome: "created", worktree: { issueKey, path, branch, repoPath } };
}

/** The four fields a salvage needs, narrower than either caller's request on purpose, since typing it as either would make it look owned by that one path. */
interface SalvageTarget {
  readonly issueKey: string;
  readonly branch: string;
  readonly repoPath: string;
  readonly parentDirectory: string;
}

/**
 * Moves an unusable checkout aside so the canonical path can be rebuilt. Returns `null` to mean *carry on* to the cold path; any step
 * failing returns a refusal instead, since a half-salvage (worktree moved but branch still checked out, or vice versa) is worse than the
 * starting state. Nothing is deleted — the directory is moved and the log names where it went.
 * Order is forced by git: `checkout --detach` frees the branch name (only if we hold it), then `worktree move` frees the canonical path,
 * then `branch -D` deletes only a branch we detached in step 1 — one we did *not* detach may carry unpushed work of its own.
 */
async function salvageWorktree(
  runner: CommandRunner,
  request: SalvageTarget,
  branchAt: string | null,
  reason: string,
  opts: CommandOptions,
): Promise<WorktreeResult | null> {
  const { issueKey, branch, repoPath, parentDirectory } = request;
  const path = `${parentDirectory}/${issueKey}`;
  const refuse = (step: string, result: CommandResult): WorktreeResult => ({
    outcome: "refused",
    issueKey,
    reason: `the checkout at ${path} ${reason}, and it could not be moved aside: ${step} failed (${why(result)})`,
  });

  const heldByUs = branchAt === branch;
  if (heldByUs) {
    const detached = await runner.run(["git", "-C", path, "checkout", "--detach"], opts);
    if (failed(detached)) {
      return refuse("detaching HEAD", detached);
    }
  }

  // Colons are legal in a path and awkward in every shell, so the timestamp is flattened; it only exists to keep two salvages from colliding.
  const salvagePath = `${path}-salvaged-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}`;
  const moved = await runner.run(
    ["git", "-C", repoPath, "worktree", "move", path, salvagePath],
    opts,
  );
  if (failed(moved)) {
    return refuse("moving the worktree aside", moved);
  }

  if (heldByUs) {
    const deleted = await runner.run(["git", "-C", repoPath, "branch", "-D", branch], opts);
    if (failed(deleted)) {
      return refuse("deleting the local branch", deleted);
    }
  }

  log.warn("solve.worktree.salvaged", { issueKey, path, salvagePath, branch, reason });
  return null;
}

/** What the caller wants done with the checkout. Not `"succeeded" | "failed"`: an abandoned run's worktree must still go so a retry doesn't collide with it. */
export type Disposition =
  /** Remove it. Only ever safe when nothing was written, or nothing is wanted. */
  | "discard"
  /** Leave it on disk; a human is going to read the diff. */
  | "keep-as-evidence";

/**
 * Removes the worktree, only when the caller asks for it gone: a failed run's worktree is the only
 * copy of the diff a human needs to judge it by, so it is kept rather than deleted for tidiness.
 * `--force` is deliberately absent, since a dirty-worktree refusal means the run did something the
 * harness did not account for. The branch is removed too, since `git worktree remove` leaves it
 * behind and a leftover ref collides with the next run's `worktree add -b` on the same name.
 */
export async function removeWorktree(
  runner: CommandRunner,
  worktree: Worktree,
  disposition: Disposition,
  timeoutMs: number,
): Promise<RemoveResult> {
  if (disposition === "keep-as-evidence") {
    log.info("solve.worktree.kept", { issueKey: worktree.issueKey, path: worktree.path });
    return {
      outcome: "kept",
      path: worktree.path,
      reason: "the run failed, and its worktree is the only copy of what it did",
    };
  }

  const removed = await runner.run(
    ["git", "-C", worktree.repoPath, "worktree", "remove", worktree.path],
    { cwd: worktree.repoPath, timeoutMs },
  );
  if (failed(removed)) {
    return {
      outcome: "kept",
      path: worktree.path,
      reason: `git would not remove it (${why(removed)}) — not forced, because a refusal here usually means uncommitted work`,
    };
  }

  log.info("solve.worktree.removed", { issueKey: worktree.issueKey, path: worktree.path });

  const branch = await deleteBranch(runner, worktree, timeoutMs);
  return { outcome: "removed", path: worktree.path, branch };
}

/**
 * Deletes the branch the worktree was on, without forcing: `-d` refuses to delete a branch holding
 * commits unreachable elsewhere, so a future pass that did commit gets a refusal instead of losing
 * work silently. Called only after the worktree is gone, since git will not delete the branch of a
 * live worktree.
 */
async function deleteBranch(
  runner: CommandRunner,
  worktree: Worktree,
  timeoutMs: number,
): Promise<BranchRemoval> {
  const deleted = await runner.run(
    ["git", "-C", worktree.repoPath, "branch", "-d", worktree.branch],
    { cwd: worktree.repoPath, timeoutMs },
  );
  if (failed(deleted)) {
    log.info("solve.branch.kept", {
      issueKey: worktree.issueKey,
      branch: worktree.branch,
      reason: why(deleted),
    });
    return { outcome: "kept", reason: `git would not delete it (${why(deleted)})` };
  }

  log.info("solve.branch.deleted", { issueKey: worktree.issueKey, branch: worktree.branch });
  return { outcome: "deleted" };
}
