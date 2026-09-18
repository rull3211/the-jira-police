/**
 * Delivery: commit, push, draft PR, review round-trip, and undraft.
 *
 * Commands are argv arrays handed to `CommandRunner.run`, which spawns without a
 * shell, so nothing here escapes arguments. A failed `git`/`gh` command returns a
 * `failed` outcome; `push` and `createDraftPr` throw instead, on a protected or
 * non-work branch.
 */

import { createLogger } from "../logger.ts";
import { assertWorkBranch, isProtectedRef } from "./branch.ts";
import { BOT_PREFIX, isOurs } from "./marker.ts";
import { newestInstant } from "./silence.ts";
import type { CommandResult, CommandRunner } from "./worktree.ts";

const log = createLogger("solve");

/** `@copilot`, GitHub's own review bot; the loop assumes a reviewer that answers without paging a human. */
export const COPILOT_REVIEWER = "@copilot";

/** Cap on the feedback block handed to the model; bounded here so the prompt-assembly caller can't forget. */
export const MAX_FEEDBACK_CHARS = 20_000;

/** The commit identity, passed explicitly per commit so it never inherits the operator's `~/.gitconfig`. */
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
  /** Model-authored; may contain attacker-influenced text from the ticket. */
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

/** Whether feedback came from the requested reviewer or a human; only reviewer feedback counts against `MAX_REVIEW_ITERATIONS`. */
export type ReviewOrigin = "reviewer" | "human";

/**
 * Classifies a login against the requested reviewer.
 *
 * A blank reviewer reads as `reviewer`, not `human` — otherwise an empty
 * setting would exempt every comment from `MAX_REVIEW_ITERATIONS`.
 */
export function reviewOrigin(login: string, reviewer: string): ReviewOrigin {
  if (reviewer.replace(/^@/u, "").trim() === "") {
    return "reviewer";
  }
  return matchesReviewer(login, reviewer) ? "reviewer" : "human";
}

/** Accounts whose comments are not review events at all (e.g. CI deploy notices); kept narrow, since a list wide enough to catch a real reviewer would look like one that never answered. */
const AUTOMATION_AUTHORS: ReadonlySet<string> = new Set(["github-actions"]);

/** Strips a trailing `[bot]` suffix before comparing — the same account is spelled with and without it depending on which API returned it. */
function isAutomation(login: string, reviewer: string): boolean {
  return (
    !matchesReviewer(login, reviewer) && AUTOMATION_AUTHORS.has(login.replace(/\[bot\]$/u, ""))
  );
}

export interface ReviewComment {
  readonly author: string;
  readonly body: string;
  /** Whether the requested reviewer wrote this, or a person did. */
  readonly origin: ReviewOrigin;
  /** ISO date, or `""` when the entry carried no readable date; `isNewer` treats `""` as new. */
  readonly createdAt: string;
  /**
   * The GraphQL node id, or `""` if absent. Only an issue comment can be
   * edited by id — `gh pr comment --edit-last` edits the operator's own last
   * comment instead, which would overwrite a human's words after they commented.
   */
  readonly id: string;
}

export interface ReviewState {
  /**
   * Whether anyone the loop should answer has said anything at all yet.
   *
   * Answers for every commenter, not just the requested reviewer — a human's
   * review counts too. Our own comments are excluded by the `bot: ` prefix
   * rather than a login, since `gh` is authenticated as the operator and no
   * login separates the bot from the human it posts as.
   */
  readonly anyoneResponded: boolean;
  /**
   * Whether the reviewer answered by saying it could not review.
   *
   * A third state between "no response" and "a review": the reviewer app can
   * post an ordinary `COMMENTED` review whose entire body is an error message,
   * which is neither feedback to act on nor an approval to undraft on.
   */
  readonly reviewerErrored: boolean;
  /** Every comment with usable text, from reviews and issue comments alike. */
  readonly comments: readonly ReviewComment[];
  readonly state: string;
  readonly isDraft: boolean;
  /**
   * When the pull request itself was opened.
   *
   * The floor under the silence clock: the one instant guaranteed to exist even
   * on a pull request nobody has reviewed, commented on, or marked.
   */
  readonly createdAt: string;
  /**
   * The newest instant among every entry that counts as an event, including
   * ones `comments` drops (a reviewer's empty approval, its error notice, its
   * green light) — each is still something that happened.
   *
   * Automation authors are excluded even here, since a deploy notice triggered
   * by our own push would let the loop reset its own silence clock. `""` when
   * no entry carried a readable date.
   */
  readonly newestAt: string;
}

