/**
 * Delivery: the commit, the push, the draft PR, the review round-trip, and the
 * undraft. Everything between "the worktree holds a verified fix" and "a human
 * has something to look at".
 *
 * The solve pipeline before this point is all refusal — `branch.ts` decides what
 * may be written to, `diff-gate.ts` decides whether the diff is one we are
 * willing to show anyone, `verify.ts` decides whether it actually passes. This
 * module is the first one that makes something visible outside the machine, and
 * it is deliberately the dumbest module in the phase: it builds argv arrays,
 * hands them to the injected runner, and translates exit codes into a small
 * closed set of outcomes. It decides nothing about whether the delivery *should*
 * happen. That question was answered upstream, and answering it twice in two
 * places is how the two answers start disagreeing.
 *
 * ## argv arrays, never a command string
 *
 * Every command here is a `readonly string[]` handed to `CommandRunner.run`,
 * which spawns without a shell. This matters more here than anywhere else in
 * the phase, because of where the arguments come from. A PR title and body are
 * written by a model, and the model wrote them after reading a Jira ticket that
 * anyone with a board account can edit. So the path is:
 *
 *     ticket text (attacker-controlled) → model → `--title` / `--body`
 *
 * With a shell in that path, a summary containing shell metacharacters is
 * remote code execution against the machine running the solver. With argv, it
 * is a pull request with a stupid title. There is no escaping function in this
 * file and there must never be one: an escaper is a thing that can have a bug,
 * and the absence of a shell is a thing that cannot. `src/solve/exec.ts` closes
 * the other half by refusing to start any program that is not `git` or `gh`, so
 * even an argument-injection bug in this file cannot reach a new binary.
 *
 * ## `--force` is not here, and must not be added
 *
 * `push` is `--set-upstream origin <branch>` and nothing else. Not `--force`,
 * not `--force-with-lease`, not `+refs/…`. The branch was created by
 * `createWorktree` with `git worktree add -b`, which fails if the branch already
 * exists, so a push that git rejects as non-fast-forward means something this
 * service does not model is writing to that ref — a second solver, a human who
 * pushed a correction, a retried run. Every one of those is a case where
 * overwriting is the wrong move and stopping is the right one.
 *
 * The temptation to add `--force-with-lease` will come from a real failure: a
 * retry after a partial run, where the remote branch exists and the local one
 * has been rebuilt. Fix that by not reusing the branch, not by learning to
 * overwrite. A force-push in an automated loop is unrecoverable in the one
 * direction that matters — the overwritten commits are on nobody's machine.
 *
 * ## The PR number is parsed, not guessed
 *
 * `gh pr create` prints the PR URL on stdout and nothing else useful. The number
 * is extracted with an end-anchored regex against the trimmed last line, and if
 * that does not match, this returns `failed`. It does not fall back to
 * `gh pr list`, does not scan for the first run of digits, and does not assume
 * "the newest PR on the branch is ours".
 *
 * The reason is that the number is subsequently passed to `gh pr edit`,
 * `gh pr view` and `gh pr ready` — commands that change or read *a* pull
 * request. A wrong number does not fail; it succeeds against somebody else's
 * PR, and `gh pr ready` in particular takes a human's draft out of draft. The
 * cost of refusing to guess is a run that stops with a draft PR open and a clear
 * message. The cost of guessing wrong is an action taken on a stranger's branch.
 * Those are not comparable.
 *
 * ## The loop this module contains nothing against
 *
 * State it plainly, because it is the most important paragraph in the file. The
 * PR body is written by a model. It is then read by the review bot, whose
 * comments come back through `readReview` and `formatReviewFeedback` and are fed
 * to the model again on the next pass. That is a closed loop carrying untrusted
 * text, and *nothing in this file breaks it*. `formatReviewFeedback` does not
 * sanitise; its `---` delimiters are forgeable by any comment body containing
 * the same delimiter, and whatever a review comment says reaches the model
 * verbatim, including text aimed at the model rather than at the code.
 *
 * The containment for that lives elsewhere and is structural rather than
 * textual: the session's tool denial list bounds what the model can do at all,
 * `diff-gate.ts` refuses a diff that touches CI, secrets or lockfiles whatever
 * the model believed it was asked to do, `verify.ts` reruns the tests from the
 * pristine manifest, and the PR stays a *draft* with a human on the other end.
 * Adding a keyword filter here would be worse than useless — it would suggest
 * the loop is contained at this layer, and it is not. This is a known, accepted
 * limitation of running the review loop at all.
 *
 * ## Failures are returned; two things throw
 *
 * A `git` or `gh` command that fails produces a `failed` outcome carrying the
 * command's own complaint, never an exception. The orchestrator is the thing
 * that knows whether a failed push means "retry next tick", "unclaim the ticket"
 * or "stop the cycle", and an exception would take that decision away from it by
 * unwinding through it.
 *
 * The exceptions are the two branch guards — `push` and `createDraftPr` throw
 * when handed a protected or non-work branch. That is deliberate and is the one
 * asymmetry in the module. `failed` is a value the orchestrator is expected to
 * handle, log and possibly retry; "you tried to push to `main`" must not be
 * something anything can retry, and must not be reachable by a caller that
 * ignores a return value. It is a bug in the caller, not a fact about the
 * remote, and the two should not arrive by the same channel.
 */

import { logger } from "../logger.ts";
import { assertWorkBranch, isProtectedRef } from "./branch.ts";
import type { CommandResult, CommandRunner } from "./worktree.ts";

