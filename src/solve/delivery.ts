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
  type ReviewThread,
  type WriteCommentResult,
  COPILOT_REVIEWER,
  commitAll,
  createDraftPr,
  editComment,
  formatReviewFeedback,
  formatThreads,
  markReady,
  postComment,
  push,
  readReview,
  readReviewThreads,
  replyToThread,
  requestReview,
  resolveThread,
} from "./pr.ts";
import {
  type Marker,
  NEVER_READ,
  findMarker,
  isNewer,
  isOurs,
  parseMarker,
  renderMarker,
} from "./marker.ts";
import { type ReviewRoundRequest, type SolveDependencies, resolveReview } from "./orchestrator.ts";
import type { CommitMessage, ThreadAnswer } from "./runner.ts";
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
  /**
   * The reviewer's argument budget, `MAX_REVIEW_ITERATIONS`.
   *
   * **There is no `round` beside it any more, and its absence is the feature.**
   * It used to be passed in, and `buildAdvanceRequest` passed `0` on every
   * invocation because a fresh process has nothing to count from — so the cap
   * could not fire from the command line at all. Rounds already spent are now
   * read off the marker comment on the pull request, which is the only place
   * that survives the process. A caller cannot supply the number, so a caller
   * cannot supply a wrong one.
   */
  readonly maxRounds: number;
  /**
   * The absolute stop, `MAX_PR_ROUNDS_TOTAL`. Not `maxRounds` under a second
   * name: that one is a policy about how much argument a bot reviewer is worth
   * and is expected to be relaxed, this one is a brake on the machinery.
   */
  readonly maxTotalRounds: number;
  readonly ghTimeoutMs: number;
}

/**
 * What happened to the "please look again" ping at the end of a round.
 *
 * A boolean here was two facts wearing one name. `false` meant "the API call
 * failed, a human must add the reviewer by hand" — a thing to act on — and a
 * round that had nothing to show the reviewer had no way to say so except by
 * lying in one direction or the other.
 */
