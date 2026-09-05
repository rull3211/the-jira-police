/**
 * The second half of the pipeline: get a verified branch reviewed.
 *
 * `orchestrator.ts` ends at a worktree that passed the repository's own
 * checks and has changed nothing on disk anyone else can see. This takes it
 * from there:
 *
 * ```
 *   publish      commit → push → draft PR → request the reviewer
 *     ↓
 *   (wait)       the service holds the state; nothing runs
 *     ↓
 *   advance      read the review → resolve it → push → re-request, or undraft
 * ```
 *
 * ## Why waiting is a return value and not a loop
 *
 * `advance` is called, looks once, and returns. It never polls, sleeps, or
 * blocks on a reviewer. The caller decides when to look again, which is what
 * lets the whole review cycle survive a restart: the state lives in the pull
 * request and on the ticket, not in a promise somebody is awaiting.
 *
 * ## Draft is the safety property
 *
 * The pull request is opened as a draft and is undrafted exactly once, at the
 * end, by `markReady`. Nothing here merges, and nothing here can: there is no
 * merge call in this file or in `pr.ts`. A human merges. Always.
 *
 * ## The one place a partial success must not be retried
 *
 * Opening a pull request is the only step here that creates something durable
 * and externally visible. If the reviewer request fails afterwards, the pull
 * request still exists, and re-running publish would open a second one against
 * the same branch. So that case gets its own outcome rather than `failed` —
 * the distinction exists to stop a caller's ordinary retry from doing damage.
 */

import { logger } from "../logger.ts";
import {
  type BotIdentity,
  type ReviewComment,
  type ReviewState,
  COPILOT_REVIEWER,
  commitAll,
  createDraftPr,
  formatReviewFeedback,
  markReady,
  push,
  readReview,
  requestReview,
} from "./pr.ts";
import { type ReviewRoundRequest, type SolveDependencies, resolveReview } from "./orchestrator.ts";
import type { CommitMessage } from "./runner.ts";
import type { Worktree } from "./worktree.ts";

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
 * Strictly ordered and each step gated on the one before, because every step
 * is more visible than the last and there is no point making a branch public
 * that could not be committed.
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

  // `push` refuses a protected branch by throwing. Deliberate, and documented
  // in `pr.ts`: a failure is a value a caller may log and move past, and
  // "pushed to main" must not be reachable that way.
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
  logger.info("solve.pr.created", { issueKey: worktree.issueKey, number, url });

  const requested = await requestReview(commands, {
    worktreePath: worktree.path,
    repo,
    number,
    ...(request.reviewer === undefined ? {} : { reviewer: request.reviewer }),
    timeoutMs,
  });
  if (requested.outcome === "failed") {
    logger.warn("solve.pr.reviewer_not_requested", { number, reason: requested.reason });
    return { kind: "published-unreviewed", number, url, reason: requested.reason };
  }

  return { kind: "published", number, url };
}

export interface AdvanceRequest extends Omit<ReviewRoundRequest, "reviewFeedback"> {
  readonly repo: string;
  readonly number: number;
  readonly identity: BotIdentity;
  readonly reviewer?: string;
  /** Rounds already spent on this pull request. */
  readonly round: number;
  readonly maxRounds: number;
  readonly ghTimeoutMs: number;
}

export type AdvanceOutcome =
  /** The reviewer has not said anything yet. Look again later; nothing ran. */
  | { readonly kind: "waiting" }
  /** The reviewer responded with nothing to act on. Undrafted. */
  | { readonly kind: "ready"; readonly rounds: number }
  /**
   * A round of feedback was resolved and pushed.
   *
   * `reviewerRequested` is separate from the round succeeding, and saying so is
   * the point. This comment used to read "the reviewer was asked again" as
   * though it were a fact about the round; the re-request result was discarded
   * at both call sites, so it was a description of intent. `publish` already
   * treats the same failure as its own outcome (`published-unreviewed`) on the
   * grounds that a missing scope or an uninstalled app is not the pull
   * request's fault and is recoverable by a human — `advance` now agrees with
   * it instead of contradicting it.
   *
   * False matters because the loop has no cursor over reviews: it cannot tell a
   * fresh response from the one it already handled. So a silently-dropped
   * re-request does not stall visibly — the next tick re-reads the *same*
   * comments, resolves them again, and burns rounds until the cap undrafts the
   * pull request as `exhausted`. Surfacing the flag lets the caller say "pushed
   * a fix, could not re-request review" on the ticket, which is the one message
   * that gets a human to add the reviewer by hand.
   */
  | {
      readonly kind: "iterated";
      readonly round: number;
      readonly responses: readonly string[];
      readonly reviewerRequested: boolean;
      /**
       * What the round could not settle, carried on the *successful* outcome.
       *
       * Only `exhausted` used to have this, so on every round that worked the
       * field the skill calls "what tells a human to stop the loop and look"
       * was read out of the model's answer and thrown away. The first real
       * round demonstrated the cost: it held the pass's own note that one of
       * the points it had argued with was inferred rather than read, which was
       * the single honest signal that the round was arguing with something the
       * reviewer never said. Nothing downstream saw it.
       *
       * Empty when the round settled everything, which is the common case.
       */
      readonly unresolved: string;
    }
  /**
   * The round cap was reached. Undrafted anyway, and the caller must say so on
   * the ticket — a human is now the only thing standing between this and a
   * merge, and they need to know the loop gave up rather than agreed.
   */
  | { readonly kind: "exhausted"; readonly rounds: number; readonly unresolved: string }
  /** The resolution pass declined. A human takes the pull request from here. */
  | { readonly kind: "abandoned"; readonly reason: string }
  | {
      readonly kind: "refused";
      readonly stage: "diff-gate" | "verification";
      readonly reasons: readonly string[];
    }
  | {
      readonly kind: "failed";
      readonly stage: "read" | "verification" | "commit" | "push" | "undraft";
      readonly reason: string;
    };