export type ReadReviewResult =
  | { readonly outcome: "read"; readonly review: ReviewState }
  | { readonly outcome: "failed"; readonly reason: string };

export interface ThreadComment {
  readonly author: string;
  readonly body: string;
  /** Whether the requested reviewer wrote this, or a person did; classified here so both transports (a thread, a review body) apply the same round-counting rule. */
  readonly origin: ReviewOrigin;
  /** ISO 8601, as GitHub returns it. Not parsed here; ordering is the API's. */
  readonly createdAt: string;
}

/**
 * One inline conversation on the diff — the comments `gh pr view
 * --json reviews,comments` cannot reach, and sometimes the entire substance of
 * a review whose summary body says nothing.
 */
export interface ReviewThread {
  /** The GraphQL node id. What a reply and a resolve are both addressed to. */
  readonly id: string;
  readonly isResolved: boolean;
  /** Whether the diff has moved out from under the thread; not the same as resolved, only a hint about where to look. */
  readonly isOutdated: boolean;
  readonly path: string;
  /** `null` on an outdated thread — GitHub drops the line once the diff moves. */
  readonly line: number | null;
  readonly comments: readonly ThreadComment[];
}

export type ReadThreadsResult =
  | { readonly outcome: "read"; readonly threads: readonly ReviewThread[] }
  | { readonly outcome: "failed"; readonly reason: string };

export interface ThreadReplyRequest {
  /** Where `gh` runs. Any checkout of the repository will do; GraphQL takes the ids. */
  readonly cwd: string;
  readonly threadId: string;
  /** The answer, **unprefixed**; refused when blank. `replyToThread` adds `BOT_PREFIX` itself, so a caller must not add its own. */
  readonly body: string;
  readonly timeoutMs: number;
}

/**
 * Proof that a reply was posted, and the only way to get one — `resolveThread`
 * takes this rather than a thread id, so no code path resolves a thread
 * without having just answered it. That is §6.1c's bound expressed in the
 * type system rather than in a comment asking nicely.
 */
export interface ThreadReply {
  readonly threadId: string;
  /** The posted comment's URL. Empty means nothing was posted, and blocks the resolve. */
  readonly commentUrl: string;
}

export type ReplyToThreadResult =
  | { readonly outcome: "replied"; readonly reply: ThreadReply }
  | { readonly outcome: "failed"; readonly reason: string };

export interface ResolveThreadRequest {
  readonly cwd: string;
  readonly reply: ThreadReply;
  readonly timeoutMs: number;
}

