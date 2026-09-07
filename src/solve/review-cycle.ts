/**
 * One pass over every pull request this service is still watching.
 *
 * `advance` answers "what should happen to this pull request"; this answers
 * "which pull requests should I ask that about". It is the review half of the
 * daemon's tick, written so that it can be driven by hand first — the same
 * ordering rule every other phase followed.
 *
 * ## The rule the whole file is built on
 *
 * **Cadence is set by the cheap read; the expensive action is gated by a
 * change-detector that lives in the remote system.**
 *
 * The cheap read is `look`: two `gh` calls that name their own repository, so
 * they need no checkout, no fetch and no install. A pull request nobody has
 * commented on costs exactly that and stops. The expensive action is `act`: a
 * worktree, an install, a model pass, a push — the thing measured at $0.94 a
 * round. Splitting them is what makes looking at every watched pull request
 * every minute a reasonable thing to do rather than an invoice.
 *
 * The change-detector is the pull request itself. Nothing here remembers what it
 * saw last tick: the marker comment carries the round counts and the high-water
 * mark, the pull request's own timestamps carry the silence clock, and the
 * ticket's labels carry the subscription. That is §1's rule — state in the
 * remote system, not on disk — applied to the one loop that spends the most
 * money per mistake. A cursor in `state/` would reintroduce every failure §1
 * avoided, and losing it *releases* a spend brake rather than tightening one.
 *
 * ## Three consequences worth naming, because each is a bug avoided
 *
 * **One unreadable pull request must not end the cycle.** `look` shells out, and
 * a repository that was renamed, a pull request that was deleted, or a `gh`
 * that timed out is a fact about one ticket. Nineteen healthy pull requests
 * going unlooked-at because the twentieth is broken is a much worse failure than
 * the one that caused it, and it is silent — the cycle just does less each tick.
 * So every look is caught, recorded with its reason, and the loop continues.
 *
 * **A cycle may act a bounded number of times.** `maxRounds` is not
 * `MAX_CONCURRENT_SOLVES` and is not `MAX_PR_ROUNDS_TOTAL`. Those bound one
 * ticket's whole life; this bounds one *tick*. Without it, a reviewer that
 * answered twenty pull requests while the machine was asleep produces twenty
 * paid rounds in the first tick after it wakes, which is the largest single
 * spend this service can make and the one nobody would be watching. Tickets
 * over the bound are **deferred, not skipped**: they are still actionable, the
 * next tick takes them, and because the queue is ordered oldest-updated first
 * the same one cannot be starved twice.
 *
 * **The bound is counted against rounds, not against looks.** Every watched
 * ticket is looked at every tick regardless, because a look is what notices a
 * pull request was merged — and a merged pull request left unnoticed keeps its
 * `agent:review-done` label, stays in this query, and is looked at forever.
 *
 * **The cycle's log line is the daemon's only record, so it carries what
 * happened and not how many times something happened.** Written after the round
 * on PR #2663, which returned an early non-success 144 ms after the pass and
 * left no trace of which one. This line said `acted: ["SSX-3835"]` and threw the
 * `AdvanceOutcome` away, and `settled` and `unlooked` were bare counts, so a
 * $2.02 round was unattributable after the fact from three reductions in one
 * statement.
 *
 * **The other channel does not cover it either, which is why this line is the
 * fix rather than a second one.** `runReviewSweep` does read the returned
 * outcome — the terminal labels are written from it — but the *report*,
 * `describeReviewSweep`, is printed by `--watch` and never by the daemon. And
 * even that would not have named this round's arm: it renders `acted` as
 * `entry.outcome.kind` alone and `settled` as a count, so it says `abandoned`
 * without the reason and hides a settle that is no longer `waiting`. It carries
 * the full text of an `unlooked`, under a comment making exactly this argument
 * about exactly that field. The argument was right and was applied to one of
 * four.
 *
 * Every arm here logs its discriminating detail, and none of it is truncated:
 * `shorten` exists for text going somewhere it has to fit, and its own argument
 * is that the full version is in the log — which makes shortening *here* the one
 * place that claim stops being true.
 *
 * ## What it deliberately does not do
 *
 * It does not claim, solve, or open anything. The set it reads is the set that
 * already has a pull request, and the only thing it can do to a member of that
 * set is one review round. Starting new work is the other half of the daemon's
 * tick and is deliberately a different function, running after this one, so a
 * board full of review work cannot be interrupted by a new claim halfway
 * through.
 */