/**
 * The reviewer asked for on every PR this service opens.
 *
 * `@copilot` is the handle GitHub's own review bot answers to for
 * `gh pr edit --add-reviewer`. It is a constant rather than configuration
 * because the whole review loop — request, poll, feed back, undraft — is built
 * around a reviewer that responds without a human being paged, and swapping in
 * a person's handle would turn a polling loop into a machine that pesters
 * somebody every tick.
 */
export const COPILOT_REVIEWER = "@copilot";

/**
 * Cap on the feedback block handed back to the model.
 *
 * A review can be long, and the block is concatenated into a prompt alongside
 * the ticket, the diff and the instructions. Bounding it here rather than at
 * the prompt-assembly site means the caller cannot forget: by the time an
 * oversized block reaches the prompt it has already displaced the parts of the
 * context that were actually load-bearing.
 */
export const MAX_FEEDBACK_CHARS = 20_000;

/**
 * The commit identity, passed explicitly on every commit.
 *
 * Not read from ambient git config. The solver runs in a worktree of somebody
 * else's repository on a machine whose `~/.gitconfig` belongs to a human, and
 * inheriting that identity would attribute machine-written commits to them —
 * in `git blame`, in the PR author line, and in whatever CODEOWNERS automation
 * reads the committer. The commits must say what made them.
 */
export interface BotIdentity {
  readonly name: string;
  readonly email: string;
}

export interface CommitRequest {
  readonly worktreePath: string;
  /** First `-m`. Conventional-commit subject line. */
  readonly subject: string;
  /** Second `-m`. Model-authored prose; may contain anything, including quotes. */
  readonly body: string;
  readonly identity: BotIdentity;
  readonly timeoutMs: number;
}

export type CommitResult =
  | { readonly outcome: "committed"; readonly sha: string }
  /** The run changed nothing. An ordinary result, not a fault. */
  | { readonly outcome: "nothing-to-commit" }
  | { readonly outcome: "failed"; readonly reason: string };

export interface PushRequest {
  readonly worktreePath: string;
  readonly branch: string;
  readonly timeoutMs: number;
}

export type PushResult =
  | { readonly outcome: "pushed" }
  | { readonly outcome: "failed"; readonly reason: string };

export interface CreatePrRequest {
  readonly worktreePath: string;
  /** `owner/name`, passed to `--repo` so gh never has to infer it. */
  readonly repo: string;
  readonly baseBranch: string;
  readonly branch: string;
  /** Model-authored. See the header: attacker-influenced, and that is accepted. */
  readonly title: string;
  readonly body: string;
  readonly timeoutMs: number;
}

export type CreatePrResult =
  | { readonly outcome: "created"; readonly number: number; readonly url: string }
  | { readonly outcome: "failed"; readonly reason: string };

export interface ReviewRequest {
  readonly worktreePath: string;
  readonly repo: string;
  readonly number: number;
  /** Defaults to `COPILOT_REVIEWER`. */
  readonly reviewer?: string;
  readonly timeoutMs: number;
}

export type RequestReviewResult =
  | { readonly outcome: "requested" }
  | { readonly outcome: "failed"; readonly reason: string };

export interface ReviewComment {
  readonly author: string;
  readonly body: string;
}

export interface ReviewState {
  /** Whether the requested reviewer has said anything at all yet. */
  readonly reviewerResponded: boolean;
  /**
   * Whether the reviewer answered by saying it could not review.
   *
   * A third state between "no response" and "a review", and it exists because
   * the second one swallowed it. Observed live on PR #2657: the Copilot app was
   * requested, ran, could not read the pull request (`Resource not accessible
   * by integration` — its installation lacked `pull_requests: read` on that
   * repository) and posted **a normal `COMMENTED` review** whose entire body
   * was "Copilot encountered an error and was unable to review this pull
   * request."
   *
   * Without this flag that is indistinguishable from a reviewer with an
   * opinion, and both readings of it are wrong. As a comment it is feedback,
   * so a review round would spend a paid pass asking a model to address an
   * error message. As an empty review it is approval, so the loop would
   * undraft and mark the ticket `agent:done` on the strength of a review that
   * never happened — a bot telling a human the code was reviewed when it was
   * not, which is the worst outcome this pipeline can produce.
   */
  readonly reviewerErrored: boolean;
  /** Every comment with usable text, from reviews and issue comments alike. */
  readonly comments: readonly ReviewComment[];
  readonly state: string;
  readonly isDraft: boolean;
}

export type ReadReviewResult =
  | { readonly outcome: "read"; readonly review: ReviewState }
  | { readonly outcome: "failed"; readonly reason: string };

export interface ThreadComment {
  readonly author: string;
  readonly body: string;
  /** ISO 8601, as GitHub returns it. Not parsed here; ordering is the API's. */
  readonly createdAt: string;
}

/**
 * One inline conversation on the diff.
 *
 * These are the comments `gh pr view --json reviews,comments` cannot reach, and
 * on the first real review round they were the entire substance of the review:
 * the summary body said "minor robustness/test-isolation improvements
 * suggested" and the two things actually being asked for were down here. A loop
 * reading only the summary does not miss the review politely — it infers what
 * the review probably said and then acts on the inference.
 */
export interface ReviewThread {
  /** The GraphQL node id. What a reply and a resolve are both addressed to. */
  readonly id: string;
  readonly isResolved: boolean;
  /**
   * Whether the diff has moved out from under the thread.
   *
   * Not the same as resolved and must not be read as it. An outdated thread is
   * one whose lines changed, which is what happens when a round addresses the
   * comment — and also what happens when an unrelated edit lands nearby. It is
   * a hint about where to look, not a verdict about whether the point stands.
   */
  readonly isOutdated: boolean;
  readonly path: string;
  /** `null` on an outdated thread — GitHub drops the line once the diff moves. */
  readonly line: number | null;
  readonly comments: readonly ThreadComment[];
}