export type ResolveThreadResult =
  | { readonly outcome: "resolved" }
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
 * End-anchored so `…/pull/42/files` and other incidental URLs in the same
 * output (review comments, gh's own hints) can't be read as the PR this run
 * just created.
 */
const PR_URL = /\/pull\/(\d+)\s*$/u;

/** What `git rev-parse HEAD` is allowed to have printed. */
const SHA = /^[0-9a-f]{7,64}$/u;

/** Git's two ways of saying the index held nothing, matched as substrings since exact wording varies with git version and untracked files. */
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
 * Both ends are kept and the middle dropped: a tool that fails on step three
 * of five says which step at the top and prints the stack at the bottom, so
 * truncating from either end alone loses the part that says what to change.
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
 * Checked because the failure mode is quiet: a newline in `user.name` becomes
 * a newline inside the commit object's `author` line, corrupting it in a way
 * that surfaces only in whatever reads the object later.
 */
function usableIdentityPart(value: string): boolean {
  return value.trim() !== "" && !/[\n\r]/u.test(value);
}

/**
 * Stages and commits everything in the worktree.
 *
 * `add -A`, not a path list: the diff gate already inspected and approved the
 * full working tree, so committing a subset would ship something other than
 * what was approved. The message is two `-m` flags rather than a heredoc,
 * since there is no shell to run one in. "Nothing to commit" is its own
 * outcome, not `failed` — a model concluding no code change was needed is
 * legitimate and must not read as a broken index.
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
  // subcommand's; passing identity per-invocation keeps it out of the
  // worktree's persisted config.
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
    // Checked against stdout: git prints "nothing to commit" there while
    // exiting non-zero.
    const output = committed.stdout.toLowerCase();
    if (!committed.timedOut && NOTHING_TO_COMMIT.some((phrase) => output.includes(phrase))) {
      log.info("solve.pr.nothing_to_commit", { worktreePath });
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
    // The sha is quoted in the report and the Jira comment; anything else
    // reaching those places would be indistinguishable from one.
    return {
      outcome: "failed",
      reason: `committed, but rev-parse printed ${JSON.stringify(sha.slice(0, 60))} rather than a sha`,
    };
  }

  log.info("solve.pr.committed", { worktreePath, sha });
  return { outcome: "committed", sha };
}

/**
 * Pushes the branch and sets its upstream.
 *
 * `assertWorkBranch` throws rather than returning `failed`, so a protected
 * push target is never retried and the runner is never reached. No
 * `--force`/`--force-with-lease`: a rejected push means the remote moved,
 * which is always a reason to stop rather than retry.
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

  log.info("solve.pr.pushed", { branch });
  return { outcome: "pushed" };
}

/**
 * Opens the pull request as a draft, always — `markReady` undrafts it only
 * after the review loop finishes, so it can never be merged unreviewed.
 *
 * `assertWorkBranch` and a head-equals-base check both throw rather than
 * return `failed`, per the header. The base is not required to be protected:
 * a stacked PR onto another work branch is legitimate, since nothing here
 * pushes to the base.
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
    // Unreachable while `assertWorkBranch` holds; kept as a hedge against a
    // future edit loosening `isWorkBranch`, like the `BRANCH` backstop in
    // `worktree.ts`.
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

  log.info("solve.pr.created", { repo, branch, number: parsed.number });
  return { outcome: "created", number: parsed.number, url: parsed.url };
}

/**
 * The PR number and URL from gh's stdout, or `null`.
 *
 * Only the last non-empty line is considered — gh prints progress and hints
 * first, some containing URLs of their own. Exported so "given this stdout,
 * which number" can be tested directly.
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
  // A pull request numbers from 1; anything past the safe-integer range has
  // already lost digits, so either means this wasn't the URL this run produced.
  if (!Number.isSafeInteger(number) || number <= 0) {
    return null;
  }
  return { number, url: last };
}

/**
 * Asks the reviewer for a review.
 *
 * Separate from `createDraftPr` because it fails for different reasons (the
 * reviewer app may not be installed, or the token may lack scope) — a PR that
 * exists but couldn't get a reviewer added is recoverable, and folding the two
 * calls together would make that look like a failed PR.
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

  log.info("solve.pr.review_requested", { repo, number, reviewer });
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
  /** `null` when the entry carries no readable date. See `dateOf`. */
  readonly createdAt: string | null;
  /** The GraphQL node id, `""` when absent. Only an issue comment can be edited. */
  readonly id: string;
}

/**
 * When an entry was written: a review uses `submittedAt`, an issue comment
 * uses `createdAt`, and they never co-occur. Reading only one field would date
 * every comment and no review at all, and an undated entry counts as new — the
 * exact runaway the review cursor is bounded against.
 */
function dateOf(record: Record<string, unknown>): string | null {
  const submitted = record["submittedAt"];
  if (typeof submitted === "string" && submitted !== "") {
    return submitted;
  }
  const created = record["createdAt"];
  return typeof created === "string" && created !== "" ? created : null;
}

