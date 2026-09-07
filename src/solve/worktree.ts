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
  | {
      readonly outcome: "removed";
      readonly path: string;
      /**
       * Whether the branch went too, and why not when it did not.
       *
       * Removing the worktree leaves its branch behind — `git worktree remove`
       * touches the checkout, not the ref — so every bail used to leak a ref
       * into the pilot repository, one per run, invisibly. It is reported here
       * rather than only logged because a leftover branch is the thing that
       * makes the *next* run of the same ticket fail: the worktree path and the
       * branch name are both derived from the issue key, so `worktree add -b`
       * collides with the ref its own predecessor left.
       */
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
  /**
   * Branch type — `fix` for a `Feil`, `feat` for an `Oppgave`. Defaults to
   * `fix`. Must be on `WORK_BRANCH_PREFIXES`; anything else refuses the
   * worktree rather than falling back, because a caller passing `main` here
   * has made a mistake that must not be resolved into a working branch.
   */
  readonly branchPrefix?: string;
  readonly timeoutMs: number;
}

/** Jira keys this service will act on. Anything else is refused unparsed. */
const ISSUE_KEY = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/u;

/**
 * Remote-tracking refs only, and only ones made of safe characters.
 *
 * Exported so `base-sync.ts` checks the base against the same rule this module
 * cuts worktrees from. Two spellings of "what a base ref may look like" is one
 * spelling too many when the looser of them decides what gets merged into a
 * branch under review.
 */
export const BASE_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

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

/**
 * A command that did not do what it was asked.
 *
 * Exported for `base-sync.ts`, which runs git in the checkout this module
 * hands over and must read a failure the same way. `pr.ts` has a third copy,
 * predating both; it is left alone rather than folded in here, because moving
 * it is a change to the publish path and this is not that commit.
 */
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

export interface AttachRequest {
  readonly issueKey: string;
  /**
   * The branch to attach to, as a bare name — `fix/ssx-3822-slug`, never
   * `origin/fix/...`. **Untrusted**; see the function's header.
   */
  readonly branch: string;
  readonly repoPath: string;
  readonly parentDirectory: string;
  readonly timeoutMs: number;
}