export type ReadThreadsResult =
  | { readonly outcome: "read"; readonly threads: readonly ReviewThread[] }
  | { readonly outcome: "failed"; readonly reason: string };

export interface MarkReadyRequest {
  readonly worktreePath: string;
  readonly repo: string;
  readonly number: number;
  readonly timeoutMs: number;
}

export type MarkReadyResult =
  | { readonly outcome: "ready" }
  | { readonly outcome: "failed"; readonly reason: string };

/**
 * The PR URL, matched at the end of the line and nowhere else.
 *
 * End-anchored on purpose. `gh` prints `https://host/org/repo/pull/42`, and the
 * anchor is what stops `…/pull/42/files` — a URL that appears in review output,
 * in a body the model wrote, and in gh's own hints — from being read as the PR
 * this run just created. An unanchored match against arbitrary stdout is a
 * number lifted from whichever line happened to contain one.
 */
const PR_URL = /\/pull\/(\d+)\s*$/u;

/** What `git rev-parse HEAD` is allowed to have printed. */
const SHA = /^[0-9a-f]{7,64}$/u;

/**
 * Git's two ways of saying the index held nothing.
 *
 * Matched as substrings of stdout because the exact wording around them varies
 * with git version and with whether the worktree has untracked files. Both
 * phrases have been stable across git for well over a decade; the surrounding
 * sentence has not.
 */
const NOTHING_TO_COMMIT = ["nothing to commit", "no changes added"];

/** Same shape as `worktree.ts`; duplicated rather than exported, both are three lines. */
function failed(result: CommandResult): boolean {
  return result.timedOut || result.exitCode !== 0;
}

/** How much of a failed command's output is kept, from each end. */
const DETAIL_HALF = 200;

/**
 * A failed command, in one line a person can act on.
 *
 * **Both ends are kept, and the middle is dropped.** This used to keep the
 * first 300 characters, and the first live pull-request run showed why that is
 * the wrong end. Commitlint echoes the message it was given before it prints
 * its verdict, so 300 characters of head was 300 characters of our own commit
 * body and the rule name — the only part that says what to change — was cut.
 *
 * Head alone is wrong, and tail alone would be too: a tool that fails on the
 * third of five steps says which step at the top and prints the stack at the
 * bottom. Keeping both ends costs a few hundred characters in a log line and
 * removes a whole class of "the error message did not contain the error".
 */
function why(result: CommandResult): string {
  if (result.timedOut) {
    return "timed out";
  }
  const detail = (result.stderr.trim() === "" ? result.stdout : result.stderr).trim();
  return `exit ${String(result.exitCode)}${detail === "" ? "" : `: ${bothEnds(detail)}`}`;
}

/** `text`, or its first and last `DETAIL_HALF` characters with the gap marked. */
function bothEnds(text: string, half = DETAIL_HALF): string {
  if (text.length <= half * 2) {
    return text;
  }
  const cut = text.length - half * 2;
  return `${text.slice(0, half)} […${String(cut)} chars…] ${text.slice(-half)}`;
}

/**
 * Whether an identity value is safe to put in a commit header.
 *
 * This is configuration rather than model output, so it is not an attack
 * surface in the way the PR body is. It is checked anyway because the failure
 * mode is quiet: a newline in `user.name` becomes a newline inside the `author`
 * line of the commit object, and depending on git version that either produces
 * a commit no tool can parse or one whose author field says something the
 * config did not. A misconfiguration should fail here, at the point the value
 * becomes an argument, rather than in whatever reads the object later.
 */
function usableIdentityPart(value: string): boolean {
  return value.trim() !== "" && !/[\n\r]/u.test(value);
}

/**
 * Stages and commits everything in the worktree.
 *
 * `add -A` and not a path list: the diff gate has already inspected the full
 * working tree and either accepted or refused it, so committing a subset would
 * mean shipping something other than what was approved. If the gate passed the
 * diff, the diff is what goes in.
 *
 * The message is two `-m` flags rather than one concatenated string, and never
 * a heredoc or a `--file`. Two flags is how git is told "subject, blank line,
 * body" without this module having to know that the separator is a blank line;
 * a concatenated string would put that formatting rule here, where it would be
 * subtly wrong for a body that already starts with a newline. The heredoc
 * version is worse still — it needs a shell, and there is no shell.
 *
 * "Nothing to commit" is its own outcome and not a failure. A solve run that
 * concluded the ticket needed no code change is a legitimate thing for the
 * model to do, and collapsing it into `failed` would put it in the same bucket
 * as a broken index, which the orchestrator must treat completely differently.
 */