/**
 * Reviews or comments, normalised.
 *
 *  - absent/null → `[]` (no reviews yet is normal).
 *  - present but not an array → `null`, which the caller turns into `failed`
 *    rather than reading an unrecognised shape as "no reviews".
 *  - a non-object element → skipped, so one bad entry doesn't discard the rest.
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
    const id = record["id"];
    entries.push({
      login: typeof login === "string" ? login : "",
      body: typeof body === "string" ? body : null,
      createdAt: dateOf(record),
      id: typeof id === "string" ? id : "",
    });
  }
  return entries;
}

/**
 * Whether a login belongs to the reviewer we asked for.
 *
 * A prefix match after stripping a leading `@`, since GitHub app logins
 * (`copilot-pull-request-reviewer[bot]` vs. `@copilot`) acquire suffixes
 * without notice. The empty-reviewer guard is load-bearing: `"".startsWith("")`
 * is true, so an empty reviewer would otherwise match every login.
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
  /** One pull request, and its state — carried rather than reduced to a boolean, since `OPEN`/`MERGED`/`CLOSED` each mean a different next move. */
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
 * The branch is derived from the ticket (`branchNameFor`), so it can be
 * recomputed without any stored state, which is what makes a review round
 * resumable. `--state all`: a merged PR must read as "found", not "none", at
 * exactly the moment the loop is supposed to stop. Two or more *open* PRs on
 * one branch is refused rather than guessed at, since picking one would happen
 * right before pushing a commit to it; multiple terminal PRs are fine to
 * collapse, since "this branch reached `main`" is true regardless of which one
 * carried it.
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
      // One unreadable row is not "no pull requests" — dropping it silently is
      // how a merged PR becomes an absence.
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
 * Parsed defensively: anything unexpected is a `failed` outcome, never a
 * throw, since this runs on a polling tick and a crash here would take down
 * the cycle over a PR a human could just look at. `reviews`/`comments` may be
 * missing (read as empty); `state`/`isDraft` may not, since a default there
 * would be a guess made immediately before `gh pr ready`.
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
      // Each entry in `reviews`/`comments` carries its own `id` and either
      // `submittedAt` or `createdAt`; the `createdAt` requested here is the
      // pull request's own — see `ReviewState.createdAt`.
      "reviews,comments,state,isDraft,createdAt",
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

  // Refused rather than defaulted: a default of `""` would disable the
  // silence bound on exactly the pull requests it exists for — ones with
  // nothing else dated on them.
  const createdAt = root["createdAt"];
  if (typeof createdAt !== "string") {
    return {
      outcome: "failed",
      reason:
        "the payload is missing the pull request's createdAt, so there is no floor under the silence clock and a quiet pull request could not be told from a new one",
    };
  }

  // Dropped here, before anything is derived, so all three fields below agree:
  // left in `comments` alone it would still count as a response; left in
  // `newestAt` it would let our own push reset the silence clock.
  const entries = [...reviews, ...comments].filter((entry) => !isAutomation(entry.login, reviewer));
  const fromReviewer = entries.filter((entry) => matchesReviewer(entry.login, reviewer));
  return {
    outcome: "read",
    review: {
      // Checked on the raw entries, not the filtered `comments` below: an
      // approving review or a green light has an empty/boilerplate body and is
      // still a response. Reading the filtered list here would make a finished
      // pull request look silent and stall the undraft on it.
      anyoneResponded: entries.some((entry) => !isOurs(entry.body ?? "")),
      reviewerErrored: fromReviewer.some((entry) => isReviewerError(entry.body)),
      // Whitespace-only bodies, the reviewer's error notice, and its green
      // light are dropped here — real content for "has it spoken", nothing to
      // act on for "what should change" — scoped to the reviewer only, so a
      // human quoting the same words isn't silently edited.
      comments: entries.flatMap((entry) => {
        // Chrome comes off before the blank check, so an all-boilerplate
        // review drops out entirely instead of reaching the pass empty.
        const body =
          entry.body !== null && matchesReviewer(entry.login, reviewer)
            ? stripReviewerChrome(entry.body)
            : entry.body;
        return body === null ||
          body.trim() === "" ||
          (matchesReviewer(entry.login, reviewer) && (isReviewerError(body) || isGreenLight(body)))
          ? []
          : [
              {
                author: entry.login === "" ? "unknown" : entry.login,
                body,
                origin: reviewOrigin(entry.login, reviewer),
                createdAt: entry.createdAt ?? "",
                id: entry.id,
              },
            ];
      }),
      state,
      isDraft,
      createdAt,
      // Every entry counted before the filtering above, so an approval or
      // automation notice still (or never) moves the clock; see `ReviewState.newestAt`.
      newestAt: newestInstant(entries.map((entry) => entry.createdAt ?? "")) ?? "",
    },
  };
}

