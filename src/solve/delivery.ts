/**
 * The second half of the pipeline: takes a verified worktree from
 * `orchestrator.ts` through commit, push, draft PR and review rounds
 * (`publish`, then repeated `advance`) to a pull request ready for a human.
 *
 * `advance` looks once and returns rather than polling — the caller decides
 * when to look again. Nothing here merges; a human merges, always.
 */

import { randomBytes } from "node:crypto";

import { createLogger } from "../logger.ts";
import { oneLine, shorten } from "../text.ts";
import {
  type BotIdentity,
  type ReviewComment,
  type ReviewState,
  type ReviewThread,
  type WriteCommentResult,
  COPILOT_REVIEWER,
  commitAll,
  createDraftPr,
  editComment,
  formatReviewFeedback,
  formatThreads,
  memberSources,
  markReady,
  postComment,
  push,
  readReview,
  readReviewThreads,
  replyToThread,
  requestReview,
  resolveThread,
  silenceable,
} from "./pr.ts";
import {
  type Marker,
  NEVER_READ,
  BOT_PREFIX,
  findMarker,
  isNewer,
  isOurs,
  parseMarker,
  renderMarker,
} from "./marker.ts";
import type { SyncedAttachResult } from "./base-sync.ts";
import {
  type RepairVerdict,
  type DroppedEdit,
  type ReviewRepair,
  type ReviewRoundOutcome,
  type ReviewRoundRequest,
  type SolveDependencies,
  resolveConflict,
  resolveReview,
} from "./orchestrator.ts";
import { type ReviewRepairRecord, recordReviewRepairRound } from "./repair-ledger.ts";
import type { CommitMessage, ReviewReport, SilentComment, ThreadAnswer } from "./runner.ts";
import { quietFor } from "./silence.ts";
import type { Worktree } from "./worktree.ts";

const log = createLogger("solve");

export interface PublishRequest {
  readonly worktree: Worktree;
  /** `owner/name`. Configuration; `gh` is never left to infer it. */
  readonly repo: string;
  /** The branch the pull request targets, e.g. `main`. */
  readonly baseBranch: string;
  readonly commit: CommitMessage;
  /** Pull request title and body. Model-authored; see `pr.ts`. */
  readonly title: string;
  readonly body: string;
  readonly identity: BotIdentity;
  readonly reviewer?: string;
  readonly timeoutMs: number;
}

export type PublishOutcome =
  | { readonly kind: "published"; readonly number: number; readonly url: string }
  /**
   * The pull request exists; only the reviewer request failed. Separated from
   * `failed` so an ordinary retry cannot open a second pull request. Recovery
   * is `gh pr edit --add-reviewer`, not a re-run.
   */
  | {
      readonly kind: "published-unreviewed";
      readonly number: number;
      readonly url: string;
      readonly reason: string;
    }
  /** The verified worktree turned out to hold no change. Nothing was pushed. */
  | { readonly kind: "nothing-to-commit" }
  | {
      readonly kind: "failed";
      readonly stage: "commit" | "push" | "pull-request";
      readonly reason: string;
    };

/**
 * Commits, pushes, opens the draft and asks for the review.
 *
 * Strictly ordered and each step gated on the one before: no point making a
 * branch public that could not be committed.
 */
export async function publish(
  deps: SolveDependencies,
  request: PublishRequest,
): Promise<PublishOutcome> {
  const { commands } = deps;
  const { worktree, repo, timeoutMs } = request;

  const committed = await commitAll(commands, {
    worktreePath: worktree.path,
    subject: request.commit.subject,
    body: request.commit.body,
    identity: request.identity,
    timeoutMs,
  });
  if (committed.outcome === "nothing-to-commit") {
    return { kind: "nothing-to-commit" };
  }
  if (committed.outcome === "failed") {
    return { kind: "failed", stage: "commit", reason: committed.reason };
  }

  // `push` refuses a protected branch by throwing rather than returning
  // `failed` — "pushed to main" must not be reachable via an ordinary retry.
  const pushed = await push(commands, {
    worktreePath: worktree.path,
    branch: worktree.branch,
    timeoutMs,
  });
  if (pushed.outcome === "failed") {
    return { kind: "failed", stage: "push", reason: pushed.reason };
  }

  const created = await createDraftPr(commands, {
    worktreePath: worktree.path,
    repo,
    baseBranch: request.baseBranch,
    branch: worktree.branch,
    title: request.title,
    body: request.body,
    timeoutMs,
  });
  if (created.outcome === "failed") {
    return { kind: "failed", stage: "pull-request", reason: created.reason };
  }
  const { number, url } = created;
  log.info("solve.pr.created", { issueKey: worktree.issueKey, number, url });

  const requested = await requestReview(commands, {
    worktreePath: worktree.path,
    repo,
    number,
    ...(request.reviewer === undefined ? {} : { reviewer: request.reviewer }),
    timeoutMs,
  });
  if (requested.outcome === "failed") {
    log.warn("solve.pr.reviewer_not_requested", { number, reason: requested.reason });
    return { kind: "published-unreviewed", number, url, reason: requested.reason };
  }

  return { kind: "published", number, url };
}

/**
 * Cuts the checkout a round needs; called only when a round will run, so a survey
 * that decides `waiting` never pays for a `worktree add`.
 * `advance` never removes the worktree it gets back — ownership stays with the caller.
 */
export type WorktreeSource = () => Promise<SyncedAttachResult>;

/**
 * Everything needed to look at a pull request, and nothing needed to act on
 * one — a caller polling many pull requests can build one of these per PR
 * without a worktree, an identity or a git timeout.
 */
export interface SurveyRequest {
  readonly repo: string;
  readonly number: number;
  /** The ticket this pull request belongs to. Logging only; nothing reads it back. */
  readonly issueKey: string;
  /** Every `gh` call names its repository explicitly, so this is a plain working directory. */
  readonly cwd: string;
  /**
   * Injected so the silence boundary can be tested without faking a clock. See `silence.ts`
   * for the threshold, which is deliberately not here.
   */
  readonly now?: number;
  /**
   * The reviewer's argument budget, `MAX_REVIEW_ITERATIONS`. Rounds already spent are read
   * off the marker comment rather than passed in, so a caller cannot supply a wrong count.
   */
  readonly maxRounds: number;
  /**
   * The absolute stop, `MAX_PR_ROUNDS_TOTAL` — a brake on the machinery, not `maxRounds`
   * under a second name.
   */
  readonly maxTotalRounds: number;
  /**
   * `MAX_FAILED_STARTS`: how many ticks in a row may decide on a round and never reach one.
   * Bounds attempts, not rounds — `maxRounds`/`maxTotalRounds` count only rounds that reserved.
   */
  readonly maxFailedStarts: number;
  readonly ghTimeoutMs: number;
}