export async function commitAll(
  runner: CommandRunner,
  request: CommitRequest,
): Promise<CommitResult> {
  const { worktreePath, subject, body, identity, timeoutMs } = request;
  const options = { cwd: worktreePath, timeoutMs };

  if (!usableIdentityPart(identity.name) || !usableIdentityPart(identity.email)) {
    return {
      outcome: "failed",
      reason:
        "the configured commit identity is empty or contains a line break — a newline here corrupts the commit object rather than being rejected, so it is refused at the point it becomes an argument",
    };
  }

  const staged = await runner.run(["git", "-C", worktreePath, "add", "-A"], options);
  if (failed(staged)) {
    return { outcome: "failed", reason: `could not stage the worktree (${why(staged)})` };
  }

  // `-c` before `-C`: these are git's own options and must precede the
  // subcommand's. Passing the identity per-invocation rather than running
  // `git config user.name` first means it cannot be left behind in the
  // worktree's config for whatever runs next.
  const committed = await runner.run(
    [
      "git",
      "-c",
      `user.name=${identity.name}`,
      "-c",
      `user.email=${identity.email}`,
      "-C",
      worktreePath,
      "commit",
      "-m",
      subject,
      "-m",
      body,
    ],
    options,
  );
  if (failed(committed)) {
    // Checked before the failure is reported, and against stdout — git prints
    // "nothing to commit" to stdout while exiting non-zero, which is the one
    // case where a non-zero exit is not a problem.
    const output = committed.stdout.toLowerCase();
    if (!committed.timedOut && NOTHING_TO_COMMIT.some((phrase) => output.includes(phrase))) {
      logger.info("solve.pr.nothing_to_commit", { worktreePath });
      return { outcome: "nothing-to-commit" };
    }
    return { outcome: "failed", reason: `could not commit (${why(committed)})` };
  }

  const head = await runner.run(["git", "-C", worktreePath, "rev-parse", "HEAD"], options);
  if (failed(head)) {
    return {
      outcome: "failed",
      reason: `committed, but could not read the resulting sha (${why(head)})`,
    };
  }

  const sha = head.stdout.trim();
  if (!SHA.test(sha)) {
    // The sha is quoted in the report and in the Jira comment. Something that
    // is not a sha reaching those places would be indistinguishable from one.
    return {
      outcome: "failed",
      reason: `committed, but rev-parse printed ${JSON.stringify(sha.slice(0, 60))} rather than a sha`,
    };
  }

  logger.info("solve.pr.committed", { worktreePath, sha });
  return { outcome: "committed", sha };
}

/**
 * Pushes the branch and sets its upstream.
 *
 * `assertWorkBranch` first, and it throws rather than returning `failed`. See
 * the header: a protected push target is a caller bug that must not be
 * retryable, and the runner is never reached — nothing is sent to the remote
 * and no partial state exists to clean up.
 *
 * `--set-upstream` so the branch has a tracking ref, which is what makes a
 * later `gh pr create --head` and any human `git pull` on the branch behave.
 *
 * There is no `--force` and no `--force-with-lease`, and their absence is the
 * point rather than an oversight. A rejected push means the remote branch moved
 * under us, and every reason that can happen is a reason to stop.
 */
export async function push(runner: CommandRunner, request: PushRequest): Promise<PushResult> {
  const { worktreePath, branch, timeoutMs } = request;

  assertWorkBranch(branch, "push target");

  const pushed = await runner.run(
    ["git", "-C", worktreePath, "push", "--set-upstream", "origin", branch],
    { cwd: worktreePath, timeoutMs },
  );
  if (failed(pushed)) {
    return {
      outcome: "failed",
      reason: `could not push ${branch} (${why(pushed)}) — not retried and not forced, because a rejected push means the remote branch moved`,
    };
  }

  logger.info("solve.pr.pushed", { branch });
  return { outcome: "pushed" };
}

/**
 * Opens the pull request as a draft.
 *
 * Draft, always. The undraft is a separate call (`markReady`) made only after
 * the review loop has finished, so the window where a PR exists and has not
 * been looked at is a window in which it cannot be merged and does not page
 * reviewers.
 *
 * Two refusals, both throwing for the reason given in the header:
 *
 *  - `assertWorkBranch` on the head. A PR whose head is a protected branch is
 *    a request to merge `main` into something, which is never what this
 *    service meant to do.
 *  - head equal to base. gh would reject it too, but with a message about
 *    "no commits between" that reads like a problem with the diff rather than
 *    with the arguments.
 *
 * The base is deliberately *not* required to be protected. A stacked PR onto
 * another work branch is legitimate, and nothing here writes to the base — the
 * only ref this module pushes to is the head, which is already guarded.
 *
 * `--repo` is always passed, so gh does not infer the repository from whatever
 * remote the cwd happens to have. The cwd is still the worktree, because gh
 * resolves `--head` against the local git state.
 */
export async function createDraftPr(
  runner: CommandRunner,
  request: CreatePrRequest,
): Promise<CreatePrResult> {
  const { worktreePath, repo, baseBranch, branch, title, body, timeoutMs } = request;

  assertWorkBranch(branch, "pull request head");
  if (branch === baseBranch) {
    throw new Error(
      `refusing to open a pull request from ${JSON.stringify(branch)} onto itself — a head equal to its base is a caller bug, and gh reports it as an empty diff`,
    );
  }
  if (isProtectedRef(branch)) {
    // Unreachable while `assertWorkBranch` holds — `isWorkBranch` already
    // rejects a protected name after the prefix. Kept because the rule is
    // absolute and should not depend on reading the implementation of a
    // function in another file, and recorded honestly: unplugging this guard on
    // its own fails no test, exactly like the `BRANCH` backstop in
    // `worktree.ts`. It is a hedge against a future edit loosening
    // `isWorkBranch`, not a control doing work today.
    throw new Error(`refusing to open a pull request from protected ref ${JSON.stringify(branch)}`);
  }

  const created = await runner.run(
    [
      "gh",
      "pr",
      "create",
      "--draft",
      "--repo",
      repo,
      "--base",
      baseBranch,
      "--head",
      branch,
      "--title",
      title,
      "--body",
      body,
    ],
    { cwd: worktreePath, timeoutMs },
  );
  if (failed(created)) {
    return { outcome: "failed", reason: `gh could not create the pull request (${why(created)})` };
  }

  const parsed = parsePrUrl(created.stdout);
  if (parsed === null) {
    return {
      outcome: "failed",
      reason:
        "gh exited zero but printed no pull request URL this could parse — refused rather than guessed, because the number is about to be passed to commands that would happily act on somebody else's pull request",
    };
  }

  logger.info("solve.pr.created", { repo, branch, number: parsed.number });
  return { outcome: "created", number: parsed.number, url: parsed.url };
}