/**
 * Phrases the reviewer app uses to say it could not review — matched as an
 * ordinary review body, since that's the only channel it has to say so. Both
 * fragments are required together, so a review *about* an error doesn't match.
 */
const REVIEWER_ERROR = [/encountered an error/iu, /unable to review/iu];

/** Whether a review body is the reviewer saying it failed rather than a review. */
function isReviewerError(body: string | null): boolean {
  return body !== null && REVIEWER_ERROR.every((phrase) => phrase.test(body));
}

/**
 * The reviewer's verdict line when it has nothing to ask for — one of three
 * headings it opens every review with; the green one means approval and
 * should not cost a full round just to be acknowledged.
 */
const REVIEWER_GREEN_LIGHT = [/\u{1F7E2}/u, /approval recommended/iu];

/**
 * Whether the reviewer's body is a green light and nothing else.
 *
 * Only the verdict (first non-blank) line is examined, not the whole body —
 * a review quoting the green heading while its real verdict is something else
 * must not be dropped. Inline comments carrying an objection are threads, read
 * separately, so a summary approval alongside an open thread still counts as
 * a round.
 */
function isGreenLight(body: string | null): boolean {
  if (body === null) {
    return false;
  }
  const verdict = body.split("\n").find((line) => line.trim() !== "") ?? "";
  return REVIEWER_GREEN_LIGHT.every((phrase) => phrase.test(verdict));
}

/**
 * A link only the reviewer's own promotional footer puts in a review body.
 *
 * Two conditions required together, as with `REVIEWER_ERROR`: a trailing rule
 * alone is too common, and a 💡 alone is something a real reviewer might write.
 */
const REVIEWER_PROMO = /docs\.github\.com\/copilot/u;

/**
 * Drops a trailing boilerplate block from a reviewer's body — scoped to the
 * reviewer's own entries, so a human quoting the footer isn't edited.
 * Fails open: if the vendor reformats the block, it stops matching and
 * reappears in the pull request instead of silently swallowing real feedback.
 */
function stripReviewerChrome(body: string): string {
  const rule = body.lastIndexOf("\n---");
  return rule !== -1 && REVIEWER_PROMO.test(body.slice(rule))
    ? body.slice(0, rule).trimEnd()
    : body;
}

/** How many threads, and comments per thread, one read asks for; the GraphQL connection max, refused rather than paged past. */
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

function parseThreadComments(value: unknown, reviewer: string): readonly ThreadComment[] | null {
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
    // A deleted account comes back as a null author; it classifies as
    // `human`, the safe direction, since an unnamed login is never the
    // reviewer.
    const author = typeof login === "string" ? login : "unknown";
    comments.push({ author, body, origin: reviewOrigin(author, reviewer), createdAt });
  }
  return comments;
}

/**
 * Reads the inline review threads on a pull request.
 *
 * A separate transport (`gh api graphql`) because `gh pr view --json` has no
 * flag for a thread's node id or resolved state. Nothing here degrades to an
 * empty list on a malformed shape — unlike `entriesOf`, since a dropped thread
 * is a comment the loop doesn't answer while believing it answered everything,
 * then resolves what it did see and tells a human the review was addressed.
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
      // `-f` is the raw form; `-F` (typed) would read a value starting with
      // `@` out of a file.
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

  // GraphQL can answer a partly-failed query with data *and* errors, and gh
  // has been known to exit 0 on it.
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
    const comments = parseThreadComments(record["comments"], request.reviewer ?? COPILOT_REVIEWER);
    if (comments === null) {
      return { outcome: "failed", reason: `a comment on the thread on ${path} could not be read` };
    }
    threads.push({ id, isResolved, isOutdated, path, line, comments });
  }

  const open = threads.filter((thread) => !thread.isResolved).length;
  log.info(
    "solve.pr.threads_read",
    { repo, number, threads: threads.length, open },
    // `open`, not `threads.length`: keying on the total would mark a pull
    // request with only resolved threads as news forever.
    { quiet: open === 0 },
  );
  return { outcome: "read", threads };
}

const REPLY_MUTATION = `mutation($threadId:ID!,$body:String!){
  addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){
    comment{ url }
  }
}`;

const RESOLVE_MUTATION = `mutation($threadId:ID!){
  resolveReviewThread(input:{threadId:$threadId}){ thread{ isResolved } }
}`;

/**
 * Runs a GraphQL operation and hands back its parsed payload, or a reason.
 *
 * `numbers` is separate from `fields` because only `-F` is safe for a value
 * this service did not write: it also reads a value starting with `@` out of
 * a file, so a model-authored reply body must go through `-f` instead.
 */