/**
 * A worktree on a branch that already exists on the remote.
 *
 * The counterpart to {@link createWorktree}, and it exists because a review
 * round operates on a pull request that some earlier, finished run opened. That
 * run's worktree is gone — or was never on this machine, once a daemon is doing
 * this. What survives is a branch on `origin`, and answering a reviewer means
 * committing to *that* branch rather than to a fresh cut of the base.
 *
 * ## Why this is not a flag on `createWorktree`
 *
 * The two differ in the one place that matters. `createWorktree` uses
 * `worktree add -b`, and its failure on an already-existing branch *is* a
 * guard: it stops a second run for the same ticket from quietly reusing a
 * branch that may already carry commits. Attaching wants the opposite — the
 * branch must exist — so sharing one function would mean making that guard
 * conditional on an argument, and a guard an argument can switch off is not one
 * you can reason about from the call site. Two functions, one rule each.
 *
 * ## The branch name is not ours, and that is the new risk
 *
 * Every branch `createWorktree` touches was derived by `branchNameFor` from an
 * issue key and a summary. This one is *handed* a branch, and the caller reads
 * it off a pull request — so it is remote data, chosen by anybody who can open
 * a pull request on the repository. `isWorkBranch` is therefore re-checked
 * here rather than assumed of the caller. The difference between honouring it
 * and trusting the input is the difference between checking out
 * `fix/ssx-3822-thing` and checking out `main`, and *"the agent may never work
 * on main or any protected branch, never"* is not a rule that can rest on one
 * call site being right.
 *
 * ## The checkout is usually already there, and that is not a leftover
 *
 * Found by running `--advance` for the first time against a real pull request,
 * 2026-09-05. This function used to go straight to `worktree add --track -b`
 * and refuse when it collided, calling the collision *"a leftover from an
 * earlier run rather than something to work around"*. That sentence was wrong,
 * and wrong about the ordinary case: publishing a pull request **keeps** its
 * worktree so a human can read the diff, and `git worktree remove` never
 * deletes a branch. So every successful `--pr` leaves a clean checkout of
 * exactly the right branch at exactly the path a review round wants, and the
 * review round refused it. On the machine that opened the pull request — which
 * is every hand-driven run — attaching could not succeed even once.
 *
 * So an existing worktree is reused, but only after it has been *proved* to be
 * the thing we would have built. Three checks:
 *
 * - **on the expected branch**, or it is a different piece of work at a
 *   coincidental path,
 * - **clean**, or the round would sweep a human's uncommitted edits into a
 *   commit answering a code review — the single worst thing this module could
 *   do, and it would be attributed to them,
 * - **not ahead of `origin`**, or there are commits here the reviewer has never
 *   seen and a fast-forward would be a lie about what was reviewed.
 *
 * Behind is repaired in place with `merge --ff-only`: it is what a checkout
 * looks like after somebody pushed to the branch, and the merge cannot invent a
 * commit. Nothing here ever discards a commit or an edit; every destructive
 * resolution (`-B`, `reset --hard`, `add --force`) was considered and rejected
 * for that reason, since the value being protected is work a person did and did
 * not tell us about.
 *
 * ## Failing those checks used to stop the loop, and that was the bug
 *
 * Found 2026-09-06 with SSX-3835 four days into a silent wedge. Each of the
 * three failures above returned a refusal, and the argument for that — *somebody
 * else is holding this checkout* — reads as prudence and is a deadlock. The
 * path is `<parentDirectory>/<issueKey>`, a pure function of the ticket, so the
 * checkout the round refused is the checkout the *next* round finds. None of
 * the three states clears itself. And the refusal is free: it happens before
 * any session starts, so no cap counts it, no cost moves, and nothing is
 * labelled or commented. The loop retried the same failure every two minutes
 * for four days at $0 and told nobody.
 *
 * The invariant that was violated is worth naming, because it is not specific
 * to worktrees: **a tick's ability to make progress must not depend on the
 * previous tick having tidied up.** The dirt here was almost always our own —
 * a round that threw before its cleanup ran — and a `finally` narrows that
 * window without closing it, since `kill -9`, an OOM and a laptop that slept
 * through `SOLVE_TIMEOUT_MS` all skip it, and this service has already recorded
 * the last of those. Durability has to live in the next tick's recovery.
 *
 * So a state failure now **salvages**: the checkout is moved aside intact
 * (`salvageWorktree`) and the cold path below rebuilds from the remote. Nothing
 * is deleted, so the argument that made these refusals attractive is preserved
 * — a human's work is still there, at a path named in the log — while the loop
 * stops depending on somebody noticing.
 *
 * A *read* failure still refuses, and the split is the whole design: git being
 * unavailable, or answering with counts that will not parse, might succeed on
 * the next tick, so retrying is right and moving a checkout we could not read
 * is not. Refuse what may pass later; salvage what never will.
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

  // Resolved through the remote-tracking ref, not the local branch of the same
  // name. A local `fix/ssx-3822-x` left behind by an earlier run on this
  // machine can be stale, or ahead, or unrelated; the pull request under review
  // is whatever `origin` has, and that is the only thing a reviewer has read.
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
    // The checkout is unusable and the reason is a *state* rather than a failed
    // read, so it is moved out of the way and the cold path below rebuilds from
    // the remote. Refusing here instead — which is what this did — is what
    // wedged the loop: the path is derived from the issue key, so the next tick
    // finds the same checkout, refuses for the same reason, and does so for
    // free, which means no cap fires and no cost signal moves.
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
    // No worktree is at the path — that was just checked — so the collision is
    // the branch, and a branch with no worktree on it is genuinely a leftover.
    return refuse(
      `could not attach a worktree to ${branch} (${why(added)}) — a local branch of that name with no worktree on it is the usual cause, and that is a leftover from an earlier run rather than something to work around`,
    );
  }

  logger.info("solve.worktree.attached", { issueKey, path, branch, remote, reused: false });
  return { outcome: "created", worktree: { issueKey, path, branch, repoPath } };
}

/**
 * The worktree registered at `path`, read from `git worktree list --porcelain`.
 *
 * Pure, and separate from the command that feeds it, because the interesting
 * cases are all shapes of text: a record for a *different* path whose branch
 * line would otherwise be read as ours, a detached checkout with no branch line
 * at all, and the last record in the output, which has no blank line after it.
 *
 * Porcelain rather than the human format on purpose — the plain listing prints
 * `<path> <sha> [<branch>]` with the branch in brackets, and a path containing
 * a space would make that ambiguous. Matching is exact string equality on the
 * path: git prints the resolved path, so a caller passing one that differs by a
 * symlink falls through to the cold path and gets a refusal naming the path,
 * which is a readable failure rather than a silent reuse of the wrong checkout.
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
      // A new record begins. If we were inside ours it ended without naming a
      // branch, which is a detached or bare checkout.
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

/**
 * A checkout that cannot be reused and whose state can be moved out of the way.
 *
 * Distinct from a refusal, and the line between them is the transient/
 * deterministic split. A failed *read* — git did not answer, the counts came
 * back unparseable — might succeed next tick, so it refuses and the loop
 * retries. A *state* the checkout is in will be the same state next tick and
 * for ever, so refusing is a permanent stop dressed as a retry.
 */