/**
 * The PR number and URL from gh's stdout, or `null`.
 *
 * Only the last non-empty line is considered. gh prints progress and hints
 * before the URL, and some of those lines contain URLs of their own; taking the
 * last line is the rule that matches what gh actually does, and it fails closed
 * when gh changes rather than matching something else.
 *
 * Exported because "given this stdout, which number" is the highest-consequence
 * decision in the module and deserves to be tested directly rather than through
 * a fake runner.
 */
export function parsePrUrl(
  stdout: string,
): { readonly number: number; readonly url: string } | null {
  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  const last = lines.at(-1)?.trim() ?? "";
  const digits = PR_URL.exec(last)?.[1];
  if (digits === undefined) {
    return null;
  }
  const number = Number.parseInt(digits, 10);
  // A pull request is numbered from 1, and a value past the safe integer range
  // has already lost digits by the time it is compared here. Either means the
  // line was not the URL this run produced.
  if (!Number.isSafeInteger(number) || number <= 0) {
    return null;
  }
  return { number, url: last };
}

/**
 * Asks the reviewer for a review.
 *
 * Separate from `createDraftPr` because it fails separately and for reasons
 * that are not the PR's fault: the reviewer app may not be installed on the
 * org, or the token may lack the scope. A run whose PR exists but whose review
 * request failed is in a recoverable state — a human can add the reviewer — and
 * folding the two calls together would make that look like a failed PR.
 */
export async function requestReview(
  runner: CommandRunner,
  request: ReviewRequest,
): Promise<RequestReviewResult> {
  const { worktreePath, repo, number, timeoutMs } = request;
  const reviewer = request.reviewer ?? COPILOT_REVIEWER;

  const edited = await runner.run(
    ["gh", "pr", "edit", String(number), "--repo", repo, "--add-reviewer", reviewer],
    { cwd: worktreePath, timeoutMs },
  );
  if (failed(edited)) {
    return {
      outcome: "failed",
      reason: `gh could not add ${reviewer} as a reviewer on #${String(number)} (${why(edited)})`,
    };
  }

  logger.info("solve.pr.review_requested", { repo, number, reviewer });
  return { outcome: "requested" };
}

/** Narrows to a plain object. Arrays are excluded: a list is not a record here. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

interface RawEntry {
  readonly login: string;
  /** `null` when gh gave something that is not a string, including for an approval. */
  readonly body: string | null;
}

/**
 * Reviews or comments, normalised.
 *
 * Three distinct treatments, and the differences are deliberate:
 *
 *  - **absent or null** → an empty list. A PR with no reviews yet is the normal
 *    state for the first several ticks of the polling loop, and gh omits the
 *    key rather than sending `[]` in some versions.
 *  - **present but not an array** → `null`, which the caller turns into
 *    `failed`. That is gh returning a shape this does not understand, and
 *    reading it as "no reviews" would mean the loop undrafts a PR whose reviews
 *    it never managed to read.
 *  - **an element that is not an object** → skipped. One malformed entry among
 *    twenty should not discard the nineteen.
 */
function entriesOf(value: unknown): readonly RawEntry[] | null {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const entries: RawEntry[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record === null) {
      continue;
    }
    const login = asRecord(record["author"])?.["login"];
    const body = record["body"];
    entries.push({
      login: typeof login === "string" ? login : "",
      body: typeof body === "string" ? body : null,
    });
  }
  return entries;
}

/**
 * Whether a login belongs to the reviewer we asked for.
 *
 * A prefix match on the lowercased login, after stripping a leading `@` from
 * the reviewer name. This is looser than equality on purpose: the handle asked
 * for is `@copilot`, and the login that comes back on the review is
 * `copilot-pull-request-reviewer[bot]`. GitHub app logins acquire and shed
 * suffixes without notice, and an exact comparison that stopped matching would
 * fail in the worst possible direction — the loop would decide the reviewer
 * never responded and wait forever rather than undrafting.
 *
 * The empty-reviewer guard is load-bearing rather than defensive tidiness:
 * `"".startsWith("")` is true, so a reviewer of `""` or `"@"` would match every
 * login on the PR and report a response from a bot that was never asked.
 */
function matchesReviewer(login: string, reviewer: string): boolean {
  const wanted = reviewer.replace(/^@/u, "").toLowerCase();
  if (wanted === "") {
    return false;
  }
  return login.toLowerCase().startsWith(wanted);
}

export interface FindPrRequest {
  /** Where `gh` runs. The repository checkout, not a worktree — there may not be one yet. */
  readonly cwd: string;
  readonly repo: string;
  /** The branch to look for, as a bare name. Derived from the ticket, not from GitHub. */
  readonly branch: string;
  readonly timeoutMs: number;
}

export type FindPrResult =
  /**
   * One pull request, and its state.
   *
   * `state` is carried rather than reduced to a boolean because the three
   * values mean three different next moves: `OPEN` is a review round, `MERGED`
   * is the ticket finished, `CLOSED` is a person declining the change. A caller
   * handed only "usable/not" would have to guess between the last two.
   */
  | {
      readonly outcome: "found";
      readonly number: number;
      readonly state: string;
      readonly isDraft: boolean;
    }
  /** No pull request was ever opened for this branch. */
  | { readonly outcome: "none" }
  | { readonly outcome: "failed"; readonly reason: string };