import { logger } from "../logger.ts";
import type { AdvanceOutcome, PendingRound } from "./delivery.ts";

/**
 * A ticket carrying `agent:reviewing` or `agent:review-done`.
 *
 * Its own type rather than `SolveCandidate` for the reason `SolveCandidate` is
 * not `TicketRef`: the two queues select on different facts and a shared type
 * would carry a field one of them must never read. This one has a pull request
 * behind it and no claim to make; the solve queue is the mirror image.
 */
export interface WatchedTicket {
  readonly key: string;
  readonly summary: string;
  readonly url: string;
  /** Every label live on the ticket. Which of the two is on it decides nothing here. */
  readonly labels: readonly string[];
  /** ISO-8601 with offset, as Jira returns it. Only used for ordering. */
  readonly updated: string;
}

/**
 * What one cheap look concluded.
 *
 * The three arms are the three things that can be true of a watched ticket, and
 * they are kept apart because they call for three different responses: nothing,
 * a note to a human, and a paid round.
 */
export type ReviewLook =
  /**
   * There is no pull request to look at.
   *
   * Not an error, and not a terminal either. A ticket can carry the label with
   * no pull request behind it for reasons that are all somebody else's — a
   * branch deleted by hand, a repository renamed, a label added by a person who
   * meant something by it. The honest response is to say so once per cycle and
   * change nothing, because every write available here is wrong: labelling it
   * `agent:closed` asserts a pull request was declined, and clearing the label
   * silently drops a ticket somebody put on this list.
   */
  | { readonly outcome: "no-pull-request"; readonly reason: string }
  /**
   * The pull request's life is over, and this ticket should leave the set.
   *
   * Reported rather than acted on. Writing `agent:done` or `agent:closed` is a
   * label edit, and this module writes nothing — the same refusal
   * `runSolveCycle` makes and for the same reason: the write is a visible change
   * to an interface a reviewer would look at, not a line inside a loop. The
   * caller composing `look` and `act` already holds the label path.
   *
   * It is separate from `settled` because it is not an `AdvanceOutcome` at all.
   * A merged pull request never reaches `advance`; `findPullRequest` answers it
   * from `state`, which is why this arm carries that word verbatim rather than a
   * kind invented here.
   */
  | { readonly outcome: "ended"; readonly number: number; readonly state: "MERGED" | "CLOSED" }
  /** The look reached a final answer with no checkout behind it. */
  | { readonly outcome: "settled"; readonly number: number; readonly result: AdvanceOutcome }
  /** There is work. Only this arm costs anything to answer. */
  | { readonly outcome: "round"; readonly number: number; readonly pending: PendingRound };