export interface AdvanceRequest
  extends
    SurveyRequest,
    Omit<
      ReviewRoundRequest,
      "reviewFeedback" | "worktree" | "memberToken" | "members" | "silenceable"
    > {
  readonly identity: BotIdentity;
  readonly reviewer?: string;
  /** See `WorktreeSource`. Not called on a look that finds nothing to do. */
  readonly attach: WorktreeSource;
  /** Where a review round's repair verdict is recorded (`repair-rounds.md`); absent writes nothing. */
  readonly repairLedger?: string;
}

/** What happened to the "please look again" ping at the end of a round. */
export type ReRequest =
  /** The reviewer was pinged and will look again. */
  | "asked"
  /** The ping did not go out. Recoverable, by a human clicking one button. */
  | "failed"
  /** Nothing was pushed, so no ping was sent — avoids the reviewer instability §6.1c describes. */
  | "unnecessary";

/**
 * What happened to the round's answer to feedback that has no thread (a review body, not
 * an inline comment) — without this, that argument reached only `responses`, never the
 * reviewer, since §6.1c's "push back in public" had been built for threads only.
 */
export type Spoken =
  /** The round's answer is on the pull request. */
  | { readonly outcome: "posted" }
  /** All the feedback was inline, so the thread replies already carry it. */
  | { readonly outcome: "nothing-to-say" }
  /** The comment did not post. The argument exists nowhere a reviewer can see. */
  | { readonly outcome: "failed"; readonly reason: string };

/**
 * Whether the round took the pull request out of draft, and why not if not.
 *
 * Draft means this side is still working: a round that pushed a commit stays
 * a draft since the reviewer has something new to read, and a round that
 * changed nothing hands the pull request to a human by undrafting it.
 */
export type Undraft = "undrafted" | "failed" | "still-drafting";

export type AdvanceOutcome =
  /** The reviewer has not said anything yet. Look again later; nothing ran. */
  | {
      readonly kind: "waiting";
      /**
       * Milliseconds since the last dated thing on the pull request, or `null`
       * when nothing on it carries a date (not zero, not forever). Measured
       * from the pull request rather than a counter on the caller's stack, so
       * it survives a restart. See `silence.ts`.
       */
      readonly quietMs: number | null;
    }
  /** The reviewer responded with nothing to act on. Undrafted. */
  | { readonly kind: "ready"; readonly rounds: number }
  /**
   * Nothing new to answer, but round `round` never landed, so the pull request stays in draft.
   * Whoever asked was told when it failed; a new comment starts the next round.
   */
  | { readonly kind: "unlanded"; readonly round: number }
  /** A round of feedback was resolved and pushed. */
  | {
      readonly kind: "iterated";
      readonly round: number;
      readonly responses: readonly string[];
      readonly reviewerRequested: ReRequest;
      /**
       * Not implied by `iterated`: a round that answered the review without touching code
       * also reaches this outcome with `pushed: false`.
       */
      readonly pushed: boolean;
      /** Where the answer to non-thread feedback went. See `Spoken`. */
      readonly spoken: Spoken;
      /** Whether the round left the pull request in draft. See `Undraft`. */
      readonly undrafted: Undraft;
      /** What was posted on the inline threads; separate from `responses`, which never reaches the reviewer. */
      readonly threads: ThreadOutcome;
      /** What the round could not settle, carried even on success so a human can see the open argument. */
      readonly unresolved: string;
      /** Present when a promoted repair finished the round: the failure it fixed, and whether the notice naming it was posted. */
      readonly repaired?: { readonly failure: string; readonly notice: Spoken };
      /** Present when the gate refused some of the round's edits and the rest landed: which, and whether the notice naming them was posted. */
      readonly dropped?: { readonly paths: readonly string[]; readonly notice: Spoken };
    }
  /**
   * The **reviewer's** budget is spent. Undrafted anyway; a person can still comment
   * afterwards, which runs a normal round since `MAX_REVIEW_ITERATIONS` does not count it.
   */
  | {
      readonly kind: "reviewer-exhausted";
      readonly rounds: number;
      readonly unresolved: string;
    }
  /**
   * `MAX_PR_ROUNDS_TOTAL` reached. Not undrafted, unlike `reviewer-exhausted`: this is the
   * machinery hitting a stop, which says nothing about whether the code is ready.
   */
  | { readonly kind: "capped"; readonly rounds: number; readonly unresolved: string }
  /**
   * `MAX_FAILED_STARTS` reached: N ticks running have decided on a round and failed to reach
   * one. `reason` is the last recorded failure rather than all N.
   */
  | { readonly kind: "stalled"; readonly attempts: number; readonly reason: string }
  /**
   * The round spent itself bringing the branch up to date with its base and answered nobody.
   * The reviewer's comments are deliberately left unread so the next tick comes straight
   * back to them — a branch that will not take its base cannot be verified.
   * `conflicts` is empty when the merge went in clean.
   */
  | {
      readonly kind: "synced";
      readonly round: number;
      readonly behind: number;
      readonly conflicts: readonly string[];
    }
  /** The resolution pass declined. A human takes the pull request from here. */
  | {
      readonly kind: "abandoned";
      readonly reason: string;
      /** Whether the reason reached the comments that asked. */
      readonly told?: Spoken;
    }
  /**
   * `write-escape`: a checkout outside the worktree changed while the round ran, so nothing is pushed.
   * `widening`: the round declared a change beyond the ticket that no member's comment or reviewed file covers.
   */
  | {
      readonly kind: "refused";
      readonly stage: "diff-gate" | "verification" | "write-escape" | "widening";
      readonly reasons: readonly string[];
      readonly told?: Spoken;
    }
  | {
      /** `cursor`: a marker that will not parse, or a reservation that would not write. */
      readonly kind: "failed";
      readonly stage:
        | "read"
        | "cursor"
        /** The survey found a round to run and the checkout could not be cut. */
        | "worktree"
        /** The base would not merge; separate from `verification`, which is a fact about the code. */
        | "merge"
        | "verification"
        | "commit"
        | "push"
        | "undraft";
      readonly reason: string;
      /** A `verification` failure's repair round, when one ran; absent means none did. */
      readonly repairOutcome?: RepairVerdict;
      /** Set only on a `verification` failure, the one stage a pass's work reaches. */
      readonly told?: Spoken;
    };

/**
 * Comments the resolution pass should be given: our own dropped, so a pass never argues
 * with its own previous answers.
 * Matched on the `bot: ` prefix, not on author — `gh` posts as the operator, so a comment
 * this service wrote is indistinguishable by author from that human's own review.
 */
export function reviewerComments(review: ReviewState): readonly ReviewComment[] {
  return review.comments.filter((comment) => !isOurs(comment.body));
}