/**
 * Finds the pull request for a branch.
 *
 * Exists because a review round starts from a ticket, and everything else it
 * needs hangs off a pull request number that nothing on this machine records.
 * The branch is the join: it is derived from the issue key and the summary by
 * `branchNameFor`, so it can be recomputed from the ticket alone, which is what
 * makes a review round resumable without any stored state.
 *
 * ## Closed and merged are searched for, not filtered out
 *
 * `--state all`, deliberately. Restricting to open ones would report a merged
 * pull request as "none", and the caller would read that as "nothing has been
 * published yet" — the opposite of the truth, at the one moment the loop is
 * supposed to stop. A terminal pull request is a *result*, not an absence.
 *
 * ## Ambiguity is refused rather than resolved
 *
 * Two open pull requests on one branch is not a state this service creates, so
 * seeing it means something happened that is not understood — a human opened a
 * second one, or a branch was reused. Picking either would be a guess, made
 * immediately before pushing a commit to whichever was picked. It fails
 * instead, and says both numbers so a person can look.
 *
 * The terminal case does not need that care: with no open pull request, a merge
 * is reported if any of them merged, regardless of how many there are, because
 * "this branch reached `main`" is true whichever one carried it. That reading is
 * also independent of the order `gh` happens to return rows in, which is not
 * documented and must not be relied on.
 */