async function mutate(
  runner: CommandRunner,
  what: string,
  query: string,
  fields: readonly (readonly [string, string])[],
  opts: {
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly numbers?: readonly (readonly [string, number])[];
  },
): Promise<{ readonly data: unknown } | { readonly reason: string }> {
  const argv = ["gh", "api", "graphql"];
  for (const [key, value] of fields) {
    argv.push("-f", `${key}=${value}`);
  }
  for (const [key, value] of opts.numbers ?? []) {
    argv.push("-F", `${key}=${String(value)}`);
  }
  argv.push("-f", `query=${query}`);

  const ran = await runner.run(argv, opts);
  if (failed(ran)) {
    return { reason: `gh could not ${what} (${why(ran)})` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(ran.stdout);
  } catch {
    return { reason: `gh printed something that is not JSON when asked to ${what}` };
  }
  if (dig(parsed, "errors") !== undefined) {
    return { reason: `GraphQL refused to ${what} (${bothEnds(ran.stdout)})` };
  }
  return { data: parsed };
}

/**
 * Answers one inline review thread, in public — so the reviewer sees it on
 * the next pass and a human sees it without going looking, especially for a
 * comment the round declines rather than acts on.
 *
 * The prefix (`BOT_PREFIX`) is applied here rather than at the caller, since
 * `isOurs`/`unansweredThreads` key on it and there is no login to key on
 * instead; a body already starting with it is prefixed again regardless,
 * since a branch to avoid that would be purely cosmetic. The blank check runs
 * before prefixing, since prefixing first would let a whitespace-only reply
 * slip past it.
 */
export async function replyToThread(
  runner: CommandRunner,
  request: ThreadReplyRequest,
): Promise<ReplyToThreadResult> {
  const { cwd, threadId, body, timeoutMs } = request;

  if (threadId === "") {
    return { outcome: "failed", reason: "a reply needs a thread to be addressed to" };
  }
  if (body.trim() === "") {
    return { outcome: "failed", reason: "a blank reply says nothing and resolves nothing" };
  }

  const result = await mutate(
    runner,
    `reply to thread ${threadId}`,
    REPLY_MUTATION,
    [
      ["threadId", threadId],
      ["body", `${BOT_PREFIX}${body}`],
    ],
    { cwd, timeoutMs },
  );
  if ("reason" in result) {
    return { outcome: "failed", reason: result.reason };
  }

  const url = dig(result.data, "data", "addPullRequestReviewThreadReply", "comment", "url");
  // No URL, no receipt, and therefore no resolve. GitHub accepting the mutation
  // without saying where the comment landed is not a posted reply.
  if (typeof url !== "string" || url === "") {
    return {
      outcome: "failed",
      reason: `the reply to thread ${threadId} came back without a comment URL, so nothing proves it posted`,
    };
  }

  log.info("solve.pr.thread_replied", { threadId, url });
  return { outcome: "replied", reply: { threadId, commentUrl: url } };
}

/**
 * Marks a thread resolved, and only one that has just been answered.
 *
 * Takes the receipt `replyToThread` returns instead of a thread id, so the
 * argument for closing the thread is already public by the time this runs; a
 * hand-built `ThreadReply` with an empty URL is refused at runtime too, not
 * only by the type.
 *
 * What this cannot enforce is the other half of §6.1c — resolve only when the
 * round changed code for the thread or cited something checkable against it,
 * and send anything resting on judgement alone to `unresolved`. That is a
 * judgement about the argument, so it lives in the instructions; this enforces
 * only that the argument was made at all.
 */
export async function resolveThread(
  runner: CommandRunner,
  request: ResolveThreadRequest,
): Promise<ResolveThreadResult> {
  const { cwd, reply, timeoutMs } = request;

  if (reply.threadId === "" || reply.commentUrl === "") {
    return {
      outcome: "failed",
      reason:
        "a thread is resolved only with an answer attached, and this receipt does not carry one",
    };
  }

  const result = await mutate(
    runner,
    `resolve thread ${reply.threadId}`,
    RESOLVE_MUTATION,
    [["threadId", reply.threadId]],
    { cwd, timeoutMs },
  );
  if ("reason" in result) {
    return { outcome: "failed", reason: result.reason };
  }

  // Read back rather than trust the exit code, as the claim does. A mutation
  // that returns a thread still open has not resolved it, and reporting it
  // resolved is how the reviewer's queue and this loop's idea of it diverge.
  if (dig(result.data, "data", "resolveReviewThread", "thread", "isResolved") !== true) {
    return {
      outcome: "failed",
      reason: `thread ${reply.threadId} is still open after the resolve was accepted`,
    };
  }

  log.info("solve.pr.thread_resolved", { threadId: reply.threadId, reply: reply.commentUrl });
  return { outcome: "resolved" };
}

export interface PostCommentRequest {
  readonly cwd: string;
  readonly repo: string;
  readonly number: number;
  readonly body: string;
  readonly timeoutMs: number;
}

export interface EditCommentRequest {
  readonly cwd: string;
  /** The node id of the comment to rewrite. Never "the last one". */
  readonly commentId: string;
  readonly body: string;
  readonly timeoutMs: number;
}

export type WriteCommentResult =
  | { readonly outcome: "written"; readonly commentId: string }
  | { readonly outcome: "failed"; readonly reason: string };

const POST_COMMENT = `mutation($subjectId:ID!,$body:String!){
  addComment(input:{subjectId:$subjectId,body:$body}){ commentEdge{ node{ id } } }
}`;

const EDIT_COMMENT = `mutation($id:ID!,$body:String!){
  updateIssueComment(input:{id:$id,body:$body}){ issueComment{ id } }
}`;

const PR_NODE_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){ id } }
}`;

/**
 * Posts the marker comment, once, on a pull request that has none.
 *
 * Through `addComment` rather than `gh pr comment`, since the node id of what
 * was created is the whole point — without it the next round can't find the
 * comment again and posts a second one.
 *
 * This one does not stamp `BOT_PREFIX` itself, unlike `replyToThread` — both
 * callers already send a marked body, so stamping here would double it into
 * `bot: bot: `, breaking `isMarker`/`findMarker` and resetting the count every
 * round.
 */
export async function postComment(
  runner: CommandRunner,
  request: PostCommentRequest,
): Promise<WriteCommentResult> {
  const { cwd, repo, number, body, timeoutMs } = request;
  if (body.trim() === "") {
    return { outcome: "failed", reason: "refusing to post an empty comment" };
  }
  const parts = OWNER_NAME.exec(repo);
  if (parts === null) {
    return { outcome: "failed", reason: `"${repo}" is not an owner/name repository` };
  }

  const subject = await mutate(
    runner,
    `read the node id of #${String(number)}`,
    PR_NODE_QUERY,
    [
      ["owner", parts[1] ?? ""],
      ["name", parts[2] ?? ""],
    ],
    { cwd, timeoutMs, numbers: [["number", number]] },
  );
  if ("reason" in subject) {
    return { outcome: "failed", reason: subject.reason };
  }
  const subjectId = dig(subject.data, "data", "repository", "pullRequest", "id");
  if (typeof subjectId !== "string" || subjectId === "") {
    return { outcome: "failed", reason: `#${String(number)} came back without a node id` };
  }

  const posted = await mutate(
    runner,
    `comment on #${String(number)}`,
    POST_COMMENT,
    [
      ["subjectId", subjectId],
      ["body", body],
    ],
    { cwd, timeoutMs },
  );
  if ("reason" in posted) {
    return { outcome: "failed", reason: posted.reason };
  }

  const id = dig(posted.data, "data", "addComment", "commentEdge", "node", "id");
  // Same rule as a thread reply: a mutation that will not say where the comment
  // landed has not given a usable receipt, and here the receipt is what every
  // later round edits. Without it the marker is write-once.
  if (typeof id !== "string" || id === "") {
    return {
      outcome: "failed",
      reason: `the comment on #${String(number)} came back without a node id, so no later round could edit it`,
    };
  }

  log.info("solve.pr.commented", { repo, number, commentId: id });
  return { outcome: "written", commentId: id };
}