/**
 * Falls back to the mark already recorded, so a batch that comes back all undated cannot
 * move the high-water mark backwards to the epoch and re-open everything before it.
 */
export function newestOf(comments: readonly ReviewComment[], fallback: string): string {
  let newest = fallback;
  for (const comment of comments) {
    if (comment.createdAt !== "" && isNewer(comment.createdAt, newest)) {
      newest = comment.createdAt;
    }
  }
  return newest;
}

interface ReserveRequest {
  readonly worktreePath: string;
  readonly repo: string;
  readonly number: number;
  readonly timeoutMs: number;
  readonly marker: Marker;
  /** Absent on the first round of a pull request, which posts rather than edits. */
  readonly commentId?: string;
}

/** Writes the marker: an edit when there is one to edit, a post when there is not. */
async function reserve(
  runner: SolveDependencies["commands"],
  request: ReserveRequest,
): Promise<WriteCommentResult> {
  const body = renderMarker(request.marker);
  const shared = { cwd: request.worktreePath, body, timeoutMs: request.timeoutMs };
  return request.commentId === undefined
    ? postComment(runner, { ...shared, repo: request.repo, number: request.number })
    : editComment(runner, { ...shared, commentId: request.commentId });
}

interface LandingRequest extends Omit<ReserveRequest, "commentId"> {
  readonly issueKey: string;
  /** What the reservation wrote, plus the round's silences; re-rendered whole, so a landing can never move any other field. */
  readonly marker: Marker;
  /** The reservation's own result, which carries the id even when the reservation posted the marker. */
  readonly reserved: Extract<WriteCommentResult, { outcome: "written" }>;
}

/**
 * Records that the reserved round landed — the only write that lets a later survey undraft.
 * A failed write is logged, not returned: the round's work is public, and the cost is a draft held until the next comment.
 */
async function recordLanded(
  runner: SolveDependencies["commands"],
  request: LandingRequest,
): Promise<void> {
  const { issueKey, marker, reserved, ...target } = request;
  const written = await reserve(runner, {
    ...target,
    marker: { ...marker, landed: marker.count },
    commentId: reserved.commentId,
  });
  if (written.outcome === "failed") {
    log.warn("solve.review.landing_unrecorded", {
      issueKey,
      number: request.number,
      round: marker.count,
      reason: written.reason,
      note: "the round's work is on the pull request; it stays in draft until a new comment starts a round",
    });
  }
}

/** A round that did not land still records why it left comments unanswered; a failed write is logged, since the outcome stands either way. */
async function recordSilences(
  runner: SolveDependencies["commands"],
  request: LandingRequest,
): Promise<void> {
  const { issueKey, marker, reserved, ...target } = request;
  const written = await reserve(runner, { ...target, marker, commentId: reserved.commentId });
  if (written.outcome === "failed") {
    log.warn("solve.review.silence_unrecorded", {
      issueKey,
      number: request.number,
      round: marker.count,
      reason: written.reason,
      note: "the comments this round left unanswered have no reason on the pull request",
    });
  }
}

/** Enough of the pass's reason to read in the marker's list. */
const SILENCE_REASON_CHARS = 160;

/** One marker line per comment left unanswered, `@` broken like any text the pass wrote; an edit, so it notifies nobody. */
function silenceLines(
  round: number,
  silent: readonly SilentComment[],
  comments: readonly ReviewComment[],
): readonly string[] {
  return silent.map(({ comment, reason }) => {
    const author = comments[Number(comment.slice("comment ".length)) - 1]?.author ?? "unknown";
    return `round ${String(round)} — no reply to ${comment} by ${author}: ${unmentioned(shorten(oneLine(reason), SILENCE_REASON_CHARS))}`;
  });
}

/**
 * Excludes resolved threads and threads whose last comment is ours — keyed on who spoke
 * last rather than a timestamp, so a reviewer re-raising a settled point is seen and a
 * reply that failed to post is retried next round.
 */
export function unansweredThreads(threads: readonly ReviewThread[]): readonly ReviewThread[] {
  return threads.filter((thread) => {
    if (thread.isResolved) {
      return false;
    }
    const last = thread.comments.at(-1);
    return last === undefined || !isOurs(last.body);
  });
}

/**
 * The location and the first comment, not the whole conversation — this ends up in a
 * Jira comment, and what a human needs there is enough to find the thread on GitHub.
 */
function threadLine(thread: ReviewThread): string {
  const where = thread.line === null ? thread.path : `${thread.path}:${String(thread.line)}`;
  return `${where} — ${thread.comments[0]?.body.trim() ?? "(the thread came back empty)"}`;
}

/** What a round managed to say on the threads it was given. */
export interface ThreadOutcome {
  readonly answered: number;
  readonly resolved: number;
  /**
   * One line per thread that could not be answered or closed. Reported rather than thrown:
   * the code is pushed, so discarding a completed round over a comment that would not post
   * helps nobody.
   */
  readonly failures: readonly string[];
}

/**
 * Called after the push, never before: a reply claiming what changed must not stand in
 * public on a round that then failed verification and pushed nothing.
 * An answer naming a thread not handed to this round is dropped, since the id is
 * model-authored and may address a conversation nobody in this round read.
 */
async function answerThreads(
  runner: SolveDependencies["commands"],
  opts: { readonly cwd: string; readonly timeoutMs: number },
  answers: readonly ThreadAnswer[],
  given: readonly ReviewThread[],
): Promise<ThreadOutcome> {
  const ids = new Set(given.map((thread) => thread.id));
  const failures: string[] = [];
  let answered = 0;
  let resolved = 0;

  for (const answer of answers) {
    if (!ids.has(answer.threadId)) {
      failures.push(
        `the round answered thread ${answer.threadId}, which it was not given — nothing was posted`,
      );
      continue;
    }

    const replied = await replyToThread(runner, {
      cwd: opts.cwd,
      threadId: answer.threadId,
      // Unprefixed on purpose: `replyToThread` marks the body as ours, which is what
      // stops `unansweredThreads` handing this answer back next round.
      body: answer.reply,
      timeoutMs: opts.timeoutMs,
    });
    if (replied.outcome === "failed") {
      failures.push(replied.reason);
      continue;
    }
    answered += 1;

    if (!answer.resolve) {
      continue;
    }
    const closed = await resolveThread(runner, {
      cwd: opts.cwd,
      reply: replied.reply,
      timeoutMs: opts.timeoutMs,
    });
    if (closed.outcome === "failed") {
      // The reply is posted, so the argument is public and a human can close
      // the thread. Worth reporting and not worth failing the round over.
      failures.push(closed.reason);
      continue;
    }
    resolved += 1;
  }

  return { answered, resolved, failures };
}

