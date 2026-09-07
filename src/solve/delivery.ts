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
  BOT_PREFIX,
  findMarker,
  isNewer,
  isOurs,
  parseMarker,
  renderMarker,
} from "./marker.ts";
import type { SyncedAttachResult } from "./base-sync.ts";
import {
  type ReviewRoundRequest,
  type SolveDependencies,
  resolveConflict,
  resolveReview,
} from "./orchestrator.ts";
import type { CommitMessage, ThreadAnswer } from "./runner.ts";
import { quietFor } from "./silence.ts";
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

/**
 * Cuts the checkout a round needs, and is called only when a round will run.
 *
 * **A function rather than a `Worktree`, and that is the whole of the poll-cycle
 * change.** `advance` used to be handed a checkout that its caller had already
 * built, so every look at a pull request paid a fetch and a `worktree add`
 * before anything had read the review — including the looks that end in
 * `waiting`, which are the overwhelming majority once this runs on a timer
 * rather than under a person's finger. At one tick a minute across N pull
 * requests that is N checkouts a minute to discover that nobody has said
 * anything.
 *
 * Everything up to and including the decision to spend a round is `gh` over
 * `--repo`, which needs no checkout at all — only a directory to run in. So the
 * survey runs first, and this is invoked afterwards, on the one path that has
 * something to build.
 *
 * The caller keeps ownership of what it returns: `advance` never removes a
 * worktree, because the caller also has to remove the ones it kept as evidence
 * and two owners of one directory is worse than one owner and a long function.
 */
export type WorktreeSource = () => Promise<SyncedAttachResult>;

/**
 * Everything needed to look at a pull request, and nothing needed to act on one.
 *
 * Split out from `AdvanceRequest` because the split is the point: a caller that
 * only wants to know whether a pull request has anything to say can build one of
 * these and never think about worktrees, identities or git timeouts. That is the
 * shape a poll cycle over N pull requests wants — N cheap reads, then a request
 * of the fuller kind for the few that came back with work.
 */
export interface SurveyRequest {
  readonly repo: string;
  readonly number: number;
  /** The ticket this pull request belongs to. Logging only; nothing reads it back. */
  readonly issueKey: string;
  /**
   * Where `gh` runs while there is no checkout.
   *
   * Every read and every write the survey makes names its repository
   * explicitly — `--repo owner/name`, or owner and name as separate GraphQL
   * variables — so this is a working directory and nothing else. The base
   * clone is the obvious thing to pass, and any directory would do.
   */
  readonly cwd: string;
  /**
   * Injected so the silence boundary can be tested without faking a clock.
   *
   * The threshold itself is deliberately *not* here. `advance` reports how long
   * the pull request has been quiet and never decides what that is worth: a
   * foreground command holds somebody's terminal and should give up, and a
   * daemon reading N pull requests for free has no reason to. One measurement,
   * two policies, the same split `MAX_PR_ROUNDS_TOTAL` and
   * `MAX_REVIEW_ITERATIONS` already make over one marker.
   */
  readonly now?: number;
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
  /**
   * `MAX_FAILED_STARTS` — how many ticks in a row may decide on a round and
   * never reach one before the pull request is left to a person.
   *
   * The third bound over one marker, and the axis the other two cannot see.
   * `maxRounds` and `maxTotalRounds` are both counted from rounds that
   * *reserved*, so a failure before the reservation moves neither and costs
   * nothing — which is what let SSX-3835 fail every two minutes for four days
   * without a cap firing, a label moving or a cent being spent. Bound attempts,
   * not rounds.
   */
  readonly maxFailedStarts: number;
  readonly ghTimeoutMs: number;
}