/**
 * Comments the resolution pass should actually be given.
 *
 * Our own comments are dropped. Without this the second round is handed the
 * first round's replies as though a reviewer had written them, and a pass
 * responding to its own previous answers is a loop with no new information in
 * it. Matching on the identity we commit under, because that is the only name
 * we can be sure is ours.
 */
export function reviewerComments(
  review: ReviewState,
  identity: BotIdentity,
): readonly ReviewComment[] {
  const ours = identity.name.toLowerCase();
  return review.comments.filter((comment) => comment.author.toLowerCase() !== ours);
}

/**
 * Looks once at the review and moves the pull request forward if it can.
 *
 * Returns rather than waits. See the header.
 */
export async function advance(
  deps: SolveDependencies,
  request: AdvanceRequest,
): Promise<AdvanceOutcome> {
  const { commands } = deps;
  const { worktree, repo, number, round, maxRounds } = request;
  const gh = { worktreePath: worktree.path, repo, number, timeoutMs: request.ghTimeoutMs };

  const read = await readReview(commands, gh);
  if (read.outcome === "failed") {
    return { kind: "failed", stage: "read", reason: read.reason };
  }
  const { review } = read;

  if (!review.reviewerResponded) {
    return { kind: "waiting" };
  }

  const undraft = async (outcome: AdvanceOutcome): Promise<AdvanceOutcome> => {
    const marked = await markReady(commands, gh);
    return marked.outcome === "failed"
      ? { kind: "failed", stage: "undraft", reason: marked.reason }
      : outcome;
  };

  /**
   * Asks the reviewer to look again, and reports whether that worked.
   *
   * Deliberately not a failure of the round. The code is pushed and the pull
   * request is fine; what is missing is a notification, and the recovery is a
   * human clicking the reviewer in. Returning `failed` here would discard a
   * completed round of work over that.
   */
  const reRequest = async (): Promise<boolean> => {
    const asked = await requestReview(commands, {
      ...gh,
      ...(request.reviewer === undefined ? {} : { reviewer: request.reviewer }),
    });
    if (asked.outcome === "failed") {
      logger.warn("solve.review.rerequest_failed", {
        issueKey: worktree.issueKey,
        number,
        round,
        reason: asked.reason,
      });
      return false;
    }
    return true;
  };

  const comments = reviewerComments(review, request.identity);
  if (comments.length === 0) {
    // Responded, nothing to act on. The pull request is as good as it is going
    // to get from this side.
    return undraft({ kind: "ready", rounds: round });
  }

  if (round >= maxRounds) {
    // Undrafted anyway, per the plan: a stalled draft helps nobody. The caller
    // owns saying on the ticket that the cap was hit rather than the reviewer
    // being satisfied.
    logger.warn("solve.review.exhausted", { issueKey: worktree.issueKey, number, rounds: round });
    return undraft({
      kind: "exhausted",
      rounds: round,
      unresolved: comments.map((comment) => comment.body).join("\n\n"),
    });
  }

  const resolved = await resolveReview(deps, {
    ...request,
    reviewFeedback: formatReviewFeedback(comments),
  });
  if (resolved.kind === "abandoned") {
    return { kind: "abandoned", reason: resolved.reason };
  }
  if (resolved.kind === "refused") {
    return { kind: "refused", stage: resolved.stage, reasons: resolved.reasons };
  }
  if (resolved.kind === "failed") {
    return { kind: "failed", stage: "verification", reason: resolved.reason };
  }
  if (resolved.kind === "no-change") {
    // Questions answered, no code touched. Nothing to push, and the reviewer
    // is asked again so they can read the answers.
    const reviewerRequested = await reRequest();
    return {
      kind: "iterated",
      round: round + 1,
      responses: resolved.report.responses,
      reviewerRequested,
      unresolved: resolved.report.unresolved,
    };
  }

  const committed = await commitAll(commands, {
    worktreePath: worktree.path,
    subject: resolved.commit.subject,
    body: resolved.commit.body,
    identity: request.identity,
    timeoutMs: request.gitTimeoutMs,
  });
  if (committed.outcome === "failed") {
    return { kind: "failed", stage: "commit", reason: committed.reason };
  }

  if (committed.outcome === "committed") {
    const pushed = await push(commands, {
      worktreePath: worktree.path,
      branch: worktree.branch,
      timeoutMs: request.gitTimeoutMs,
    });
    if (pushed.outcome === "failed") {
      return { kind: "failed", stage: "push", reason: pushed.reason };
    }
  }

  const reviewerRequested = await reRequest();
  return {
    kind: "iterated",
    round: round + 1,
    responses: resolved.report.responses,
    reviewerRequested,
    unresolved: resolved.report.unresolved,
  };
}

export { COPILOT_REVIEWER };