export type ReRequest =
  /** The reviewer was pinged and will look again. */
  | "asked"
  /** The ping did not go out. Recoverable, by a human clicking one button. */
  | "failed"
  /**
   * Nothing was pushed, so there was nothing new to re-read and no ping was
   * sent. Observed on PR #2658: the round at 12:23 changed no code, re-requested
   * anyway, and Copilot re-reviewed a byte-identical tree three minutes later
   * and restated itself. That is the reviewer instability §6.1c describes, and
   * we were manufacturing it — a paid review of a diff nobody had touched,
   * whose only possible output is the previous review again.
   */
  | "unnecessary";

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
   * False used to matter because the loop had no cursor: it could not tell a
   * fresh response from one it had already handled, so a silently-dropped
   * re-request did not stall visibly — the next tick re-read the same comments,
   * resolved them again, and burned rounds until the cap undrafted the pull
   * request as `exhausted`. **The cursor inverted that failure and did not
   * remove it.** The marker now recognises those comments as already read, so
   * the next tick returns `ready` and *undrafts* — which is worse in a quieter
   * way: a pull request goes to a reviewer who was never told to look at it,
   * and nothing anywhere says the notification was the missing step.
   *
   * So surfacing the flag is what lets the caller say "pushed a fix, could not
   * re-request review" on the ticket, which is the one message that gets a
   * human to add the reviewer by hand.
   */
  | {
      readonly kind: "iterated";
      readonly round: number;
      readonly responses: readonly string[];
      readonly reviewerRequested: ReRequest;
      /**
       * Whether a commit actually reached the branch this round.
       *
       * Not implied by `iterated`, which is the mistake this field exists to
       * stop. Two of the three paths to this outcome push nothing — a round
       * that answered the review without touching code, and one whose edits
       * `commitAll` found nothing to commit in — and the headline said
       * "round N pushed" on all three. Observed on round 2 of PR #2658, where
       * the round deliberately changed nothing and the terminal announced a
       * push that had not happened. An operator reading that goes looking for
       * a commit, and the next thing they doubt is the marker.
       */
      readonly pushed: boolean;
      /**
       * What was posted on the inline threads, and what would not post.
       *
       * Beside `responses` rather than folded into it, because they have
       * different audiences and only one of them is public: `responses` reaches
       * an operator's terminal, and these reached the reviewer.
       */
      readonly threads: ThreadOutcome;
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
  /**
   * `MAX_PR_ROUNDS_TOTAL` reached. Nothing ran, and **the pull request is left
   * as it is** — not undrafted.
   *
   * That is the difference from `exhausted` and the reason this is not the same
   * outcome with a bigger number. Exhaustion is a reviewer running out of turns
   * on a pull request the loop still believes in, so undrafting it is the right
   * end. This is the machinery hitting a stop, which says nothing about whether
   * the code is ready; undrafting on it would be the loop reporting a verdict it
   * did not reach, on the one path taken when something has gone wrong enough to
   * cost twenty rounds.
   */
  | { readonly kind: "capped"; readonly rounds: number; readonly unresolved: string }
  /** The resolution pass declined. A human takes the pull request from here. */
  | { readonly kind: "abandoned"; readonly reason: string }
  | {
      readonly kind: "refused";
      readonly stage: "diff-gate" | "verification";
      readonly reasons: readonly string[];
    }
  | {
      /**
       * `cursor` is the stage that must not be recovered from by guessing. A
       * marker that will not parse, two of them, or a reservation that would not
       * write all mean the round cannot be counted — and a round that runs
       * uncounted is the unbounded loop the marker exists to prevent.
       */
      readonly kind: "failed";
      readonly stage: "read" | "cursor" | "verification" | "commit" | "push" | "undraft";
      readonly reason: string;
    };

/**
 * Comments the resolution pass should actually be given.
 *
 * Our own comments are dropped. Without this the second round is handed the
 * first round's replies as though a reviewer had written them, and a pass
 * responding to its own previous answers is a loop with no new information in
 * it.
 *
 * ## This used to match on the author, and that was a bug
 *
 * It compared `ReviewComment.author` — a GitHub **login**, parsed out of
 * `author.login` — against `BotIdentity.name`, which is `SOLVE_BOT_NAME` and
 * defaults to the git author string `jira-police`. Those never match, so the
 * filter dropped nothing. It was inert only because nothing posted a comment
 * yet, and wrong the moment something did.
 *
 * There is no login to fix it to, either. `gh` is authenticated as **the
 * operator**, so a comment this service posts is authored by a human's account
 * and is indistinguishable *by author* from that human's own review — verified
 * on PR #2658, where two hand-driven thread replies came back authored
 * `rull3211`, the same login as the operator's own reviews. So ours is what
 * carries the `bot: ` prefix, not what carries a name, and `BotIdentity` goes
 * back to meaning only what it says: the name on a commit.
 *
 * The failure this protects against is not symmetric with the one above.
 * Getting it wrong in this direction feeds the pass its own last answer and
 * burns a round; getting it wrong in the other direction discards a person's
 * comment because they happened to open it with the same three characters,
 * which is why the prefix is checked at the start of the body and nowhere else.
 */
export function reviewerComments(review: ReviewState): readonly ReviewComment[] {
  return review.comments.filter((comment) => !isOurs(comment.body));
}

/**
 * The newest instant among the comments this round is about to handle.
 *
 * Falls back to the mark already recorded, which is what keeps the cursor
 * monotonic: a batch whose comments all came back undated must not move the
 * high-water mark *backwards* to the epoch and re-open everything before it.
 * An undated comment is still handled — `isNewer` lets it through — it just
 * does not get to say when.
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

/**
 * The inline threads a round should be given, and the rule for leaving one out.
 *
 * Two exclusions, and they are not the same kind of thing.
 *
 * A **resolved** thread is closed. Someone — a reviewer, a human, or an earlier
 * round of this loop — decided it was done, and reopening the argument by
 * answering it again is noise on somebody else's pull request.
 *
 * A thread whose **last comment is ours** has been answered in public and the
 * answer is still there. This is the plan's instability rule, and it is keyed on
 * a fact rather than on a timestamp on purpose: a bot reviewer that re-raises a
 * settled point produces no new comment on the thread, so a date-based cursor
 * would see nothing and a "did the verdict change" check would see an argument
 * worth having. The thread itself already says who spoke last. If the reviewer
 * genuinely comes back with something new, their comment is last and the thread
 * is actionable again, which is exactly the discrimination wanted.
 *
 * The second rule is also the retry: a round whose reply failed to post leaves
 * the reviewer's comment last, so the next round tries again rather than
 * treating a failed write as an answer given.
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
 * One thread, as a line for a human reading `unresolved` on a ticket.
 *
 * The location and the first comment, not the whole conversation: this ends up
 * in a Jira comment telling somebody the loop gave up, and what they need is
 * enough to find the thread on GitHub.
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
   * One line per thread that could not be answered or closed.
   *
   * Reported rather than thrown, for the same reason `reviewerRequested` is: the
   * code is pushed and the pull request is healthy, and discarding a completed
   * round because a comment would not post helps nobody. But it is never
   * silent — an unposted reply is a decline that nobody can see, which is
   * indistinguishable from not having read the comment.
   */
  readonly failures: readonly string[];
}