/**
 * Rewrites one comment, named by its node id.
 *
 * Not `gh pr comment --edit-last`: that flag edits the last comment of the
 * *current user*, which is the operator this service is authenticated as, so
 * a round running after a human commented would overwrite their words.
 */
export async function editComment(
  runner: CommandRunner,
  request: EditCommentRequest,
): Promise<WriteCommentResult> {
  const { cwd, commentId, body, timeoutMs } = request;
  if (commentId === "") {
    return { outcome: "failed", reason: "refusing to edit a comment with no id" };
  }
  if (body.trim() === "") {
    return { outcome: "failed", reason: "refusing to blank a comment" };
  }

  const edited = await mutate(
    runner,
    `edit comment ${commentId}`,
    EDIT_COMMENT,
    [
      ["id", commentId],
      ["body", body],
    ],
    { cwd, timeoutMs },
  );
  if ("reason" in edited) {
    return { outcome: "failed", reason: edited.reason };
  }

  const id = dig(edited.data, "data", "updateIssueComment", "issueComment", "id");
  if (typeof id !== "string" || id === "") {
    return {
      outcome: "failed",
      reason: `the edit of comment ${commentId} was accepted but came back empty, so nothing proves it took`,
    };
  }

  log.info("solve.pr.comment_edited", { commentId: id });
  return { outcome: "written", commentId: id };
}