export interface ReviewCycleDeps {
  /**
   * `SOLVE_ENABLED`, checked here as well as wherever the cycle is composed.
   *
   * Twice, for the reason `SolveDeps` gives: a loop that is safe only because
   * its caller remembers not to call it is one careless wiring change away from
   * running unattended, and the wiring is the part of this service most likely
   * to be edited by someone thinking about something else.
   */
  readonly enabled: boolean;
  /** The watched set, oldest-updated first — though this module re-sorts anyway. */
  readonly fetchWatched: () => Promise<readonly WatchedTicket[]>;
  /**
   * The cheap half: find the pull request and survey it, no checkout.
   *
   * Allowed to reject. A rejected promise is one ticket's problem and is caught
   * below; it must not be the cycle's.
   */
  readonly look: (ticket: WatchedTicket) => Promise<ReviewLook>;
  /**
   * The expensive half, called only for the `round` arm.
   *
   * Separate from `look` in the dependency list and not just in the flow, so
   * that a test can count how many times money would have been spent without
   * needing a worktree, and so a caller composing this cannot accidentally do
   * the expensive thing first.
   */
  readonly act: (
    ticket: WatchedTicket,
    pending: PendingRound,
    number: number,
  ) => Promise<AdvanceOutcome>;
  /**
   * How many tickets one cycle may run a round for. See the header.
   *
   * Zero is meaningful and is not a mistake: look at everything, act on nothing.
   * That is the dry run for this cycle, and it is the honest one — a review
   * round's whole effect is on a pull request, so "report what you would do" is
   * exactly "do the reads and stop before the spend".
   */
  readonly maxRounds: number;
  /** Aborted to request a graceful stop; checked between tickets. */
  readonly signal?: AbortSignal;
  /**
   * The query this cycle read, verbatim, for a report.
   *
   * Unused by the logic, and optional for the same reason `SolveDeps.queueJql`
   * is: a hand-built fake has no query behind it, and absent means "these deps
   * were not composed from settings", which is the truth in a test and never
   * the truth in a wiring function.
   */
  readonly watchJql?: string;
}

/**
 * What one review round was measured to cost, in dollars.
 *
 * PR #2658, 22 turns, 148 seconds, 639k cache-read tokens. It is here rather
 * than at the two places that print it because those two are a hand-driven
 * command and an unattended daemon, and a number that tells an operator how much
 * a tick may spend is exactly the kind of thing that gets updated in one of them.
 *
 * It is an order of magnitude, not a price. A round that pushes nothing is
 * cheaper and a long argument is dearer; what it is for is putting a figure in
 * front of whoever is about to leave this running.
 */
export const REVIEW_ROUND_USD = 0.94;

/** A ticket a round was actually run for. */
export interface ActedReview {
  readonly issueKey: string;
  readonly number: number;
  readonly outcome: AdvanceOutcome;
}

/** A ticket the look settled without spending anything. */
export interface SettledReview {
  readonly issueKey: string;
  readonly number: number;
  readonly outcome: AdvanceOutcome;
}

/** A ticket whose pull request has been merged or closed. */
export interface EndedReview {
  readonly issueKey: string;
  readonly number: number;
  readonly state: "MERGED" | "CLOSED";
}

/** A ticket the cycle could not look at, or found no pull request for. */
export interface UnlookedReview {
  readonly issueKey: string;
  readonly reason: string;
}

export interface ReviewCycleOutcome {
  /** Every ticket the query returned. */
  readonly watched: number;
  readonly acted: readonly ActedReview[];
  readonly settled: readonly SettledReview[];
  /** The caller writes the terminal label for these; see `ReviewLook`. */
  readonly ended: readonly EndedReview[];
  readonly unlooked: readonly UnlookedReview[];
  /** Actionable, but over `maxRounds` or interrupted. The next tick takes them. */
  readonly deferred: readonly string[];
}

const NOTHING: ReviewCycleOutcome = {
  watched: 0,
  acted: [],
  settled: [],
  ended: [],
  unlooked: [],
  deferred: [],
};

/**
 * One `AdvanceOutcome` as one line, for the log the header describes.
 *
 * Deliberately a `switch` over `kind` rather than `JSON.stringify(outcome)`.
 * Two of these arms carry a whole model pass — `iterated` holds `responses`,
 * `threads` and `unresolved` — and a line that dumped them would be unreadable
 * in exactly the situation it exists for, which is a person scrolling a
 * daemon's log at midnight asking why a round did nothing. What each arm needs
 * is the field that *discriminates within* it: the stage a failure reached, the
 * reason an abandon gave, whether an iteration pushed. Everything else is on
 * the pull request.
 *
 * Exhaustive with no `default`, so an outcome added to the union is a type
 * error here rather than a round that logs `undefined`. That is the same
 * argument `chainDecision`'s stopping `default` makes from the other side: a
 * new arm must be argued about, not defaulted.
 */