export interface AdvanceRequest
  extends SurveyRequest, Omit<ReviewRoundRequest, "reviewFeedback" | "worktree"> {
  readonly identity: BotIdentity;
  readonly reviewer?: string;
  /** See `WorktreeSource`. Not called on a look that finds nothing to do. */
  readonly attach: WorktreeSource;
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

/**
 * What happened to the round's answer to feedback that has no thread.
 *
 * A review body — Copilot's summary, a human's overall verdict — is not an
 * inline comment and has nothing to reply *to*. `answerThreads` therefore never
 * sees it, so before this existed the round's whole argument went to
 * `responses`, which reaches an operator's terminal and nobody else. Observed
 * on round 3 of PR #2658: the pass refuted the reviewer's premise with file and
 * line references, and on the pull request the last visible word was still the
 * reviewer's objection. §6.1c's "push back in public" had been built for
 * threads only.
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
 * Draft means *this side is still working*. A round that pushed a commit is
 * still working — the reviewer has something new to read — so it stays a draft.
 * A round that changed nothing has done everything it can, and the honest thing
 * is to hand the pull request to a human, which is what undrafting is.
 *
 * **The obvious argument for this is wrong and is not the reason.** It is
 * tempting to say the draft costs a paid round to clear; it does not. The
 * empty-inbox path returns `ready` before the pass runs, so a later tick that
 * finds nothing new spends no money at all — measured on #2658, where it took
 * 2.5 seconds. What the delay actually costs is that the wait is not bounded:
 * the tick only clears the draft *if nothing new arrives*, so on a pull request
 * anyone is still commenting on, the draft never clears, and a human reviews a
 * pull request whose own flag says it is unfinished.
 *
 * `failed` is separate from `still-drafting` because they are opposite
 * instructions. One is a person clicking "Ready for review"; the other is
 * nothing to do.
 */
export type Undraft = "undrafted" | "failed" | "still-drafting";

export type AdvanceOutcome =
  /** The reviewer has not said anything yet. Look again later; nothing ran. */
  | {
      readonly kind: "waiting";
      /**
       * Milliseconds since the last dated thing on the pull request, or `null`
       * when nothing on it carries a date.
       *
       * **This replaces a counter that lived on the caller's stack.** The chain
       * used to count consecutive silent polls itself, which made patience a
       * product of the poll interval — halve the cadence and the loop becomes
       * half as patient, with nothing in either setting saying so — and gave a
       * poll cycle over many pull requests nowhere to keep the count, since the
       * thing being measured belongs to each pull request rather than to the
       * loop. Measured from the pull request, it survives a restart for the
       * same reason the round counts do.
       *
       * `null` means unmeasurable, not zero and not forever. See `silence.ts`.
       */
      readonly quietMs: number | null;
    }
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
      /** Where the answer to non-thread feedback went. See `Spoken`. */
      readonly spoken: Spoken;
      /** Whether the round left the pull request in draft. See `Undraft`. */
      readonly undrafted: Undraft;
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
   * The **reviewer's** budget is spent. Undrafted anyway, and the caller must
   * say so on the ticket — a human is now the only thing standing between this
   * and a merge, and they need to know the loop gave up rather than agreed.
   *
   * **Renamed from `exhausted` because it stopped being an ending.** The human
   * channel is still open: a person can comment after this and the next round
   * runs, since `MAX_REVIEW_ITERATIONS` no longer counts their request. A
   * reader who took this for a terminal would conclude the pull request was
   * finished with, which is now exactly wrong — it is finished arguing with one
   * of its two reviewers.
   */
  | {
      readonly kind: "reviewer-exhausted";
      readonly rounds: number;
      readonly unresolved: string;
    }
  /**
   * `MAX_PR_ROUNDS_TOTAL` reached. Nothing ran, and **the pull request is left
   * as it is** — not undrafted.
   *
   * That is the difference from `reviewer-exhausted` and the reason this is not
   * the same outcome with a bigger number. Exhaustion is a reviewer running out of turns
   * on a pull request the loop still believes in, so undrafting it is the right
   * end. This is the machinery hitting a stop, which says nothing about whether
   * the code is ready; undrafting on it would be the loop reporting a verdict it
   * did not reach, on the one path taken when something has gone wrong enough to
   * cost twenty rounds.
   */
  | { readonly kind: "capped"; readonly rounds: number; readonly unresolved: string }
  /**
   * `MAX_FAILED_STARTS` reached: this pull request has decided on a round and
   * failed to reach one, N ticks running, and will be left alone until a person
   * looks. Nothing ran, nothing is undrafted, no money was spent — on this tick
   * or on any of the ones being counted.
   *
   * **Not `capped` with a different number, and not `failed` with a bigger
   * one.** `capped` says a pull request cost twenty rounds, which is a claim
   * about spend and sends a reader looking for twenty rounds of work; this says
   * the opposite, that it cost nothing at all and that the nothing is the
   * problem. And `failed` is the honest report of *one* tick that could not
   * start, which is often transient and right to retry — this is the statement
   * that retrying has been tried and is not working, which is a different fact
   * with a different remedy.
   *
   * `reason` is the last recorded failure rather than all N, because they are
   * the same one: the states that produce this do not vary between ticks, which
   * is precisely why counting them is worth doing. The full history is on the
   * marker comment, where a human reading the pull request will find it.
   */
  | { readonly kind: "stalled"; readonly attempts: number; readonly reason: string }
  /**
   * The round spent itself bringing the branch up to date with its base, and
   * answered nobody.
   *
   * Its own kind because it is neither of the two things a reader would
   * otherwise take it for. It is not `ready`: nothing about the review was
   * looked at, so undrafting on it would hand a human a pull request on the
   * strength of a merge. And it is not `iterated`: no reviewer was answered, no
   * thread was touched, and the marker's reviewer count did not move — calling
   * it a round of review would spend the reviewer's budget on a merge.
   *
   * The reviewer's comments are deliberately left unread, which is what brings
   * the next tick straight back to them. A branch that will not take its base
   * cannot be verified, so a review round on top of one answers from a tree
   * nobody can build; the merge goes first and the argument keeps.
   *
   * `conflicts` is empty when the merge went in clean — which happens when the
   * base moved between the attach and the round — and holds the paths the pass
   * resolved when it did not.
   */
  | {
      readonly kind: "synced";
      readonly round: number;
      readonly behind: number;
      readonly conflicts: readonly string[];
    }
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
      readonly stage:
        | "read"
        | "cursor"
        /**
         * The survey found a round to run and the checkout could not be cut.
         *
         * Its own stage rather than folded into `read`, because it is the one
         * failure that happens *after* the round has been decided on and
         * before it has been reserved — so nothing has been spent and nothing
         * has been counted, and the honest report is that the pull request is
         * still exactly where the survey found it.
         */
        | "worktree"
        /**
         * The base would not merge and the attempt to resolve it did not get
         * far enough to have an opinion — the merge would not start, the tree
         * came back in a state the harness would not accept, or the merge
         * commit would not commit or push.
         *
         * Separate from `verification`, which is the merge resolving cleanly
         * and the result being red. That one is a fact about the code and is
         * worth a reader's attention; this one is a fact about a git command,
         * and the pull request is exactly where it was.
         */
        | "merge"
        | "verification"
        | "commit"
        | "push"
        | "undraft";
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
 * How a failed start is written into the marker's own history list.
 *
 * A prefix rather than a separate field, because the list is what a human reads
 * off the pull request and interleaving the failures with the rounds is the
 * whole point: four "failed to start" bullets under one round is a legible
 * story, and the same four in a counter elsewhere is a number.
 *
 * It is also parsed back — see `lastFailedStart` — which makes it a format and
 * not a phrasing. Changing the wording without changing both is caught.
 */
const FAILED_START_NOTE = "failed to start — ";

/**
 * The reason recorded by the most recent failed start, or a stand-in.
 *
 * Read out of the history rather than kept in a field of its own, because the
 * alternative is a second thing to write on every failure and a second thing
 * that can disagree with the count. The stand-in is reached only when the
 * bullets were lost — a marker edited by hand, most likely — and it must not
 * pretend to know: the count is still trustworthy, and it is the count the
 * bound reads.
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
 * **The counter has to be written from the one place that has no checkout**,
 * which is why it lives in the marker comment rather than anywhere on disk or
 * in the worktree: the failure being counted is the failure to *get* a
 * worktree. `gh` needs only a working directory, and the survey already proved
 * one is available by reading the pull request through it.
 *
 * Returns the `failed`/`worktree` outcome unchanged. The counting is a side
 * effect on purpose — this tick's honest report is still that the checkout
 * could not be cut, and turning the third such report into a different kind
 * would hide the first two.
 *
 * **A failed marker write does not fail the round harder.** It is logged and
 * the original reason is returned, because the two failures have nothing to do
 * with each other and the second is loud elsewhere: a `gh` that cannot write
 * cannot read either, so the next survey returns `failed`/`read` and says so.
 * What is lost is one increment, which delays the bound by a tick.
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
      // Every round number is left exactly as it was. A tick that never ran a
      // round must not consume one — that is the whole distinction this counter
      // exists to draw, and spending a round here would let a stall exhaust
      // `MAX_PR_ROUNDS_TOTAL` and be reported as an argument that went too long.
      count: marker?.count ?? 0,
      reviewerCount: marker?.reviewerCount ?? 0,
      failedStarts: attempts,
      // The high-water mark does not move either, so the comments this tick
      // decided to answer are still unanswered next tick. Advancing it here
      // would silently drop a reviewer's request on the way to a stall.
      lastRead: marker?.lastRead ?? NEVER_READ,
      // No attempt number on the bullet. `Failed starts:` already carries the
      // count, and the suffix would come back out through `lastFailedStart` and
      // into an outcome that states the same number in its own field — which
      // reads, in the one line a daemon logs, as two counts that could disagree.
      rounds: [...(marker?.rounds ?? []), `${FAILED_START_NOTE}${reason}`],
    },
    ...(pending.markerId === null ? {} : { commentId: pending.markerId }),
  });
  if (written.outcome === "failed") {
    logger.warn("solve.review.failed_start_unrecorded", {
      issueKey: request.issueKey,
      number: request.number,
      attempts,
      reason: written.reason,
    });
  } else {
    logger.warn("solve.review.failed_start", {
      issueKey: request.issueKey,
      number: request.number,
      attempts,
      reason,
    });
  }
  return { kind: "failed", stage: "worktree", reason };
}

/**
 * What the survey found when it found work.
 *
 * Carried forward rather than re-read, and that is deliberate: the round runs
 * against the review the survey decided on. Reading it again after the checkout
 * would let a comment posted in those few seconds arrive *after* the reservation
 * that was supposed to account for it, so the marker would say the round had
 * read something it never saw.
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
   * Consecutive attempts on this pull request that never reached a round.
   *
   * Carried so both endings can write it without re-reading the marker: a round
   * that reserves clears it, and one that cannot attach adds to it. Reading it
   * again at either point would let a tick clear a failure it never saw.
   */
  readonly failedStarts: number;
  /** Whether a person is in this batch. See the classification below. */
  readonly humanRound: boolean;
  /**
   * Whether the pull request is still a draft.
   *
   * Read once, in the survey, and carried rather than asked again — because the
   * one thing it is used for is *not* re-marking a pull request ready that
   * already is. See `undraft`.
   */
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
 * Everything that can be decided about a pull request without a checkout.
 *
 * ## Which is nearly all of it, and that was not obvious
 *
 * Every read here is `gh` naming its repository explicitly — `--repo
 * owner/name` for `pr view` and `pr ready`, owner and name as separate GraphQL
 * variables for the threads — so none of them care what directory they run in.
 * The checkout was never needed to *look*; it was needed to run the pass, which
 * is the last thing to happen and the only expensive one. `advance` simply had
 * them in the wrong order, which cost nothing while a person was typing the
 * command once every two minutes and costs a fetch per pull request per tick
 * the moment a loop is doing it.
 *
 * So the survey ends at the point where money starts: it decides, it undrafts if
 * the answer is a handover, and it stops immediately before the reservation.
 * **The reservation stays on the far side of the checkout on purpose.** It is a
 * spend brake that has to be written before the pass runs and after the round is
 * certain to run — reserving here and then failing to attach would spend a round
 * on a pull request nothing had touched.
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

  /**
   * How long the pull request has been quiet, and the marker is not in it.
   *
   * `lastRead` looks like it belongs here and is redundant: it is always some
   * entry's own `createdAt`, or an older mark, so it can never be newer than
   * `newestAt`. Adding it would read as a third source and contribute nothing,
   * which is worse than leaving it out.
   */
  const quietMs = quietFor(request.now ?? Date.now(), [review.createdAt, review.newestAt]);

  // "Has anyone actionable spoken", not "has the reviewer spoken". A human who
  // comments before the bot reviewer does was always collected and was thrown
  // away here, by a gate asking a narrower question than the list behind it
  // answered.
  if (!review.anyoneResponded) {
    return settled({ kind: "waiting", quietMs });
  }

  // The inline comments, over the transport that can reach them. A failure here
  // is a failure of the round and not a shrug: `readReviewThreads` refuses
  // rather than returning a short list precisely so this call site cannot carry
  // on with half a review, resolve what it did see, and undraft.
  const inline = await readReviewThreads(commands, gh);
  if (inline.outcome === "failed") {
    return settled({ kind: "failed", stage: "read", reason: inline.reason });
  }
  const threads = unansweredThreads(inline.threads);

  // The marker is read before anything else is decided, because everything else
  // is decided from it: how many rounds this pull request has already cost, and
  // which of the comments below have already been answered.
  const located = findMarker(review.comments);
  if (located.outcome === "unusable") {
    return settled(cursorFailed(located.reason));
  }
  const previous = located.outcome === "found" ? parseMarker(located.comment.body) : null;
  if (previous?.outcome === "unreadable") {
    // Not zero. The whole point of the marker is that losing the count releases
    // the brake, so an unreadable one stops the round and says why.
    return settled(
      cursorFailed(`the marker on #${String(number)} will not parse — ${previous.reason}`),
    );
  }
  const marker = previous?.outcome === "parsed" ? previous.marker : null;
  const round = marker?.count ?? 0;
  const reviewerRound = marker?.reviewerCount ?? 0;
  const failedStarts = marker?.failedStarts ?? 0;

  /**
   * Hands the pull request to a human, if it is not already in their hands.
   *
   * **The `isDraft` check is not an optimisation.** Undrafting used to be
   * unconditional, which was invisible while `advance` ran once per command and
   * the chain stopped at the first handover: the second `gh pr ready` never
   * happened because nothing looked again. A poll cycle *does* look again — a
   * pull request that is out of draft and waiting for a person to merge it
   * returns here on every tick — so unconditional meant a write per pull request
   * per minute, forever, saying nothing and each one a chance to fail.
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
    return settled(await undraft({ kind: "ready", rounds: round }));
  }

  const unresolved = (): string =>
    [
      ...comments.map((comment) => comment.body),
      ...threads.map((thread) => threadLine(thread)),
    ].join("\n\n");

  if (round >= maxTotalRounds) {
    // Checked before the reviewer's own cap, because it outranks it: a policy
    // change to `maxRounds` must not be able to step past the brake. It counts
    // human rounds too, for the same reason — the brake is on the machinery,
    // and one a person's comment could step past is not a brake. Nothing is
    // undrafted; see the outcome's doc comment.
    logger.error("solve.review.capped", { issueKey, number, rounds: round });
    return settled({ kind: "capped", rounds: round, unresolved: unresolved() });
  }

  // **A mixed batch is a human round**, and the asymmetry is the argument. The
  // alternative refuses a person's request because a bot happened to comment in
  // the same window: over-counting silently declines work a human asked for,
  // under-counting spends one more round. Only one of those is recoverable by
  // the person who notices.
  //
  // A thread's origin is its *first* comment's, since that is who raised the
  // point the round is being asked to answer. Later replies on the thread are
  // the argument about it, and ours are already filtered out upstream.
  const humanRound =
    comments.some((comment) => comment.origin === "human") ||
    threads.some((thread) => thread.comments[0]?.origin === "human");

  if (!humanRound && reviewerRound >= maxRounds) {
    // Undrafted, and the loop keeps listening. The reviewer has run out of
    // turns; a person has not, so this is checked only when the batch is
    // reviewer-only. A human comment arriving after this runs a round as
    // normal, which is what stops `MAX_REVIEW_ITERATIONS` from becoming the bot
    // telling a reviewer it is out of turns.
    logger.warn("solve.review.reviewer_exhausted", {
      issueKey,
      number,
      rounds: round,
      reviewerRounds: reviewerRound,
    });
    return settled(
      await undraft({ kind: "reviewer-exhausted", rounds: round, unresolved: unresolved() }),
    );
  }

  // **Last, because it bounds attempts to start a round and this is the only
  // path that attempts one.** Every return above either needs no checkout
  // (`ready` and `reviewer-exhausted` undraft over `gh` alone) or has already
  // stopped for a better reason, so checking earlier would report a stall on
  // ticks that were never going to attach — and would stop a pull request from
  // being undrafted by the one outcome that can still do it for free.
  if (failedStarts >= maxFailedStarts) {
    logger.error("solve.review.stalled", {
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
 * Looks once at the review and moves the pull request forward if it can.
 *
 * Returns rather than waits. See the header.
 *
 * Three steps, and the middle one is the change: survey with no checkout, cut a
 * checkout only if the survey found work, then run the round. A pull request
 * nobody has commented on costs two `gh` reads and nothing else — no fetch, no
 * `worktree add`, no install — which is what makes looking at every watched pull
 * request every minute a reasonable thing to do.
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
    // Before the reservation, so no *round* has been counted. The pull request
    // is exactly as the survey found it and the next look will decide the same
    // thing again, which is the right behaviour for a checkout that failed for
    // a local reason — right once, and a wedge if it is right forever. So the
    // attempt is counted even though the round is not, which is the only
    // counting that happens on this side of the reservation.
    return await recordFailedStart(deps.commands, request, surveyed.pending, attached.reason);
  }
  if (attached.outcome === "conflicted") {
    return await runMergeRound(deps, request, attached, surveyed.pending);
  }

  return runRound(deps, request, attached.worktree, surveyed.pending);
}

/**
 * Spends a round on the merge instead of on the review.
 *
 * The reservation is written first, exactly as `runRound` writes it and for the
 * same reason: the brake has to fail closed, so a marker that will not update
 * means no pass runs. Two differences, and both are about what a merge is not.
 *
 * **The reviewer's count does not move.** `MAX_REVIEW_ITERATIONS` bounds an
 * argument between two machines; this round is not part of that argument and
 * spending it would tell a reviewer the loop was out of turns because a base
 * moved. `MAX_PR_ROUNDS_TOTAL` *does* count it, because that one is a brake on
 * the machinery and a merge round costs money like any other.
 *
 * **The high-water mark does not move.** Nothing here reads a comment, so
 * advancing it would mark feedback as handled by a round that never looked at
 * it — the reviewer's point would be silently dropped and the pull request
 * would look answered. Leaving it is what makes the next tick come back to it.
 *
 * The cheap outcomes (`current`, `merged`) still cost a reservation, which is
 * deliberate: the alternative is deciding whether to reserve by first running
 * the thing the reservation is meant to gate. Over-counting a spend brake makes
 * a loop stop early; under-counting one makes it never stop.
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

  const reserved = await reserve(commands, {
    worktreePath: conflict.worktree.path,
    repo,
    number,
    timeoutMs: request.ghTimeoutMs,
    marker: {
      count: round + 1,
      reviewerCount: reviewerRound,
      failedStarts: 0,
      lastRead: marker?.lastRead ?? NEVER_READ,
      rounds: [
        ...(marker?.rounds ?? []),
        `round ${String(round + 1)} — merge, ${String(conflict.behind)} commit(s) behind ${request.baseRef} and conflicting in ${conflict.files.join(", ")}`,
      ],
    },
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
  const synced = (behind: number, conflicts: readonly string[]): AdvanceOutcome => ({
    kind: "synced",
    round: round + 1,
    behind,
    conflicts,
  });

  switch (resolved.kind) {
    case "current": {
      // The base moved between the attach and here, so there was nothing left
      // to merge. Reported as a sync of zero commits rather than as a failure:
      // the branch is current, which is the state this round exists to reach.
      return synced(0, []);
    }
    case "merged": {
      return synced(resolved.behind, []);
    }
    case "resolved": {
      logger.info("solve.review.merged", {
        issueKey,
        number,
        round: round + 1,
        behind: resolved.behind,
        files: resolved.report.resolutions.map((resolution) => resolution.path),
      });
      return synced(
        resolved.behind,
        resolved.report.resolutions.map((resolution) => resolution.path),
      );
    }
    case "abandoned": {
      return { kind: "abandoned", reason: resolved.reason };
    }
    case "failed": {
      // The merge resolved and the result is red. `refused` rather than
      // `failed`, on the same rule the review round uses: the steps ran and
      // gave an answer, and the answer is that this must not be pushed.
      return { kind: "refused", stage: "verification", reasons: [resolved.reason] };
    }
    default: {
      return { kind: "failed", stage: "merge", reason: resolved.reason };
    }
  }
}

/**
 * Spends the round the survey decided on.
 *
 * Everything from here needs the checkout: the reservation is the last thing
 * before the pass, and the pass, the commit and the push all run in it.
 *
 * **Exported for the cycle, which cannot use `advance`.** `advance` fuses the
 * survey and the round into one call, which is right for one ticket and wrong
 * for a set: a cycle has to look at every watched pull request and then spend on
 * only the few with work, so its bound is counted between the two halves. A
 * caller that reached for `advance` per ticket would bound the *looks* instead,
 * and the first merged pull request past the bound would go unnoticed for as
 * long as the bound kept being reached. See `review-cycle.ts`.
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
        issueKey,
        number,
        round,
        reason: asked.reason,
      });
      return "failed";
    }
    return "asked";
  };

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
      // The half of the reservation that human feedback does not move. Both
      // numbers are written together, so a round can never advance one and lose
      // the other to a second failed write.
      reviewerCount: humanRound ? reviewerRound : reviewerRound + 1,
      // **Reaching here is the reset.** A reservation is proof that the
      // machinery works on this pull request right now — the checkout was cut
      // and the marker is writable — so the failures that came before it are
      // history rather than a trend, and carrying them forward would stall a
      // pull request that had recovered. The bound is on *consecutive* failed
      // starts for the same reason `MAX_REVIEW_WAITS` counts consecutive waits:
      // a slow start and a stuck one differ only in whether one ever succeeds.
      failedStarts: 0,
      lastRead: newestOf(comments, marker?.lastRead ?? NEVER_READ),
      rounds: [
        ...(marker?.rounds ?? []),
        `round ${String(round + 1)} — ${humanRound ? "human" : "reviewer"}, reading ${String(comments.length)} comment(s) and ${String(threads.length)} thread(s)`,
      ],
    },
    ...(pending.markerId === null ? {} : { commentId: pending.markerId }),
  });
  if (reserved.outcome === "failed") {
    return cursorFailed(`the round was not reserved, so it did not run — ${reserved.reason}`);
  }

  const resolved = await resolveReview(deps, {
    ...request,
    worktree,
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

  /**
   * Puts the round's answer to the review bodies on the pull request.
   *
   * Only when there was feedback with no thread to reply to. A round whose
   * input was entirely inline has already answered in the right place, and a
   * summary comment restating it is the bot chatter §6.3 refuses to add.
   *
   * The `bot: ` prefix is not decoration. `reviewerComments` drops our own by
   * that prefix — there is no login to key on, since `gh` posts as the operator
   * — so a comment written without it is read back next round as a reviewer
   * asking for something, and the loop argues with itself. It is deliberately
   * not the marker's prefix, which is longer and matched separately.
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
   * Takes the pull request out of draft when the round has nothing left to do.
   *
   * Gated on the answer being *visible*, not merely produced. Undrafting hands
   * the pull request to a human, and doing that while the round's reply sits in
   * a terminal — or failed to post — shows them a reviewer's objection with no
   * answer next to it, which is the state round 3 of #2658 would have created.
   */
  const leaveDraft = async (spoken: Spoken, posted: ThreadOutcome): Promise<Undraft> => {
    if (spoken.outcome === "failed" || posted.failures.length > 0) {
      return "still-drafting";
    }
    // Already out of draft — a round after an earlier handover, which is the
    // ordinary case once a human is commenting on an undrafted pull request.
    // `undrafted` rather than a fourth state: the fact the caller acts on is
    // where the pull request *is*, and marking a ready pull request ready again
    // is a write that can only fail.
    if (!pending.isDraft) {
      return "undrafted";
    }
    const marked = await markReady(commands, gh);
    return marked.outcome === "failed" ? "failed" : "undrafted";
  };

  if (resolved.kind === "no-change") {
    // Questions answered, no code touched. The replies still go out: a round
    // that answered without editing has answered, and its argument belongs next
    // to the comment it answers rather than only in a terminal.
    //
    // Then the pull request leaves draft. This side is finished with it: there
    // is nothing for the reviewer to re-read and nothing more this loop can do,
    // so the flag saying otherwise is just wrong. See `Undraft` for why waiting
    // for a later tick to clear it is not a reliable substitute.
    const threadOutcome = await answer();
    const spoken = await say();
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
  const spoken = await say();
  const pushed = committed.outcome === "committed";
  const reviewerRequested = await reRequest(pushed);
  return {
    kind: "iterated",
    round: round + 1,
    responses: resolved.report.responses,
    reviewerRequested,
    spoken,
    // A round with a commit on it stays a draft even though it is the same
    // `iterated` kind: the reviewer has something new to read, and undrafting
    // now would put a half-answered pull request in front of a human.
    undrafted: pushed ? "still-drafting" : await leaveDraft(spoken, threadOutcome),
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