/**
 * Takes the PR out of draft — the last thing the pipeline does, and the only
 * irreversible-feeling one, since an undrafted PR notifies reviewers and
 * becomes mergeable.
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

  log.info("solve.pr.ready", { repo, number });
  return { outcome: "ready" };
}

/** Appended when the block is cut. Its own length is subtracted from the budget. */
const TRUNCATION_NOTE = `\n\n[Feedback truncated at ${String(MAX_FEEDBACK_CHARS)} characters. Read the pull request for the rest.]`;

/**
 * Renders review comments as a plain-text block for the next model pass.
 *
 * Plain text, not JSON or markdown, since either structured format would
 * invite the reader to trust structure that untrusted comment bodies can
 * forge; the `---` delimiters are a debugging aid only. The count is in the
 * header so a truncated block still says how much of the total it holds.
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

  return capped(block);
}

/** The shared budget. The note is inside it, not added to it. */
function capped(block: string): string {
  if (block.length <= MAX_FEEDBACK_CHARS) {
    return block;
  }
  return `${block.slice(0, MAX_FEEDBACK_CHARS - TRUNCATION_NOTE.length)}${TRUNCATION_NOTE}`;
}

/**
 * Renders inline review threads for the next model pass, ids and all.
 *
 * A thread is prose to act on **and** an address to answer at, so every
 * entry's id is in its header and the schema tells the pass to copy it back
 * verbatim. Every comment on the thread is rendered, including this
 * service's own previous replies, so a pass can see a point was already
 * answered and decline to argue it again instead of being told to.
 */
export function formatThreads(threads: readonly ReviewThread[]): string {
  if (threads.length === 0) {
    return "No inline review threads.";
  }

  const rendered = threads
    .map((thread, index) => {
      // An outdated thread has no line: GitHub drops it once the diff moves.
      // Saying so beats printing `null`, which reads as a bug in this code.
      const where =
        thread.line === null
          ? `${thread.path} (the diff has moved; no line)`
          : `${thread.path}:${String(thread.line)}`;
      const conversation = thread.comments
        .map((comment) => `${comment.author} wrote:\n${comment.body.trim()}`)
        .join("\n\n");
      return `--- thread ${String(index + 1)} of ${String(threads.length)} · id ${thread.id} · ${where} ---\n${conversation}`;
    })
    .join("\n\n");

  return capped(
    `Inline review threads (${String(threads.length)}). Answer every one in threadAnswers, copying each id exactly:\n\n${rendered}`,
  );
}
