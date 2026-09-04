/**
 * Isolation for a solve run: a throwaway git worktree cut from the pristine
 * base, used once and thrown away.
 *
 * This exists because of what is actually on this machine. Of five SSX repos
 * checked out locally, three are dirty and on feature branches. A solver that
 * edited a working checkout would mix its changes into somebody's in-progress
 * work, and the first symptom would be a diff nobody could attribute. So the
 * solver never touches a checkout: it gets its own worktree, cut from
 * `origin/<base>` after a fetch, on a branch that did not exist a moment ago.
 *
 * ## No shell, ever
 *
 * Every command is an argv array handed to an injected runner, never a string.
 * There is no shell in this module and nothing here depends on quoting — which
 * matters more than usual, because one of the inputs is a Jira summary and Jira
 * summaries are written by whoever opened the ticket. See `slugify`.
 *
 * The runner is injected for the same reason `SolveDeps` and `ClaimCapabilities`
 * are: every rule below is then testable against a fake, with no git, no
 * network, and no repository on disk. A test that needed a real clone to
 * exercise the branch-name guard is a test nobody runs.
 *
 * ## The model has no part in this
 *
 * Nothing here is decided by a model. The path is derived from the issue key,
 * the branch from the key and the summary, the base ref from configuration.
 * That is deliberate: the worktree is the boundary the rest of Phase C relies
 * on, and a boundary whose location was suggested by the thing being contained
 * is not a boundary.
 */

import { logger } from "../logger.ts";
import { isWorkBranch, WORK_BRANCH_PREFIXES } from "./branch.ts";

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

/**
 * The one capability this module needs.
 *
 * `argv` and not a command string. A string would have to be split by
 * something, and whatever split it would become the place where a ticket
 * summary turns into an extra argument.
 */
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
  | { readonly outcome: "removed"; readonly path: string }
  | { readonly outcome: "kept"; readonly path: string; readonly reason: string };

export interface WorktreeRequest {
  readonly issueKey: string;
  /** The ticket summary. Attacker-controlled text; only ever reaches `slugify`. */
  readonly summary: string;
  readonly repoPath: string;
  /** Directory the worktree is created inside. One level up from the worktree. */
  readonly parentDirectory: string;
  /** Remote-tracking ref to cut from, e.g. `origin/main`. */
  readonly baseRef: string;
  readonly timeoutMs: number;
}

/** Jira keys this service will act on. Anything else is refused unparsed. */
const ISSUE_KEY = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/u;

/** Remote-tracking refs only, and only ones made of safe characters. */
const BASE_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