export async function findPullRequest(
  runner: CommandRunner,
  request: FindPrRequest,
): Promise<FindPrResult> {
  const { cwd, repo, branch, timeoutMs } = request;

  const listed = await runner.run(
    [
      "gh",
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "number,state,isDraft",
      "--limit",
      "20",
    ],
    { cwd, timeoutMs },
  );
  if (failed(listed)) {
    return { outcome: "failed", reason: `gh could not list pull requests (${why(listed)})` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(listed.stdout);
  } catch {
    return { outcome: "failed", reason: "gh printed something that is not JSON for the PR list" };
  }
  if (!Array.isArray(parsed)) {
    return {
      outcome: "failed",
      reason:
        "the pull request list came back as something other than a list — read as a shape this does not understand rather than as an absence of pull requests",
    };
  }

  const rows: { number: number; state: string; isDraft: boolean }[] = [];
  for (const entry of parsed) {
    const row = asRecord(entry);
    const number = row?.["number"];
    const state = row?.["state"];
    const isDraft = row?.["isDraft"];
    if (typeof number !== "number" || typeof state !== "string" || typeof isDraft !== "boolean") {
      // One unreadable row is not "no pull requests". Dropping it silently is
      // how a merged PR becomes an absence, so the whole call fails instead.
      return {
        outcome: "failed",
        reason: "a pull request row is missing number, state or isDraft",
      };
    }
    rows.push({ number, state, isDraft });
  }

  if (rows.length === 0) {
    return { outcome: "none" };
  }

  const open = rows.filter((row) => row.state.toUpperCase() === "OPEN");
  if (open.length > 1) {
    return {
      outcome: "failed",
      reason: `${String(open.length)} open pull requests share the branch ${branch} (#${open
        .map((row) => String(row.number))
        .join(", #")}) — refusing to guess which one is under review`,
    };
  }

  const chosen = open[0] ?? rows.find((row) => row.state.toUpperCase() === "MERGED") ?? rows[0];
  if (chosen === undefined) {
    return { outcome: "none" };
  }

  return {
    outcome: "found",
    number: chosen.number,
    state: chosen.state.toUpperCase(),
    isDraft: chosen.isDraft,
  };
}

/**
 * Reads the current review state of the PR.
 *
 * One `gh pr view --json` call, parsed defensively: anything unexpected is a
 * `failed` outcome and never an exception, because this runs on a polling tick
 * and a throw here would take down the cycle over a PR that a human could just
 * look at.
 *
 * The strictness is deliberately uneven, and the line is drawn at what each
 * field decides:
 *
 *  - `reviews` and `comments` may be missing, and then they are empty. "No
 *    feedback yet" is a real state that this must be able to report.
 *  - `state` and `isDraft` may not be missing. Those two are what the caller
 *    checks before `gh pr ready`, and a default would be a guess about the
 *    actual condition of a pull request immediately before an irreversible
 *    action is taken on it.
 *
 * `reviewerResponded` is computed from logins alone, independently of whether
 * the entry carried usable text. An approving review has an empty body and is
 * still a response — treating it as silence would leave the loop waiting on a
 * reviewer that has already finished.
 */
export async function readReview(
  runner: CommandRunner,
  request: ReviewRequest,
): Promise<ReadReviewResult> {
  const { worktreePath, repo, number, timeoutMs } = request;
  const reviewer = request.reviewer ?? COPILOT_REVIEWER;

  const viewed = await runner.run(
    [
      "gh",
      "pr",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "reviews,comments,state,isDraft",
    ],
    { cwd: worktreePath, timeoutMs },
  );
  if (failed(viewed)) {
    return { outcome: "failed", reason: `gh could not read #${String(number)} (${why(viewed)})` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(viewed.stdout);
  } catch {
    return {
      outcome: "failed",
      reason: `gh printed something that is not JSON for #${String(number)}`,
    };
  }

  const root = asRecord(parsed);
  if (root === null) {
    return { outcome: "failed", reason: "the review payload is not a JSON object" };
  }

  const reviews = entriesOf(root["reviews"]);
  const comments = entriesOf(root["comments"]);
  if (reviews === null || comments === null) {
    return {
      outcome: "failed",
      reason:
        "reviews or comments came back as something other than a list — read as a shape this does not understand rather than as an absence of feedback",
    };
  }

  const state = root["state"];
  const isDraft = root["isDraft"];
  if (typeof state !== "string" || typeof isDraft !== "boolean") {
    return {
      outcome: "failed",
      reason:
        "the payload is missing state or isDraft — those decide whether the pull request may be marked ready, and a default there would be a guess made immediately before an irreversible action",
    };
  }

  const entries = [...reviews, ...comments];
  const fromReviewer = entries.filter((entry) => matchesReviewer(entry.login, reviewer));
  return {
    outcome: "read",
    review: {
      reviewerResponded: fromReviewer.length > 0,
      reviewerErrored: fromReviewer.some((entry) => isReviewerError(entry.body)),
      // Whitespace-only bodies are dropped here and not above: they are a
      // response for the purpose of "has the reviewer spoken", and nothing at
      // all for the purpose of "what should the model change". The reviewer's
      // own error notice goes the same way and for the same reason — there is
      // nothing in it to change.
      //
      // That second drop is scoped to the reviewer, not applied to every entry.
      // A human quoting the failure in a comment is asking for something, and
      // matching on text alone would delete a person's message because a bot
      // had used the same words.
      comments: entries.flatMap((entry) =>
        entry.body === null ||
        entry.body.trim() === "" ||
        (matchesReviewer(entry.login, reviewer) && isReviewerError(entry.body))
          ? []
          : [{ author: entry.login === "" ? "unknown" : entry.login, body: entry.body }],
      ),
      state,
      isDraft,
    },
  };
}

/**
 * Phrases a reviewer uses to say it could not review.
 *
 * Matching a vendor's error prose is brittle and this is the narrowest form of
 * it available: the app posts the failure as an ordinary review, so its text is
 * the only thing distinguishing "I could not read this" from "I read it and had
 * nothing to say". Both fragments are required to appear together, which is
 * what keeps a review *about* an error — "this encountered an error and was
 * unable to parse the config" — from matching.
 *
 * If GitHub rewords it, this stops matching and the loop goes back to treating
 * an error as feedback. That is the failure direction to be in: it wastes a
 * review round and says so in the pull request, where the next person to look
 * will see an error message quoted as a review comment and come back here.
 */
const REVIEWER_ERROR = [/encountered an error/iu, /unable to review/iu];

/** Whether a review body is the reviewer saying it failed rather than a review. */
function isReviewerError(body: string | null): boolean {
  return body !== null && REVIEWER_ERROR.every((phrase) => phrase.test(body));
}

/**
 * How many threads, and how many comments in each, one read asks for.
 *
 * The maximum a single GraphQL connection accepts. Paging is not implemented
 * and truncation is refused instead, because the only reason this function
 * exists is that the loop was acting on feedback it could not see — quietly
 * dropping the hundred-and-first thread would rebuild that defect one page
 * further out. A pull request that hits either bound wants a human anyway.
 */
const THREAD_PAGE = 100;

const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:${String(THREAD_PAGE)}){
        pageInfo{ hasNextPage }
        nodes{
          id isResolved isOutdated path line
          comments(first:${String(THREAD_PAGE)}){
            pageInfo{ hasNextPage }
            nodes{ author{login} body createdAt }
          }
        }
      }
    }
  }
}`;

/** `owner/name`, split into the two arguments GraphQL wants separately. */
const OWNER_NAME = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/u;

/** Follows a chain of keys, stopping at the first that is not a record. */
function dig(root: unknown, ...keys: readonly string[]): unknown {
  let here: unknown = root;
  for (const key of keys) {
    const record = asRecord(here);
    if (record === null) {
      return undefined;
    }
    here = record[key];
  }
  return here;
}

/** Whether a connection said there is another page behind the one we read. */
function truncated(connection: unknown): boolean {
  return dig(connection, "pageInfo", "hasNextPage") === true;
}

function parseThreadComments(value: unknown): readonly ThreadComment[] | null {
  const nodes = dig(value, "nodes");
  if (!Array.isArray(nodes)) {
    return null;
  }
  const comments: ThreadComment[] = [];
  for (const node of nodes) {
    const record = asRecord(node);
    const body = record?.["body"];
    const createdAt = record?.["createdAt"];
    if (typeof body !== "string" || typeof createdAt !== "string") {
      return null;
    }
    const login = dig(record, "author", "login");
    // A deleted account comes back as a null author. The comment it left is
    // still on the thread and still says whatever it says.
    comments.push({ author: typeof login === "string" ? login : "unknown", body, createdAt });
  }
  return comments;
}

/**
 * Reads the inline review threads on a pull request.
 *
 * Separate from `readReview` and over a different transport, because the two
 * cannot be merged: `gh pr view --json` has no flag for these at all, and the
 * fields that make a thread actionable — its node id, and whether it is already
 * resolved — exist only in GraphQL. So this is `gh api graphql`, and it is the
 * only place in the tree that speaks it.
 *
 * **Nothing here degrades to an empty list.** `entriesOf` skips a malformed
 * entry, on the reasoning that one bad review among twenty should not discard
 * the nineteen; the opposite rule applies here and for a reason that is
 * specific rather than stylistic. A dropped review is a comment the loop does
 * not answer. A dropped *thread* is a comment the loop does not answer while
 * believing it has answered everything — and the round then resolves what it
 * did see, undrafts, and tells a human the review was addressed. Every
 * unreadable shape is therefore a refusal, including a single bad node.
 */
export async function readReviewThreads(
  runner: CommandRunner,
  request: ReviewRequest,
): Promise<ReadThreadsResult> {
  const { worktreePath, repo, number, timeoutMs } = request;

  const parts = OWNER_NAME.exec(repo);
  if (parts === null) {
    return {
      outcome: "failed",
      reason: `"${repo}" is not an owner/name pair, and GraphQL takes the two separately`,
    };
  }

  const queried = await runner.run(
    [
      "gh",
      "api",
      "graphql",
      // `-f` and not `-F`: the typed form reads a value beginning with `@` out
      // of a file, and the raw form does not interpret the value at all.
      "-f",
      `owner=${parts[1] ?? ""}`,
      "-f",
      `name=${parts[2] ?? ""}`,
      "-F",
      `number=${String(number)}`,
      "-f",
      `query=${THREADS_QUERY}`,
    ],
    { cwd: worktreePath, timeoutMs },
  );
  if (failed(queried)) {
    return {
      outcome: "failed",
      reason: `gh could not read the review threads on #${String(number)} (${why(queried)})`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(queried.stdout);
  } catch {
    return {
      outcome: "failed",
      reason: `gh printed something that is not JSON for the review threads on #${String(number)}`,
    };
  }

  // GraphQL answers a partly-failed query with data *and* errors, and gh has
  // been known to exit 0 on it. Half a thread list read as a whole one is the
  // failure this function exists to prevent.
  if (dig(parsed, "errors") !== undefined) {
    return {
      outcome: "failed",
      reason: `GraphQL returned errors for the review threads on #${String(number)} (${bothEnds(queried.stdout)})`,
    };
  }

  const connection = dig(parsed, "data", "repository", "pullRequest", "reviewThreads");
  const nodes = dig(connection, "nodes");
  if (!Array.isArray(nodes)) {
    return {
      outcome: "failed",
      reason:
        "the review threads came back as a shape this does not understand — read as unreadable rather than as a pull request with no inline comments",
    };
  }
  if (truncated(connection)) {
    return {
      outcome: "failed",
      reason: `#${String(number)} has more than ${String(THREAD_PAGE)} review threads, which is past what one read covers`,
    };
  }

  const threads: ReviewThread[] = [];
  for (const node of nodes) {
    const record = asRecord(node);
    if (record === null) {
      return {
        outcome: "failed",
        reason: "a review thread came back as something other than an object",
      };
    }
    const id = record["id"];
    const isResolved = record["isResolved"];
    const isOutdated = record["isOutdated"];
    const path = record["path"];
    const line = record["line"];
    if (
      typeof id !== "string" ||
      id === "" ||
      typeof isResolved !== "boolean" ||
      typeof isOutdated !== "boolean" ||
      typeof path !== "string" ||
      !(typeof line === "number" || line === null)
    ) {
      return { outcome: "failed", reason: "a review thread is missing fields this needs to act" };
    }
    if (truncated(record["comments"])) {
      return {
        outcome: "failed",
        reason: `the thread on ${path} has more than ${String(THREAD_PAGE)} comments, and the reply this round would answer may not be among the ones read`,
      };
    }
    const comments = parseThreadComments(record["comments"]);
    if (comments === null) {
      return { outcome: "failed", reason: `a comment on the thread on ${path} could not be read` };
    }
    threads.push({ id, isResolved, isOutdated, path, line, comments });
  }

  logger.info("solve.pr.threads_read", {
    repo,
    number,
    threads: threads.length,
    open: threads.filter((thread) => !thread.isResolved).length,
  });
  return { outcome: "read", threads };
}