/**
 * The round could not be counted, so it does not run. One constructor, so every caller
 * treats a missing count the same way rather than guessing.
 */
const cursorFailed = (reason: string): AdvanceOutcome => ({
  kind: "failed",
  stage: "cursor",
  reason,
});

/**
 * A prefix rather than a separate field, so failures interleave with rounds in the history
 * a human reads off the pull request. Also parsed back by `lastFailedStart`, so the wording
 * is a format, not just phrasing.
 */
const FAILED_START_NOTE = "failed to start — ";

/**
 * Read out of the history rather than kept in a field of its own, so there is no second
 * count that can disagree with it. The stand-in is reached only when the bullets were
 * lost, most likely a marker edited by hand.
 */
function lastFailedStart(marker: Marker | null): string {
  const notes = (marker?.rounds ?? []).filter((line) => line.startsWith(FAILED_START_NOTE));
  const last = notes.at(-1);
  return last === undefined
    ? "the marker records the attempts but not their reasons"
    : last.slice(FAILED_START_NOTE.length);
}

/**
 * Records an attempt that decided on a round and never reached one.
 *
 * The counter lives in the marker comment, not on disk, because the failure being
 * counted is the failure to *get* a worktree — `gh` needs only a working directory.
 * Returns the `failed`/`worktree` outcome unchanged rather than a different kind: this
 * tick's honest report is still that the checkout could not be cut.
 * A failed marker write does not fail the round harder — it is logged and the original
 * reason returned, since a `gh` that cannot write cannot read either and the next survey
 * will report that on its own.
 */
export async function recordFailedStart(
  commands: SolveDependencies["commands"],
  request: SurveyRequest,
  pending: PendingRound,
  reason: string,
): Promise<AdvanceOutcome> {
  const { marker, failedStarts } = pending;
  const attempts = failedStarts + 1;
  const written = await reserve(commands, {
    worktreePath: request.cwd,
    repo: request.repo,
    number: request.number,
    timeoutMs: request.ghTimeoutMs,
    marker: {
      // Round numbers are left exactly as they were: a tick that never ran a round
      // must not consume one, or a stall could exhaust `MAX_PR_ROUNDS_TOTAL`.
      count: marker?.count ?? 0,
      reviewerCount: marker?.reviewerCount ?? 0,
      failedStarts: attempts,
      landed: marker?.landed ?? 0,
      // Not advanced either, so comments this tick decided to answer are still
      // unanswered next tick.
      lastRead: marker?.lastRead ?? NEVER_READ,
      // No attempt number on the bullet: `Failed starts:` already carries the count.
      rounds: [...(marker?.rounds ?? []), `${FAILED_START_NOTE}${reason}`],
    },
    ...(pending.markerId === null ? {} : { commentId: pending.markerId }),
  });
  if (written.outcome === "failed") {
    log.warn("solve.review.failed_start_unrecorded", {
      issueKey: request.issueKey,
      number: request.number,
      attempts,
      reason: written.reason,
    });
  } else {
    log.warn("solve.review.failed_start", {
      issueKey: request.issueKey,
      number: request.number,
      attempts,
      reason,
    });
  }
  return { kind: "failed", stage: "worktree", reason };
}

/**
 * Carried forward rather than re-read: a comment posted between the survey and the
 * reservation would otherwise arrive after the reservation that was meant to account
 * for it, so the marker would claim the round read something it never saw.
 */
export interface PendingRound {
  /** Feedback newer than the high-water mark, ours already dropped. */
  readonly comments: readonly ReviewComment[];
  /** Inline threads whose last word is not ours. */
  readonly threads: readonly ReviewThread[];
  /** The marker as it stands, or `null` on the first round of this pull request. */
  readonly marker: Marker | null;
  /** The marker comment's node id, or `null` when there is nothing to edit yet. */
  readonly markerId: string | null;
  readonly round: number;
  readonly reviewerRound: number;
  /**
   * Consecutive attempts on this pull request that never reached a round. Carried so both
   * endings can write it without re-reading the marker.
   */
  readonly failedStarts: number;
  /** Whether a person is in this batch. See the classification below. */
  readonly humanRound: boolean;
  /** Read once, in the survey, so `undraft` never re-marks a pull request ready that already is. */
  readonly isDraft: boolean;
}

export type SurveyOutcome =
  /** Nothing to cut a checkout for. The answer is final and is the round's. */
  | { readonly outcome: "settled"; readonly result: AdvanceOutcome }
  /** There is work. The caller attaches a worktree and calls `runRound`. */
  | { readonly outcome: "round"; readonly pending: PendingRound };

/** An answer the survey reached on its own, with no checkout behind it. */
const settled = (result: AdvanceOutcome): SurveyOutcome => ({ outcome: "settled", result });

/**
 * Everything that can be decided about a pull request without a checkout — every `gh` read
 * here names its repository explicitly, so none of them need a working directory.
 * The reservation stays on the far side of the checkout on purpose: reserving here and then
 * failing to attach would spend a round on a pull request nothing had touched.
 */