export function outcomeNote(outcome: AdvanceOutcome): string {
  switch (outcome.kind) {
    case "waiting":
      return `waiting quiet=${outcome.quietMs === null ? "unknown" : `${String(outcome.quietMs)}ms`}`;
    case "ready":
      return `ready rounds=${String(outcome.rounds)}`;
    case "iterated":
      return `iterated round=${String(outcome.round)} pushed=${String(outcome.pushed)} spoken=${outcome.spoken.outcome} undrafted=${outcome.undrafted} reviewer=${outcome.reviewerRequested}`;
    case "reviewer-exhausted":
      return `reviewer-exhausted rounds=${String(outcome.rounds)} unresolved=${outcome.unresolved}`;
    case "capped":
      return `capped rounds=${String(outcome.rounds)} unresolved=${outcome.unresolved}`;
    case "stalled":
      return `stalled attempts=${String(outcome.attempts)}: ${outcome.reason}`;
    case "synced":
      return `synced round=${String(outcome.round)} behind=${String(outcome.behind)} conflicts=${outcome.conflicts.length === 0 ? "none" : outcome.conflicts.join(",")}`;
    case "abandoned":
      return `abandoned: ${outcome.reason}`;
    case "refused":
      return `refused at ${outcome.stage}: ${outcome.reasons.join("; ")}`;
    case "failed":
      return `failed at ${outcome.stage}: ${outcome.reason}`;
  }
}

/** A ticket and the verdict it reached, in the shape the log line wants. */
function noteFor(entry: ActedReview | SettledReview): string {
  return `${entry.issueKey} #${String(entry.number)} ${outcomeNote(entry.outcome)}`;
}

/**
 * Does this settle recur forever, or has something happened?
 *
 * `waiting` and `ready` are the two arms a healthy pull request sits in for
 * days: nobody has replied yet, or it is out of draft with a human holding it.
 * Both are true again on the next tick and the one after. Every other arm is a
 * round that reached a verdict, and a verdict is news exactly once.
 *
 * Exhaustive with no `default`, for the reason `outcomeNote` gives above: an
 * arm added to the union must be argued into one pile or the other. Defaulting
 * it to quiet would be the dangerous direction — a new terminal outcome would
 * arrive marked as nothing having happened.
 */
function settleIsQuiet(outcome: AdvanceOutcome): boolean {
  switch (outcome.kind) {
    case "waiting":
    case "ready":
      return true;
    case "iterated":
    case "reviewer-exhausted":
    case "capped":
    // Loud, and it is the arm where that matters most. A stall repeats on every
    // tick exactly as `waiting` does, so the recurrence argument above would
    // file it as quiet — and the whole reason the outcome exists is that a
    // wedged pull request went four days without anything saying so. It is the
    // one settle that both recurs forever and is news, so the rule bends here
    // rather than being restated: a bound firing is reported the first time and
    // every time, because the alternative is the silence it was built to break.
    case "stalled":
    case "abandoned":
    case "refused":
    case "failed":
    // Loud, and it is a commit on somebody's branch: a merge the bot made and
    // pushed while a reviewer was reading. It also does not recur — the branch
    // is current afterwards — so filing it as quiet would hide the one round
    // that changed the pull request without answering anybody.
    case "synced":
      return false;
  }
}

/**
 * Did this cycle do anything worth a person's attention?
 *
 * Exported because it decides the ⏳/🔧 mark on the single line this service
 * writes most often, and a rule that decides what a human sees is a rule that
 * gets a test.
 *
 * Note what it does **not** read: `watched`. A cycle watching five quiet pull
 * requests is the normal state of a healthy queue, and marking it as news
 * because it looked at something would mark every tick as news — which is the
 * mark meaning nothing at all.
 */