interface SalvageNeeded {
  readonly outcome: "salvage";
  /** Why it cannot be reused, as a clause that follows "the checkout at <path>". */
  readonly reason: string;
}

const salvage = (reason: string): SalvageNeeded => ({ outcome: "salvage", reason });

/**
 * Reuses the checkout already at the path, or says what is wrong with it.
 *
 * The repairs are argued in `attachWorktree`'s header. What is worth saying
 * here is the ordering: cleanliness is checked before the fast-forward, so a
 * worktree somebody is working in is never merged into, and the ahead/behind
 * counts are read in one command so the two numbers describe the same instant.
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
    // Still never committed from — a review round commits everything it finds,
    // and answering a reviewer with somebody else's work in progress under our
    // name is the thing this guard exists to prevent. What changed is the
    // remedy: the changes are moved aside intact rather than left in place with
    // the loop stopped on top of them. Note the dirt is usually *ours*, from a
    // round that threw before its cleanup ran, and git cannot tell us whose it
    // is — so prevention is not available and preservation is.
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
    // Refused rather than assumed zero. Reading an unparseable count as "in
    // sync" is how a checkout carrying unpushed commits gets committed on top
    // of and pushed to a pull request under review.
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
      // A fast-forward that will not apply is a statement about the checkout,
      // not about git being unavailable, so it salvages rather than refusing.
      return salvage(`it cannot be fast-forwarded to ${remote} (${why(merged)})`);
    }
  }

  logger.info("solve.worktree.attached", { issueKey, path, branch, remote, reused: true, behind });
  return { outcome: "created", worktree: { issueKey, path, branch, repoPath } };
}

/**
 * Moves an unusable checkout aside so the canonical path can be rebuilt.
 *
 * Returns `null` on success, meaning *carry on* — the caller falls through to
 * the cold path and `worktree add` runs exactly as it would on a machine that
 * had never seen this ticket. A `WorktreeResult` is a refusal, and it is
 * returned whenever a step fails, because a half-salvage is worse than the
 * state it started from: a moved worktree whose branch is still checked out
 * there, or a deleted branch whose worktree is still at the canonical path,
 * are both things the cold path would trip over with a less legible error.
 *
 * ## Nothing is deleted, and that is the whole licence for this function
 *
 * The refusals this replaces were right about what they were protecting:
 * uncommitted edits, and commits the remote has never seen, both of which can
 * be somebody's unbacked-up work. Salvage keeps every byte of it. The directory
 * is *moved*, not removed, and the log names where it went, so the recovery is
 * a `cd` rather than a reflog expedition.
 *
 * ## The order is forced by git, not chosen
 *
 * 1. `checkout --detach` in the worktree. Git refuses to check out a branch
 *    that is already checked out in another worktree, so the cold path's
 *    `add -b <branch>` cannot run while this checkout holds the name. Detaching
 *    is the one operation that frees a branch name while touching neither the
 *    working tree nor the commit — dirty files stay dirty, and HEAD still
 *    points at the same commit, which is what keeps the "ahead" commits
 *    reachable after step 3. Skipped when the checkout is on some *other*
 *    branch: that name is not in our way, and detaching it would be a change to
 *    somebody else's checkout for no benefit.
 * 2. `worktree move` to a timestamped sibling. Frees the canonical path.
 * 3. `branch -D`, and only for a branch we detached in step 1. Git refuses to
 *    delete a branch checked out elsewhere, which is why it cannot come first;
 *    and by this point every commit on it is reachable from the salvaged
 *    worktree's detached HEAD, so `-D` destroys no history. A branch we did
 *    *not* detach is left alone — it may carry unpushed work of its own, and if
 *    it then collides, the cold path's refusal says so by name.
 *
 * ## A failed step refuses, and that is a wedge with a bound around it
 *
 * If `worktree move` fails deterministically — a locked worktree, a permission
 * problem — every tick refuses identically, which is the shape of the deadlock
 * this function exists to remove. The difference is that it is now the *only*
 * such path rather than the ordinary one, and the attempt counter in the pull
 * request marker is what stops it: unlike the state refusals, a salvage failure
 * is a failure to start that something counts. This function must not ship
 * without that counter.
 */