/**
 * Takes the PR out of draft.
 *
 * The last thing the pipeline does, and the only irreversible-feeling one — an
 * undrafted PR notifies reviewers and becomes mergeable. It is a separate
 * exported function with no logic of its own precisely so the decision to call
 * it lives entirely in the orchestrator, where the review-iteration count and
 * the verification verdict are both in scope.
 */
export async function markReady(
  runner: CommandRunner,
  request: MarkReadyRequest,
): Promise<MarkReadyResult> {
  const { worktreePath, repo, number, timeoutMs } = request;

  const ready = await runner.run(["gh", "pr", "ready", String(number), "--repo", repo], {
    cwd: worktreePath,
    timeoutMs,
  });
  if (failed(ready)) {
    return {
      outcome: "failed",
      reason: `gh could not mark #${String(number)} ready for review (${why(ready)})`,
    };
  }

  logger.info("solve.pr.ready", { repo, number });
  return { outcome: "ready" };
}

/** Appended when the block is cut. Its own length is subtracted from the budget. */
const TRUNCATION_NOTE = `\n\n[Feedback truncated at ${String(MAX_FEEDBACK_CHARS)} characters. Read the pull request for the rest.]`;

/**
 * Renders review comments as a plain-text block for the next model pass.
 *
 * Plain text and not JSON or markdown: this is concatenated into a prompt, and
 * the two structured formats both invite the reader to believe the structure is
 * trustworthy. It is not — see the header. The `---` delimiters below are a
 * reading aid for a human debugging a prompt, nothing more, and a comment body
 * containing the same delimiter forges one. That is stated rather than fixed,
 * because escaping it would imply the boundary means something.
 *
 * The count is in the header line so a truncated block is still self-describing:
 * the reader can see that four of eleven comments are present and that the rest
 * exist somewhere else.
 */
export function formatReviewFeedback(comments: readonly ReviewComment[]): string {
  if (comments.length === 0) {
    return "No review comments.";
  }

  const rendered = comments
    .map(
      (comment, index) =>
        `--- comment ${String(index + 1)} of ${String(comments.length)}, by ${comment.author} ---\n${comment.body.trim()}`,
    )
    .join("\n\n");
  const block = `Review feedback (${String(comments.length)} ${comments.length === 1 ? "comment" : "comments"}):\n\n${rendered}`;

  if (block.length <= MAX_FEEDBACK_CHARS) {
    return block;
  }
  // The note is inside the budget, not added to it. A cap that the truncation
  // notice itself can exceed is not a cap.
  return `${block.slice(0, MAX_FEEDBACK_CHARS - TRUNCATION_NOTE.length)}${TRUNCATION_NOTE}`;
}