/**
 * Posts the round's answers, and closes only the threads that earned it.
 *
 * **Called after the push, never before.** A reply that says what changed is a
 * public claim about a commit, so posting it before the commit exists would
 * leave that claim standing on a round that then failed verification and pushed
 * nothing. The reviewer would read an answer to a change that is not there.
 *
 * Two guards worth naming. An answer naming a thread that was not handed to
 * this round is dropped — the id is model-authored and an id that came from
 * nowhere addresses a conversation nobody in this round read. And the resolve
 * goes through `resolveThread`, which takes the receipt `replyToThread`
 * returns, so a thread cannot be closed by a round that failed to say why.
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
 * The round could not be counted, so it does not run.
 *
 * Every caller is a place where guessing would release the brake rather than
 * apply it, which is why they all funnel through one constructor instead of
 * each deciding what a missing count means.
 */
const cursorFailed = (reason: string): AdvanceOutcome => ({
  kind: "failed",
  stage: "cursor",
  reason,
});

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
  const { worktree, repo, number, maxRounds, maxTotalRounds } = request;
  const gh = { worktreePath: worktree.path, repo, number, timeoutMs: request.ghTimeoutMs };

  const read = await readReview(commands, gh);
  if (read.outcome === "failed") {
    return { kind: "failed", stage: "read", reason: read.reason };
  }
  const { review } = read;

  if (!review.reviewerResponded) {
    return { kind: "waiting" };
  }

  // The inline comments, over the transport that can reach them. A failure here
  // is a failure of the round and not a shrug: `readReviewThreads` refuses
  // rather than returning a short list precisely so this call site cannot carry
  // on with half a review, resolve what it did see, and undraft.
  const inline = await readReviewThreads(commands, gh);
  if (inline.outcome === "failed") {
    return { kind: "failed", stage: "read", reason: inline.reason };
  }
  const threads = unansweredThreads(inline.threads);

  // The marker is read before anything else is decided, because everything else
  // is decided from it: how many rounds this pull request has already cost, and
  // which of the comments below have already been answered.
  const located = findMarker(review.comments);
  if (located.outcome === "unusable") {
    return cursorFailed(located.reason);
  }
  const previous = located.outcome === "found" ? parseMarker(located.comment.body) : null;
  if (previous?.outcome === "unreadable") {
    // Not zero. The whole point of the marker is that losing the count releases
    // the brake, so an unreadable one stops the round and says why.
    return cursorFailed(`the marker on #${String(number)} will not parse — ${previous.reason}`);
  }
  const marker = previous?.outcome === "parsed" ? previous.marker : null;
  const round = marker?.count ?? 0;

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
  const reRequest = async (pushed: boolean): Promise<ReRequest> => {
    // The ping is for a commit, not for a round. Skipping it when there is no
    // commit is what stops the loop asking a reviewer to re-read a tree it has
    // already read — see `ReRequest`. A reply we posted on a thread notifies on
    // its own, so nothing goes unheard by leaving this out.
    if (!pushed) {
      return "unnecessary";
    }
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
      return "failed";
    }
    return "asked";
  };

  // The high-water-mark filter, and the single most important line in this
  // function. Without it the loop cannot tell a comment it already handled from
  // a new one, so a review left in place while its author waits for a reply is
  // re-read, re-resolved and re-pushed on every tick at full solve cost, until
  // somebody merges the pull request. The round cap bounds that today; §6.2
  // removes the cap for human feedback, which is exactly the feedback that will
  // sit unanswered the longest.
  const comments = reviewerComments(review).filter(
    (comment) => marker === null || isNewer(comment.createdAt, marker.lastRead),
  );
  if (comments.length === 0 && threads.length === 0) {
    // Responded, nothing *new* to act on. Reached both on a pull request whose
    // reviewer never had a complaint and on one whose comments were all
    // answered by an earlier round, and those are the same state: there is
    // nothing left for this side to do.
    //
    // **Both halves are load-bearing.** An open inline thread nobody has
    // answered is an unaddressed review, and undrafting on the strength of an
    // empty comment list would do to every pull request what the loop did to
    // #2658 once — mark it reviewed while the substance of the review sat
    // somewhere `--json` cannot see.
    return undraft({ kind: "ready", rounds: round });
  }

  const unresolved = (): string =>
    [
      ...comments.map((comment) => comment.body),
      ...threads.map((thread) => threadLine(thread)),
    ].join("\n\n");

  if (round >= maxTotalRounds) {
    // Checked before the reviewer's own cap, because it outranks it: a policy
    // change to `maxRounds` must not be able to step past the brake. Nothing is
    // undrafted — see the outcome's doc comment.
    logger.error("solve.review.capped", { issueKey: worktree.issueKey, number, rounds: round });
    return { kind: "capped", rounds: round, unresolved: unresolved() };
  }

  if (round >= maxRounds) {
    // Undrafted anyway, per the plan: a stalled draft helps nobody. The caller
    // owns saying on the ticket that the cap was hit rather than the reviewer
    // being satisfied.
    logger.warn("solve.review.exhausted", { issueKey: worktree.issueKey, number, rounds: round });
    return undraft({ kind: "exhausted", rounds: round, unresolved: unresolved() });
  }

  // **The reservation, and it comes before the pass on purpose.** Bump the
  // count and move the high-water mark first; if the write fails, the round
  // does not run. Writing it afterwards means a failed write hands back a free
  // round — every tick, forever — which is the runaway this whole mechanism
  // exists to close, reintroduced by an ordering.
  //
  // The cost is accepted deliberately: a round that reserves and then fails has
  // spent a round on feedback it will not retry. `advance` already makes that
  // trade for `refused`, and here the spend is visible in the marker rather
  // than silent.
  const reserved = await reserve(commands, {
    ...gh,
    marker: {
      count: round + 1,
      lastRead: newestOf(comments, marker?.lastRead ?? NEVER_READ),
      rounds: [
        ...(marker?.rounds ?? []),
        `round ${String(round + 1)} — reading ${String(comments.length)} comment(s) and ${String(threads.length)} thread(s)`,
      ],
    },
    ...(located.outcome === "found" ? { commentId: located.comment.id } : {}),
  });
  if (reserved.outcome === "failed") {
    return cursorFailed(`the round was not reserved, so it did not run — ${reserved.reason}`);
  }

  const resolved = await resolveReview(deps, {
    ...request,
    // One block, so both halves land inside the single untrusted-data fence
    // `runner.ts` puts around review feedback. A thread body is exactly as
    // attacker-influenced as a review body and must not get a quieter frame.
    reviewFeedback: `${formatReviewFeedback(comments)}\n\n${formatThreads(threads)}`,
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
  const answer = async (): Promise<ThreadOutcome> =>
    answerThreads(
      commands,
      { cwd: worktree.path, timeoutMs: request.ghTimeoutMs },
      resolved.report.threadAnswers,
      threads,
    );

  if (resolved.kind === "no-change") {
    // Questions answered, no code touched. Nothing to push, and the reviewer
    // is asked again so they can read the answers. The thread replies still go
    // out: a round that answered without editing has answered, and its argument
    // belongs next to the comment it answers rather than only in a terminal.
    const threadOutcome = await answer();
    const reviewerRequested = await reRequest(false);
    return {
      kind: "iterated",
      round: round + 1,
      responses: resolved.report.responses,
      reviewerRequested,
      pushed: false,
      threads: threadOutcome,
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
  const pushed = committed.outcome === "committed";
  const reviewerRequested = await reRequest(pushed);
  return {
    kind: "iterated",
    round: round + 1,
    responses: resolved.report.responses,
    reviewerRequested,
    // The commit, not the model's `changed` flag. A pass can report an edit
    // that `commitAll` then finds nothing to commit in — a rewrite that
    // reproduced the file byte for byte — and the branch is the only honest
    // witness to what a reviewer will see.
    pushed,
    threads: threadOutcome,
    unresolved: resolved.report.unresolved,
  };
}

export { COPILOT_REVIEWER };