async function salvageWorktree(
  runner: CommandRunner,
  request: AttachRequest,
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

  // Colons are legal in a path and awkward in every shell, so the timestamp is
  // flattened. It is only there to keep two salvages of the same ticket from
  // colliding; nothing reads it back.
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

  logger.warn("solve.worktree.salvaged", { issueKey, path, salvagePath, branch, reason });
  return null;
}

/**
 * What the caller wants done with the checkout.
 *
 * This used to be `"succeeded" | "failed"` — the run's verdict — and the two
 * readings only coincided by luck. They part company at the first
 * `environment` abandon: the run did not succeed, and its worktree must still
 * go, because the retry cuts a fresh one at the same path from the same branch
 * name and would otherwise collide with its own predecessor. Naming the
 * disposition rather than the verdict means a caller has to say what it wants
 * instead of encoding it in a word that means something else.
 */
export type Disposition =
  /** Remove it. Only ever safe when nothing was written, or nothing is wanted. */
  | "discard"
  /** Leave it on disk; a human is going to read the diff. */
  | "keep-as-evidence";

/**
 * Removes the worktree — but only when the caller asks for it gone.
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
 *
 * Removing the checkout is only half the cleanup: `git worktree remove` leaves
 * the branch behind. Both names are derived from the issue key, so a leftover
 * ref is not litter but a landmine — the next run of the same ticket fails at
 * `worktree add -b` on a branch its own predecessor created. So the branch goes
 * too, and whether it went is reported rather than only logged.
 */
export async function removeWorktree(
  runner: CommandRunner,
  worktree: Worktree,
  disposition: Disposition,
  timeoutMs: number,
): Promise<RemoveResult> {
  if (disposition === "keep-as-evidence") {
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

  const branch = await deleteBranch(runner, worktree, timeoutMs);
  return { outcome: "removed", path: worktree.path, branch };
}

/**
 * Deletes the branch the worktree was on, without forcing.
 *
 * `-d`, never `-D`, and the difference is the entire safety argument. `-d`
 * refuses to delete a branch holding commits that are not reachable from
 * elsewhere, so this can only ever remove a ref that points at something
 * already safe — which, for the branch of a run that bailed before writing
 * anything, is exactly the base commit it was cut from. If a future pass does
 * commit, git declines and the reason travels back rather than the work going
 * quietly missing. `-D` would turn this from tidying into deletion.
 *
 * Called only after the worktree is gone: git will not delete the branch of a
 * live worktree, so the order is not stylistic.
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
    logger.info("solve.branch.kept", {
      issueKey: worktree.issueKey,
      branch: worktree.branch,
      reason: why(deleted),
    });
    return { outcome: "kept", reason: `git would not delete it (${why(deleted)})` };
  }

  logger.info("solve.branch.deleted", { issueKey: worktree.issueKey, branch: worktree.branch });
  return { outcome: "deleted" };
}