export async function surveyReview(
  commands: SolveDependencies["commands"],
  request: SurveyRequest,
): Promise<SurveyOutcome> {
  const { repo, number, issueKey, maxRounds, maxTotalRounds, maxFailedStarts } = request;
  const gh = { worktreePath: request.cwd, repo, number, timeoutMs: request.ghTimeoutMs };

  const read = await readReview(commands, gh);
  if (read.outcome === "failed") {
    return settled({ kind: "failed", stage: "read", reason: read.reason });
  }
  const { review } = read;

  // `lastRead` is not a third source here: it is always some entry's own `createdAt`
  // or an older mark, so it can never be newer than `newestAt`.
  const quietMs = quietFor(request.now ?? Date.now(), [review.createdAt, review.newestAt]);

  // "Has anyone actionable spoken", not "has the reviewer spoken" — a human commenting
  // before the bot reviewer does must still count.
  if (!review.anyoneResponded) {
    return settled({ kind: "waiting", quietMs });
  }

  // `readReviewThreads` refuses rather than returning a short list, so this call site
  // cannot carry on with half a review and undraft on it.
  const inline = await readReviewThreads(commands, gh);
  if (inline.outcome === "failed") {
    return settled({ kind: "failed", stage: "read", reason: inline.reason });
  }
  const threads = unansweredThreads(inline.threads);

  // Read before anything else is decided, since everything else is decided from it.
  const located = findMarker(review.comments);
  if (located.outcome === "unusable") {
    return settled(cursorFailed(located.reason));
  }
  const previous = located.outcome === "found" ? parseMarker(located.comment.body) : null;
  if (previous?.outcome === "unreadable") {
    // Not zero: losing the count must stop the round rather than reset the brake.
    return settled(
      cursorFailed(`the marker on #${String(number)} will not parse — ${previous.reason}`),
    );
  }
  const marker = previous?.outcome === "parsed" ? previous.marker : null;
  const round = marker?.count ?? 0;
  const reviewerRound = marker?.reviewerCount ?? 0;
  const failedStarts = marker?.failedStarts ?? 0;

  /**
   * The `isDraft` check is not an optimisation: unconditional undrafting means a write per
   * pull request per poll tick once a pull request stays out of draft waiting for a merge.
   */
  const undraft = async (outcome: AdvanceOutcome): Promise<AdvanceOutcome> => {
    if (!review.isDraft) {
      return outcome;
    }
    const marked = await markReady(commands, gh);
    return marked.outcome === "failed"
      ? { kind: "failed", stage: "undraft", reason: marked.reason }
      : outcome;
  };

  // The high-water-mark filter: without it, a review left in place while its author
  // waits for a reply is re-read and re-pushed every tick at full solve cost. The round
  // cap bounds that today; §6.2 removes the cap for human feedback.
  const comments = reviewerComments(review).filter(
    (comment) => marker === null || isNewer(comment.createdAt, marker.lastRead),
  );
  if (comments.length === 0 && threads.length === 0) {
    // A round that reserved and never landed also leaves nothing to answer — its reservation
    // moved the cursor and its failure note answered the threads — so this is not "ready".
    if (marker !== null && marker.landed < marker.count) {
      return settled({ kind: "unlanded", round: marker.count });
    }
    // Both halves load-bearing: an open inline thread nobody has answered is an
    // unaddressed review even when the comment list is empty.
    return settled(await undraft({ kind: "ready", rounds: round }));
  }

  const unresolved = (): string =>
    [
      ...comments.map((comment) => comment.body),
      ...threads.map((thread) => threadLine(thread)),
    ].join("\n\n");

  if (round >= maxTotalRounds) {
    // Checked before the reviewer's own cap: it counts human rounds too, since a brake
    // a person's comment could step past is not a brake.
    log.error("solve.review.capped", { issueKey, number, rounds: round });
    return settled({ kind: "capped", rounds: round, unresolved: unresolved() });
  }

  // A mixed batch is a human round: refusing a person's request because a bot commented
  // in the same window is not recoverable the way spending one extra round is.
  // A thread's origin is its *first* comment's — who raised the point being answered.
  const humanRound =
    comments.some((comment) => comment.origin === "human") ||
    threads.some((thread) => thread.comments[0]?.origin === "human");

  if (!humanRound && reviewerRound >= maxRounds) {
    // Checked only when the batch is reviewer-only; a human comment arriving after this
    // still runs a round as normal.
    log.warn("solve.review.reviewer_exhausted", {
      issueKey,
      number,
      rounds: round,
      reviewerRounds: reviewerRound,
    });
    return settled(
      await undraft({ kind: "reviewer-exhausted", rounds: round, unresolved: unresolved() }),
    );
  }

  // Last: every return above either needs no checkout or has already stopped for a
  // better reason, so checking earlier would report a stall on ticks that were never
  // going to attach.
  if (failedStarts >= maxFailedStarts) {
    log.error("solve.review.stalled", {
      issueKey,
      number,
      attempts: failedStarts,
      reason: lastFailedStart(marker),
    });
    return settled({
      kind: "stalled",
      attempts: failedStarts,
      reason: lastFailedStart(marker),
    });
  }

  return {
    outcome: "round",
    pending: {
      comments,
      threads,
      marker,
      markerId: located.outcome === "found" ? located.comment.id : null,
      round,
      reviewerRound,
      failedStarts,
      humanRound,
      isDraft: review.isDraft,
    },
  };
}

/**
 * Looks once at the review and moves the pull request forward if it can; returns rather
 * than waits. Survey with no checkout, cut one only if the survey found work, then run
 * the round — a pull request nobody has commented on costs two `gh` reads and nothing else.
 */
export async function advance(
  deps: SolveDependencies,
  request: AdvanceRequest,
): Promise<AdvanceOutcome> {
  const surveyed = await surveyReview(deps.commands, request);
  if (surveyed.outcome === "settled") {
    return surveyed.result;
  }

  const attached = await request.attach();
  if (attached.outcome === "refused") {
    // Before the reservation, so no *round* has been counted, only the attempt — the
    // only counting that happens on this side of the reservation.
    return await recordFailedStart(deps.commands, request, surveyed.pending, attached.reason);
  }
  if (attached.outcome === "conflicted") {
    return await runMergeRound(deps, request, attached, surveyed.pending);
  }

  return runRound(deps, request, attached.worktree, surveyed.pending);
}

/**
 * Spends a round on the merge instead of on the review. The reservation is written first,
 * as `runRound` writes it, so the brake fails closed.
 * The reviewer's count does not move — `MAX_REVIEW_ITERATIONS` bounds an argument between
 * two machines, and this round is not part of it — but `MAX_PR_ROUNDS_TOTAL` does, since
 * a merge round costs money like any other.
 * The high-water mark does not move either: nothing here reads a comment, so advancing it
 * would silently mark a reviewer's point as answered.
 */
export async function runMergeRound(
  deps: SolveDependencies,
  request: AdvanceRequest,
  conflict: {
    readonly worktree: Worktree;
    readonly behind: number;
    readonly files: readonly string[];
  },
  pending: PendingRound,
): Promise<AdvanceOutcome> {
  const { commands } = deps;
  const { repo, number, issueKey } = request;
  const { marker, round, reviewerRound } = pending;

  const target = {
    worktreePath: conflict.worktree.path,
    repo,
    number,
    timeoutMs: request.ghTimeoutMs,
  };
  const reservation: Marker = {
    count: round + 1,
    reviewerCount: reviewerRound,
    failedStarts: 0,
    landed: marker?.landed ?? 0,
    lastRead: marker?.lastRead ?? NEVER_READ,
    rounds: [
      ...(marker?.rounds ?? []),
      `round ${String(round + 1)} — merge, ${String(conflict.behind)} commit(s) behind ${request.baseRef} and conflicting in ${conflict.files.join(", ")}`,
    ],
  };
  const reserved = await reserve(commands, {
    ...target,
    marker: reservation,
    ...(pending.markerId === null ? {} : { commentId: pending.markerId }),
  });
  if (reserved.outcome === "failed") {
    return {
      kind: "failed",
      stage: "cursor",
      reason: `the merge round was not reserved, so it did not run — ${reserved.reason}`,
    };
  }

  const resolved = await resolveConflict(deps, { ...request, worktree: conflict.worktree });
  const synced = async (behind: number, conflicts: readonly string[]): Promise<AdvanceOutcome> => {
    await recordLanded(commands, { ...target, issueKey, marker: reservation, reserved });
    return { kind: "synced", round: round + 1, behind, conflicts };
  };

  switch (resolved.kind) {
    case "current": {
      // The base moved between the attach and here; reported as a sync of zero commits.
      return await synced(0, []);
    }
    case "merged": {
      return await synced(resolved.behind, []);
    }
    case "resolved": {
      log.info("solve.review.merged", {
        issueKey,
        number,
        round: round + 1,
        behind: resolved.behind,
        files: resolved.report.resolutions.map((resolution) => resolution.path),
      });
      return await synced(
        resolved.behind,
        resolved.report.resolutions.map((resolution) => resolution.path),
      );
    }
    case "abandoned": {
      return { kind: "abandoned", reason: resolved.reason };
    }
    case "failed": {
      // The merge resolved and the result is red — `refused`, not `failed`: the steps
      // ran and gave an answer.
      return { kind: "refused", stage: "verification", reasons: [resolved.reason] };
    }
    default: {
      return { kind: "failed", stage: "merge", reason: resolved.reason };
    }
  }
}