/** What a finished branch name is allowed to look like, checked as a whole. */
const BRANCH = /^[a-z]+\/[a-z][a-z0-9]*-\d{1,7}-[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const MAX_SLUG_LENGTH = 40;

/**
 * Turns a ticket summary into a branch-name fragment.
 *
 * An allowlist, not an escape. Everything outside `[a-z0-9]` becomes a
 * separator and runs of separators collapse, so there is no input — no
 * backslash, no quote, no control character, no right-to-left override, no
 * combining mark — that survives into the output as itself. That is the only
 * approach worth taking here: the input is a Jira summary, and the list of
 * characters git treats specially in a ref name is long enough
 * (`~ ^ : ? * [ \` , whitespace, `..`, `@{`, a leading `-` or `.`, a trailing
 * `.` or `.lock`) that enumerating what to remove invites missing one.
 *
 * Returns `""` for anything with no usable characters at all — a summary in a
 * script this cannot transliterate, or one made entirely of punctuation. The
 * caller refuses on empty rather than substituting a placeholder, because two
 * tickets that both slugified to `untitled` would race for one branch name.
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
 * The branch for a ticket, or `null` if a safe one cannot be formed.
 *
 * Built from an allowlist and then re-checked as a whole against `BRANCH`. The
 * second check asserts the thing that actually reaches git, rather than the two
 * halves it was assembled from.
 *
 * Be precise about what that buys, because mutation testing was: **removing the
 * `BRANCH` check on its own kills no test**, and cannot, while `ISSUE_KEY` and
 * `slugify` both hold — by construction there is no input that reaches it in a
 * bad state. Removing it *together with* the empty-slug guard does fail tests.
 * So this is a backstop against a future edit loosening one of the other two,
 * not a control doing work today. Recorded rather than dressed up: a guard
 * whose test passes when you unplug it is exactly the thing this codebase
 * distrusts, and the honest version of that is to say which one it is.
 *
 * Follows the vault convention `{type}/{jira-id}-{slug}`
 * (`insurance-knowledge-vault/.ai-rules/git-conventions.md`), lowercased.
 * `prefix` defaults to `fix` because that is what the pilot queue is made of;
 * the skill solves `Oppgave` as readily as `Feil`, and calling that `fix/` too
 * would be a small lie told a hundred times.
 *
 * The `isWorkBranch` call at the end is the standing rule *"never main, never a
 * protected branch"* applied at the point of construction. It cannot fire while
 * `BRANCH` holds and `prefix` is on the allowlist — `BRANCH` requires a
 * `-<digits>-` segment that no protected name has. It is here because that
 * argument depends on the shape of a regex three constants away, and the rule
 * is absolute enough not to rest on that. Stated plainly rather than presented
 * as active defence.
 */
export function branchNameFor(issueKey: string, summary: string, prefix = "fix"): string | null {
  if (!ISSUE_KEY.test(issueKey)) {
    return null;
  }
  if (!WORK_BRANCH_PREFIXES.includes(prefix)) {
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

function failed(result: CommandResult): boolean {
  return result.timedOut || result.exitCode !== 0;
}

function why(result: CommandResult): string {
  if (result.timedOut) {
    return "timed out";
  }
  const detail = (result.stderr.trim() === "" ? result.stdout : result.stderr).trim();
  return `exit ${String(result.exitCode)}${detail === "" ? "" : `: ${detail.slice(0, 300)}`}`;
}

/**
 * Creates the worktree, or refuses and leaves the machine untouched.
 *
 * Four commands, in this order, and the order is the point:
 *
 * 1. `fetch` — so the base ref means what it will mean for the PR later. A
 *    worktree cut from a stale `origin/main` produces a diff that conflicts on
 *    arrival and a review comment about code the author never saw.
 * 2. `rev-parse --verify` the base — separating "the base does not exist" from
 *    "the worktree could not be created", which `worktree add` reports with the
 *    same exit code.
 * 3. `worktree add -b` — `-b` and not a bare add, because `-b` fails when the
 *    branch already exists. That failure is wanted: a second run for the same
 *    ticket must not quietly reuse a branch that may already carry commits.
 *
 * Refusals are returned, not thrown. A ticket whose summary yields no usable
 * slug is an ordinary occurrence, not a fault, and the cycle should record it
 * and move to the next ticket.
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
  const branch = branchNameFor(issueKey, summary);
  if (branch === null) {
    return refuse(
      "the summary yields no usable branch slug — refused rather than substituted, since two tickets sharing a placeholder would race for one branch",
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

  const added = await runner.run(
    ["git", "-C", repoPath, "worktree", "add", path, "-b", branch, baseRef],
    opts,
  );
  if (failed(added)) {
    return refuse(`could not create the worktree (${why(added)})`);
  }

  logger.info("solve.worktree.created", { issueKey, path, branch, baseRef });
  return { outcome: "created", worktree: { issueKey, path, branch, repoPath } };
}

/**
 * Removes the worktree — but only when the run succeeded.
 *
 * A failed run's worktree is the only copy of what the solver actually did, and
 * the diff in it is the evidence a human needs to decide whether the ticket was
 * mis-assessed as `agent:solvable` or the solver simply got it wrong. Deleting
 * that to keep the temp directory tidy trades the answer for the disk space.
 *
 * `--force` is deliberately absent. If git refuses because the worktree is
 * dirty, that is git reporting uncommitted work, and uncommitted work at this
 * point means the run did something the harness did not account for. Keep it
 * and say so.
 */
export async function removeWorktree(
  runner: CommandRunner,
  worktree: Worktree,
  outcome: "succeeded" | "failed",
  timeoutMs: number,
): Promise<RemoveResult> {
  if (outcome === "failed") {
    logger.info("solve.worktree.kept", { issueKey: worktree.issueKey, path: worktree.path });
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

  logger.info("solve.worktree.removed", { issueKey: worktree.issueKey, path: worktree.path });
  return { outcome: "removed", path: worktree.path };
}
