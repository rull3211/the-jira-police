/**
 * One pass over every pull request this service is still watching.
 *
 * `advance` answers "what should happen to this pull request"; this answers
 * "which pull requests should I ask that about". Cadence is set by the cheap
 * read (`look`, two `gh` calls); the expensive action (`act`: worktree,
 * install, model pass, push) runs only for a `round` verdict.
 *
 * Nothing here remembers a prior tick: the marker comment, the pull
 * request's own timestamps, and the ticket's labels carry all of it, per
 * §1's rule against state on disk.
 *
 * One unreadable pull request must not end the cycle — every `look` is
 * caught and recorded with its reason, and the loop continues.
 *
 * `maxRounds` bounds one tick, not one ticket's life (unlike
 * `MAX_CONCURRENT_SOLVES` / `MAX_PR_ROUNDS_TOTAL`): without it, a reviewer
 * answering many pull requests while the machine slept would trigger that
 * many paid rounds on the first tick after. Tickets over the bound are
 * deferred, not skipped, and every ticket is still looked at every tick so a
 * merge is never missed.
 *
 * It does not claim, solve, or open anything — starting new work is a
 * separate function that runs after this one, so a board full of review
 * work cannot be interrupted by a new claim mid-cycle.
 */

import { logger } from "../logger.ts";
import type { AdvanceOutcome, PendingRound } from "./delivery.ts";

/** A ticket carrying `agent:reviewing` or `agent:review-done`; kept distinct from `SolveCandidate` so neither type carries a field the other must never read. */
export interface WatchedTicket {
  readonly key: string;
  readonly summary: string;
  readonly url: string;
  /** Every label live on the ticket. Which of the two is on it decides nothing here. */
  readonly labels: readonly string[];
  /** ISO-8601 with offset, as Jira returns it. Only used for ordering. */
  readonly updated: string;
}

/** What one cheap look concluded: nothing, a note to a human, or a paid round. */
export type ReviewLook =
  /** No pull request behind the label; not an error, so nothing is written — every write available here would assert something false. */
  | { readonly outcome: "no-pull-request"; readonly reason: string }
  /** The pull request's life is over; reported, not acted on — this module writes no labels, that's the caller's job. */
  | { readonly outcome: "ended"; readonly number: number; readonly state: "MERGED" | "CLOSED" }
  /** The look reached a final answer with no checkout behind it. */
  | { readonly outcome: "settled"; readonly number: number; readonly result: AdvanceOutcome }
  /** There is work. Only this arm costs anything to answer. */
  | { readonly outcome: "round"; readonly number: number; readonly pending: PendingRound };

export interface ReviewCycleDeps {
  /** `SOLVE_ENABLED`, checked here as well as wherever the cycle is composed — a safety that relies only on the caller remembering is one wiring change from running unattended. */
  readonly enabled: boolean;
  /** The watched set, oldest-updated first — though this module re-sorts anyway. */
  readonly fetchWatched: () => Promise<readonly WatchedTicket[]>;
  /** The cheap half: find the pull request and survey it, no checkout. May reject; that's one ticket's problem, caught below. */
  readonly look: (ticket: WatchedTicket) => Promise<ReviewLook>;
  /** The expensive half, called only for the `round` arm; kept separate from `look` so a caller can't accidentally do the expensive thing first. */
  readonly act: (
    ticket: WatchedTicket,
    pending: PendingRound,
    number: number,
  ) => Promise<AdvanceOutcome>;
  /** How many tickets one cycle may run a round for; see the header. Zero is a valid dry run: look at everything, act on nothing. */
  readonly maxRounds: number;
  /** Aborted to request a graceful stop; checked between tickets. */
  readonly signal?: AbortSignal;
  /** The query this cycle read, verbatim, for a report; unused by the logic, absent meaning these deps were not composed from settings. */
  readonly watchJql?: string;
}

/** An order-of-magnitude cost for one review round, in dollars — not a price, just a figure for whoever is about to leave this running. */
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
 * One `AdvanceOutcome` as one log line: the field that discriminates within each arm, not a full dump.
 *
 * No `default` arm — an outcome added to the union is a type error here rather than a round that logs `undefined`.
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
 * Does this settle recur forever (`waiting`, `ready`), or is it news exactly once?
 *
 * No `default`: an arm must be argued into one pile or the other, since defaulting to quiet
 * is the dangerous direction. `stalled` is deliberately loud despite recurring like `waiting` —
 * it exists precisely to end the silence of a wedged pull request going unreported.
 */
function settleIsQuiet(outcome: AdvanceOutcome): boolean {
  switch (outcome.kind) {
    case "waiting":
    case "ready":
      return true;
    case "iterated":
    case "reviewer-exhausted":
    case "capped":
    case "stalled":
    case "abandoned":
    case "refused":
    case "failed":
    case "synced":
      return false;
  }
}

/** Did this cycle do anything worth a person's attention? Deliberately ignores `watched` — a healthy queue looks at things every tick without that being news. */
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
    // Not stopped before the look: it's two reads and no writes, and skipping it loses the one thing this cycle exists to notice.
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

    // Checked after the look, not before it, so a cycle at its limit still notices a merge.
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
      // A round that threw has still spent whatever it spent, so it's reported, never retried in the same cycle.
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
      // Not a count: a settle that isn't `waiting` is a finished round, and a number would hide that from a quiet one.
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