/**
 * Spends the round the survey decided on. Exported for the cycle, which cannot use
 * `advance`: a cycle looks at every watched pull request and spends only on the few
 * with work, so its bound must be counted between the survey and the round, not fused
 * as `advance` does. See `review-cycle.ts`.
 */
export async function runRound(
  deps: SolveDependencies,
  request: AdvanceRequest,
  worktree: Worktree,
  pending: PendingRound,
): Promise<AdvanceOutcome> {
  const { commands } = deps;
  const { repo, number, issueKey } = request;
  const { comments, threads, marker, round, reviewerRound, humanRound } = pending;
  const gh = { worktreePath: worktree.path, repo, number, timeoutMs: request.ghTimeoutMs };

  /**
   * Deliberately not a failure of the round: the code is pushed and the pull request is
   * fine, and the recovery is a human clicking the reviewer in.
   */
  const reRequest = async (pushed: boolean): Promise<ReRequest> => {
    // The ping is for a commit, not for a round — skips a reviewer re-reading a tree
    // it has already read. See `ReRequest`.
    if (!pushed) {
      return "unnecessary";
    }
    const asked = await requestReview(commands, {
      ...gh,
      ...(request.reviewer === undefined ? {} : { reviewer: request.reviewer }),
    });
    if (asked.outcome === "failed") {
      log.warn("solve.review.rerequest_failed", {
        issueKey,
        number,
        round,
        reason: asked.reason,
      });
      return "failed";
    }
    return "asked";
  };

  const reservation: Marker = {
    count: round + 1,
    // Both numbers are written together, so a round can never advance one and lose
    // the other to a second failed write.
    reviewerCount: humanRound ? reviewerRound : reviewerRound + 1,
    // Reaching here is the reset: a reservation proves the machinery works on this
    // pull request right now, so failures before it are history, not a trend.
    failedStarts: 0,
    // Not moved here: this round is unlanded until `landed()` says otherwise.
    landed: marker?.landed ?? 0,
    lastRead: newestOf(comments, marker?.lastRead ?? NEVER_READ),
    rounds: [
      ...(marker?.rounds ?? []),
      `round ${String(round + 1)} — ${humanRound ? "human" : "reviewer"}, reading ${String(comments.length)} comment(s) and ${String(threads.length)} thread(s)`,
    ],
  };
  // The reservation comes before the pass on purpose: writing it afterwards means a
  // failed write hands back a free round every tick, the runaway this mechanism closes.
  const reserved = await reserve(commands, {
    ...gh,
    marker: reservation,
    ...(pending.markerId === null ? {} : { commentId: pending.markerId }),
  });
  if (reserved.outcome === "failed") {
    return cursorFailed(`the round was not reserved, so it did not run — ${reserved.reason}`);
  }
  const memberToken = randomBytes(6).toString("hex");
  const resolved = await resolveReview(deps, {
    ...request,
    worktree,
    // One block, so both halves land inside the single untrusted-data fence `runner.ts`
    // puts around review feedback.
    reviewFeedback: `${formatReviewFeedback(comments, memberToken)}\n\n${formatThreads(threads, memberToken)}`,
    memberToken,
    members: memberSources(comments, threads),
    silenceable: silenceable(comments),
  });
  const silences = silenceLines(round + 1, resolved.report?.silent ?? [], comments);
  const closing: Marker = { ...reservation, rounds: [...reservation.rounds, ...silences] };
  const landed = async (): Promise<void> =>
    recordLanded(commands, { ...gh, issueKey, marker: closing, reserved });
  if (resolved.kind === "abandoned" || resolved.kind === "refused" || resolved.kind === "failed") {
    // Before anything else is returned: the reservation has already moved the cursor past these
    // comments, so this reply is the only way the people who asked learn to ask again.
    const told = await tellWhoAsked(commands, {
      cwd: worktree.path,
      repo,
      number,
      round: round + 1,
      comments,
      threads,
      ...(resolved.report === undefined ? {} : { report: resolved.report }),
      why: whyNothingLanded(resolved),
      timeoutMs: request.ghTimeoutMs,
    });
    // `tellWhoAsked` skips a silent comment, so the marker is the only place its reason reaches.
    if (silences.length > 0) {
      await recordSilences(commands, { ...gh, issueKey, marker: closing, reserved });
    }
    if (resolved.kind === "abandoned") {
      return { kind: "abandoned", reason: resolved.reason, told };
    }
    if (resolved.kind === "refused") {
      return { kind: "refused", stage: resolved.stage, reasons: resolved.reasons, told };
    }
    if (resolved.repairOutcome !== undefined) {
      await recordRepair(request, {
        issueKey: request.issueKey,
        number,
        round: resolved.repairOutcome,
        files: resolved.repair?.filesTouched ?? [],
        worktreePath: worktree.path,
      });
    }
    return {
      kind: "failed",
      stage: "verification",
      reason: resolved.reason,
      told,
      ...(resolved.repairOutcome === undefined ? {} : { repairOutcome: resolved.repairOutcome }),
    };
  }
  const answer = async (): Promise<ThreadOutcome> =>
    answerThreads(
      commands,
      { cwd: worktree.path, timeoutMs: request.ghTimeoutMs },
      resolved.report.threadAnswers,
      threads,
    );

  /**
   * Only when there was feedback with no thread to reply to — a round entirely inline has
   * already answered in the right place, and a summary comment restating it is the bot
   * chatter §6.3 refuses to add.
   * The `bot: ` prefix is not decoration: `reviewerComments` drops our own by it, since
   * there is no login to key on when `gh` posts as the operator.
   */
  const say = async (): Promise<Spoken> => {
    if (comments.length === 0 || resolved.report.responses.length === 0) {
      return { outcome: "nothing-to-say" };
    }
    const posted = await postComment(commands, {
      cwd: worktree.path,
      repo,
      number,
      body: `${BOT_PREFIX}round ${String(round + 1)}\n\n${resolved.report.responses
        .map((response) => `- ${response}`)
        .join("\n")}`,
      timeoutMs: request.ghTimeoutMs,
    });
    return posted.outcome === "failed"
      ? { outcome: "failed", reason: posted.reason }
      : { outcome: "posted" };
  };

  /**
   * Gated on the answer being *visible*, not merely produced: undrafting while the
   * round's reply sits unposted shows a human a reviewer's objection with no answer.
   */
  const leaveDraft = async (spoken: Spoken, posted: ThreadOutcome): Promise<Undraft> => {
    if (spoken.outcome === "failed" || posted.failures.length > 0) {
      return "still-drafting";
    }
    // Already out of draft, the ordinary case once a human is commenting on an
    // undrafted pull request; marking a ready pull request ready again can only fail.
    if (!pending.isDraft) {
      return "undrafted";
    }
    const marked = await markReady(commands, gh);
    return marked.outcome === "failed" ? "failed" : "undrafted";
  };

  if (resolved.kind === "no-change") {
    // Questions answered, no code touched. The replies still go out, and the pull
    // request leaves draft: there is nothing more this loop can do.
    const threadOutcome = await answer();
    const spoken = await say();
    await landed();
    return {
      kind: "iterated",
      round: round + 1,
      responses: resolved.report.responses,
      reviewerRequested: await reRequest(false),
      pushed: false,
      spoken,
      undrafted: await leaveDraft(spoken, threadOutcome),
      threads: threadOutcome,
      unresolved: resolved.report.unresolved,
    };
  }

  // A promoted repair's round is already committed underneath it, so the only uncommitted delta is the repair's.
  const message = resolved.repair?.commit ?? resolved.commit;
  const committed = await commitAll(commands, {
    worktreePath: worktree.path,
    subject: message.subject,
    body: message.body,
    identity: request.identity,
    timeoutMs: request.gitTimeoutMs,
  });
  if (committed.outcome === "failed") {
    return { kind: "failed", stage: "commit", reason: committed.reason };
  }

  if (committed.outcome === "committed") {
    const sent = await push(commands, {
      worktreePath: worktree.path,
      branch: worktree.branch,
      timeoutMs: request.gitTimeoutMs,
    });
    if (sent.outcome === "failed") {
      return { kind: "failed", stage: "push", reason: sent.reason };
    }
  }

  // After the push, never before. A reply claiming what changed must not be
  // standing in public on a round that pushed nothing.
  const threadOutcome = await answer();
  const spoken = await say();
  const pushed = committed.outcome === "committed";
  const repaired =
    resolved.repair === undefined
      ? undefined
      : {
          failure: resolved.repair.failure,
          notice: await announceRepair(commands, {
            cwd: worktree.path,
            repo,
            number,
            round: round + 1,
            repair: resolved.repair,
            timeoutMs: request.ghTimeoutMs,
          }),
        };
  const dropped =
    resolved.dropped.length === 0
      ? undefined
      : {
          paths: resolved.dropped.map((edit) => edit.path),
          notice: await announceDropped(commands, {
            cwd: worktree.path,
            repo,
            number,
            round: round + 1,
            dropped: resolved.dropped,
            comments,
            threads,
            report: resolved.report,
            timeoutMs: request.ghTimeoutMs,
          }),
        };
  if (resolved.repair !== undefined) {
    await recordRepair(request, {
      issueKey: request.issueKey,
      number,
      round: "verified",
      files: resolved.repair.report.filesTouched,
      worktreePath: worktree.path,
    });
  }
  await landed();
  const reviewerRequested = await reRequest(pushed);
  return {
    kind: "iterated",
    round: round + 1,
    responses: resolved.report.responses,
    reviewerRequested,
    spoken,
    // A round with a commit stays a draft: the reviewer has something new to read.
    undrafted: pushed ? "still-drafting" : await leaveDraft(spoken, threadOutcome),
    // The commit, not the model's `changed` flag — `commitAll` can find nothing to
    // commit in an edit that reproduced the file byte for byte.
    pushed,
    threads: threadOutcome,
    unresolved: resolved.report.unresolved,
    ...(repaired === undefined ? {} : { repaired }),
    ...(dropped === undefined ? {} : { dropped }),
  };
}