export function isQuietCycle(outcome: ReviewCycleOutcome): boolean {
  return (
    outcome.acted.length === 0 &&
    outcome.ended.length === 0 &&
    outcome.unlooked.length === 0 &&
    outcome.deferred.length === 0 &&
    outcome.settled.every((entry) => settleIsQuiet(entry.outcome))
  );
}

/** Oldest touched first, so the same pull request cannot be starved twice. */
function byUpdatedAscending(a: WatchedTicket, b: WatchedTicket): number {
  return Date.parse(a.updated) - Date.parse(b.updated);
}

function stopRequested(signal: AbortSignal | undefined): boolean {
  if (signal?.aborted !== true) {
    return false;
  }
  logger.info("review.cycle.stopped", { note: "abort requested; the rest of the set waits" });
  return true;
}

/** The message off an unknown throw, without asserting it was an `Error`. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runReviewCycle(deps: ReviewCycleDeps): Promise<ReviewCycleOutcome> {
  if (!deps.enabled) {
    logger.info("review.disabled", {
      note: "SOLVE_ENABLED is off; the watched set was not read",
    });
    return NOTHING;
  }

  if (stopRequested(deps.signal)) {
    return NOTHING;
  }

  const tickets = (await deps.fetchWatched()).toSorted(byUpdatedAscending);

  const acted: ActedReview[] = [];
  const settled: SettledReview[] = [];
  const ended: EndedReview[] = [];
  const unlooked: UnlookedReview[] = [];
  const deferred: string[] = [];

  for (const ticket of tickets) {
    // Deliberately not `stopRequested` before the look. A look is two reads and
    // no writes, and stopping before them buys nothing while losing the one
    // thing this cycle exists to notice.
    let look: ReviewLook;
    try {
      look = await deps.look(ticket);
    } catch (error) {
      unlooked.push({ issueKey: ticket.key, reason: reasonOf(error) });
      continue;
    }

    if (look.outcome === "no-pull-request") {
      unlooked.push({ issueKey: ticket.key, reason: look.reason });
      continue;
    }

    if (look.outcome === "ended") {
      ended.push({ issueKey: ticket.key, number: look.number, state: look.state });
      continue;
    }

    if (look.outcome === "settled") {
      settled.push({ issueKey: ticket.key, number: look.number, outcome: look.result });
      continue;
    }

    // The bound is checked here and not at the top of the loop, so a cycle at
    // its limit still looks at the rest of the set and still notices a merge.
    if (acted.length >= deps.maxRounds || stopRequested(deps.signal)) {
      deferred.push(ticket.key);
      continue;
    }

    try {
      acted.push({
        issueKey: ticket.key,
        number: look.number,
        outcome: await deps.act(ticket, look.pending, look.number),
      });
    } catch (error) {
      // A round that threw has still spent whatever it spent — the reservation
      // is written before the pass runs, on purpose — so this is reported and
      // never retried inside the same cycle.
      unlooked.push({ issueKey: ticket.key, reason: reasonOf(error) });
    }
  }

  const outcome: ReviewCycleOutcome = {
    watched: tickets.length,
    acted,
    settled,
    ended,
    unlooked,
    deferred,
  };

  logger.info(
    "review.cycle",
    {
      watched: outcome.watched,
      acted: acted.map(noteFor),
      // Not a count. A settle is `waiting` on almost every tick, which is why
      // this was one — but the arms that are not `waiting` are a finished round
      // that cost nothing, and hiding those behind a number hides the difference
      // between a quiet pull request and one nothing will ever act on again.
      settled: settled.map(noteFor),
      ended: ended.map((entry) => `${entry.issueKey} ${entry.state}`),
      unlooked: unlooked.map((entry) => `${entry.issueKey} ${entry.reason}`),
      deferred,
    },
    // Built from the outcome rather than from the six locals, so the mark and
    // the fields cannot describe two different cycles.
    { quiet: isQuietCycle(outcome) },
  );

  return outcome;
}