interface DroppedRequest {
  readonly cwd: string;
  readonly repo: string;
  readonly number: number;
  readonly round: number;
  readonly dropped: readonly DroppedEdit[];
  readonly comments: readonly ReviewComment[];
  readonly threads: readonly ReviewThread[];
  readonly report: ReviewReport;
  readonly timeoutMs: number;
}

/**
 * The edits the gate refused, told to whoever asked for them: the comment or thread a `widened`
 * entry names for that file, or, when none does, the top-level comments that asked anything —
 * and always an inline thread on a dropped file. The pass's own replies went out first and may
 * say the dropped edit was made.
 */
async function announceDropped(
  commands: SolveDependencies["commands"],
  request: DroppedRequest,
): Promise<Spoken> {
  const paths = new Set(request.dropped.map((edit) => edit.path));
  const sources = new Set(
    request.report.widened
      .filter((change) => paths.has(change.path))
      .map((change) => change.requestedBy.trim().toLowerCase().replace(/\s+/gu, " ")),
  );
  const named = request.comments.filter((_comment, index) =>
    sources.has(`comment ${String(index + 1)}`),
  );
  // A thread on the dropped file asked for an edit there whatever `widened` says, and is where its "Done" reply sits.
  const threads = request.threads.filter(
    (thread) => sources.has(thread.id.toLowerCase()) || paths.has(thread.path),
  );
  const silent = new Set(request.report.silent.map((entry) => entry.comment));
  const comments =
    named.length > 0 || threads.length > 0
      ? named
      : request.comments.filter((_comment, index) => !silent.has(`comment ${String(index + 1)}`));
  const why = request.dropped
    .map(
      (edit) =>
        `\`${edit.path}\` was not changed: ${edit.reasons.join("; ") || "the gate refused it"}.`,
    )
    .join(" ");
  const told = await tellWhoAsked(commands, {
    cwd: request.cwd,
    repo: request.repo,
    number: request.number,
    round: request.round,
    comments,
    threads,
    headline: "part of this round was not pushed",
    why: `The rest of this round was pushed, without some of what was asked. ${why} A person can make that change; this service is not allowed to.`,
    timeoutMs: request.timeoutMs,
  });
  if (told.outcome === "nothing-to-say") {
    log.warn("solve.review.drop_untold", {
      number: request.number,
      paths: [...paths],
      note: "no comment or thread on this round could be told, so the pass's replies stand uncorrected",
    });
  }
  return told;
}

/** Harness-written, so a member reads the reason nothing landed rather than the pass's own replies, which described a change that was discarded. */
function whyNothingLanded(
  resolved: Extract<ReviewRoundOutcome, { kind: "abandoned" | "refused" | "failed" }>,
): string {
  switch (resolved.kind) {
    case "abandoned": {
      return resolved.report === undefined
        ? `This round could not finish, so nothing from it was pushed: ${resolved.reason}`
        : `Declined, and nothing from this round was pushed: ${resolved.reason}`;
    }
    case "refused": {
      return `Nothing from this round was pushed — the harness refused it at the ${resolved.stage}: ${resolved.reasons.join("; ")}`;
    }
    case "failed": {
      const repair =
        resolved.repairOutcome === undefined
          ? ""
          : resolved.repairOutcome === "verified"
            ? " A repair round corrected it, but this run was not armed to push a repair, so that was recorded and not pushed."
            : ` A repair round ran and ended ${resolved.repairOutcome}.`;
      return `Nothing from this round was pushed — its change failed verification: ${resolved.reason}.${repair}`;
    }
  }
}

interface TellRequest {
  readonly cwd: string;
  readonly repo: string;
  readonly number: number;
  readonly round: number;
  readonly comments: readonly ReviewComment[];
  readonly threads: readonly ReviewThread[];
  /** Absent when the pass returned none, and then every comment is told: nothing says which asked. */
  readonly report?: ReviewReport;
  /** Defaults to saying nothing from the round was pushed. */
  readonly headline?: string;
  readonly why: string;
  readonly timeoutMs: number;
}

/** Every `@` broken, so text a model or a commenter wrote cannot mention anyone; `@copilot` summons GitHub's agent. */
function unmentioned(text: string): string {
  return text.replaceAll("@", "@\u200b");
}

/** Enough of a comment to say which one is meant; the reader has the comment itself on the page. */
const QUOTE_CHARS = 120;

/** A comment's first visible line, quoted. */
function quoted(body: string): string {
  // GitHub renders an HTML comment as nothing, so quoting one reads as an empty quote.
  const visible = body.replace(/<!--[\s\S]*?(?:-->|$)/gu, "");
  const line = visible.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  return `> ${unmentioned(shorten(line.trim(), QUOTE_CHARS))}`;
}

/**
 * The reason, replied to each comment that asked: in the thread for an inline thread, and in one
 * comment for the rest, which GitHub gives no way to reply to. Only a member is mentioned, since
 * mentioning `@copilot` asks GitHub's agent to act, and `silent` comments are told nothing.
 */
async function tellWhoAsked(
  commands: SolveDependencies["commands"],
  request: TellRequest,
): Promise<Spoken> {
  const silent = new Set((request.report?.silent ?? []).map((entry) => entry.comment));
  const asked = request.comments.filter(
    (_comment, index) => !silent.has(`comment ${String(index + 1)}`),
  );
  // The reasons can carry what the pass wrote — a decline, a `requestedBy` — so only `mentions` below is live.
  const why = unmentioned(request.why);
  const failures: string[] = [];
  let posted = false;

  for (const thread of request.threads) {
    const replied = await replyToThread(commands, {
      cwd: request.cwd,
      threadId: thread.id,
      body: why,
      timeoutMs: request.timeoutMs,
    });
    if (replied.outcome === "failed") {
      failures.push(`${thread.path}: ${replied.reason}`);
    } else {
      posted = true;
    }
  }

  if (asked.length > 0) {
    const mentions = [
      ...new Set(asked.filter((comment) => comment.member).map((comment) => `@${comment.author}`)),
    ];
    const result = await postComment(commands, {
      cwd: request.cwd,
      repo: request.repo,
      number: request.number,
      body:
        `${BOT_PREFIX}round ${String(request.round)} — ${request.headline ?? "nothing from this round was pushed"}\n\n` +
        `${mentions.length === 0 ? "" : `${mentions.join(" ")} — `}${why}\n\n` +
        `In answer to:\n${asked.map((comment) => quoted(comment.body)).join("\n")}`,
      timeoutMs: request.timeoutMs,
    });
    if (result.outcome === "failed") {
      failures.push(`the pull request comment: ${result.reason}`);
    } else {
      posted = true;
    }
  }

  if (failures.length > 0) {
    log.warn("solve.review.untold", { number: request.number, failures });
    return { outcome: "failed", reason: failures.join("; ") };
  }
  return posted ? { outcome: "posted" } : { outcome: "nothing-to-say" };
}

interface AnnounceRequest {
  readonly cwd: string;
  readonly repo: string;
  readonly number: number;
  readonly round: number;
  readonly repair: ReviewRepair;
  readonly timeoutMs: number;
}

/**
 * Harness-written and posted on its own, since a round answered only in threads posts no summary
 * comment to carry it; the round's replies describe its change as written, before the repair.
 */
async function announceRepair(
  commands: SolveDependencies["commands"],
  request: AnnounceRequest,
): Promise<Spoken> {
  const said = unmentioned(request.repair.report.summary.trim());
  // Where a repair would admit weakening an assertion to turn the check green.
  const risk = unmentioned(request.repair.report.residualRisk.trim());
  const posted = await postComment(commands, {
    cwd: request.cwd,
    repo: request.repo,
    number: request.number,
    body:
      `${BOT_PREFIX}round ${String(request.round)} — ⚠️ a repair pass finished this round's change\n\n` +
      `The round's own change failed verification: ${request.repair.failure}. A repair pass was shown ` +
      `that failure and corrected it in the second of this round's two commits — read that commit on ` +
      `its own. The replies to this round describe its change as it was written, before the repair.` +
      (said === "" ? "" : `\n\nWhat the repair pass says it did: ${said}`) +
      (risk === "" ? "" : `\n\nWhat it says could still be wrong: ${risk}`),
    timeoutMs: request.timeoutMs,
  });
  return posted.outcome === "failed"
    ? { outcome: "failed", reason: posted.reason }
    : { outcome: "posted" };
}

/** Never fails the round: the ledger is a measurement, and a row that would not write is logged instead. */
async function recordRepair(request: AdvanceRequest, record: ReviewRepairRecord): Promise<void> {
  if (request.repairLedger === undefined) {
    return;
  }
  try {
    await recordReviewRepairRound(
      request.repairLedger,
      record,
      new Date(request.now ?? Date.now()),
    );
  } catch (error) {
    log.warn("solve.repair.ledger_unwritten", {
      issueKey: record.issueKey,
      round: record.round,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export { COPILOT_REVIEWER };
