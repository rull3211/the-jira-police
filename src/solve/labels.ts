/**
 * The solve queue's state machine, as pure functions over a ticket's labels.
 *
 * ```
 * agent:solvable          triage's call; set by the grooming poster
 *    + agent:start        the human go-ahead (manual mode) — the only human step
 *    → agent:solving      claimed; agent:start removed in the same edit
 *    → agent:reviewing    draft PR open, review requested
 *    → agent:done | agent:failed
 * ```
 *
 * The unusual thing about this queue is where its state lives. The new-issue
 * poller dedupes against `state/poll.json`; this one dedupes against the labels
 * on the ticket itself, so the queue survives a restart, a deleted `state/`
 * directory and a second instance running alongside the first — none of which a
 * local file or a lock would give for free. The price is that the labels have
 * to be treated as the real thing rather than as a status display, and that is
 * what this module exists to keep honest.
 *
 * Everything here is pure: it computes edits, it never applies them. Applying
 * one is a Jira write, which belongs to the caller and — in Phase B — to nobody
 * at all. Keeping the arithmetic separate from the write means the transitions
 * can be tested exhaustively without a board to test them against, and it means
 * a reader can see the whole state machine in one file rather than inferring it
 * from the order of some API calls.
 *
 * Two rules that are load-bearing rather than tidy:
 *
 * 1. **The claim is one edit.** `agent:solving` goes on and `agent:start` comes
 *    off together. Split into two writes, the gap between them is a window in
 *    which a second instance sees a ticket that is solvable, started and
 *    unclaimed — which is the definition of a double claim.
 *
 * 2. **`agent:solving` is not removed when review begins.** It is the claim, and
 *    a ticket under review is still claimed. The queue query excludes
 *    `agent:solving`, so dropping it at the review transition would put a
 *    ticket with an open pull request straight back into the queue to be solved
 *    a second time.
 */

import type { SolveMode } from "../settings.ts";

export const AGENT_LABELS = {
  /** Triage's assessment: a coding agent could plausibly fix this. */
  solvable: "agent:solvable",
  /** A human's authorisation. Required in manual mode, single-use. */
  start: "agent:start",
  /** The claim. Written before any work begins; this is what makes the queue idempotent. */
  solving: "agent:solving",
  /** Draft pull request open, review requested. Still claimed. */
  reviewing: "agent:reviewing",
  done: "agent:done",
  failed: "agent:failed",
} as const;

export type AgentLabel = (typeof AGENT_LABELS)[keyof typeof AGENT_LABELS];

/**
 * The labels the queue query excludes, and the reason it can.
 *
 * Exported so `buildSolveQueueJql` and the local eligibility check below cannot
 * name different sets. They are two enforcements of one rule — the query keeps
 * the work off the wire, the predicate keeps it off the wire *and* survives a
 * hand-written query — and a rule enforced twice from two lists is a rule
 * enforced once, badly.
 *
 * `agent:reviewing` is absent on purpose: a ticket under review still carries
 * `agent:solving`, so it is already excluded, and listing it would suggest the
 * two are independent when the whole design rests on them not being.
 */
export const SOLVE_QUEUE_EXCLUDED_LABELS: readonly string[] = [
  AGENT_LABELS.solving,
  AGENT_LABELS.done,
  AGENT_LABELS.failed,
];

/**
 * Labels that make a ticket unclaimable, checked locally.
 *
 * A superset of the query's exclusions, and the extra entry is the point.
 * `agent:reviewing` is redundant *today*, because the review transition keeps
 * `agent:solving`. If someone later decides that reviewing should replace
 * solving rather than accompany it, this list is what stops that change from
 * silently becoming a double-solve bug; the query alone would not.
 */
const CLAIM_BLOCKING_LABELS: readonly string[] = [
  AGENT_LABELS.solving,
  AGENT_LABELS.reviewing,
  AGENT_LABELS.done,
  AGENT_LABELS.failed,
];

/** A label delta, in §11's shape: applied against what is live, never a replacement set. */
export interface LabelEdit {
  readonly add: readonly string[];
  readonly remove: readonly string[];
}

export class LabelStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabelStateError";
  }
}

/**
 * Builds an edit, refusing one that both adds and removes the same label.
 *
 * Jira applies a union and a subtraction in an order this service does not
 * control, so such an edit has two possible outcomes and no way to say which
 * was meant. Since the entire idempotency of the queue rests on reading a
 * ticket's labels back and getting the state the last edit intended, an
 * ambiguous edit is not a cosmetic problem — it is the one write that can leave
 * the machine in a state no transition produced.
 */
export function labelEdit(add: readonly string[], remove: readonly string[]): LabelEdit {
  const removing = new Set(remove);
  const contradictions = add.filter((label) => removing.has(label));
  if (contradictions.length > 0) {
    throw new LabelStateError(
      `label edit both adds and removes ${contradictions.join(", ")}, and Jira does not define which wins`,
    );
  }
  return { add, remove };
}

export type Eligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: string };

/**
 * Whether a ticket may be claimed, given its labels and the mode.
 *
 * Re-checks locally what the JQL already filtered for. That is not redundancy
 * for its own sake: the query is a string sent to a service that resolves
 * `labels NOT IN (...)` by rules with at least one documented surprise in them
 * (an empty `labels` field matches nothing), and this module's callers are also
 * free to hand it a ticket that came from somewhere else entirely — a retry, a
 * CLI, a test. The predicate is the thing that decides; the query is an
 * optimisation that stops most of the board being fetched.
 */
export function eligibility(labels: readonly string[], mode: SolveMode): Eligibility {
  const present = new Set(labels);

  if (!present.has(AGENT_LABELS.solvable)) {
    return {
      eligible: false,
      reason: `no ${AGENT_LABELS.solvable} label — triage has not assessed this ticket as agent-fixable`,
    };
  }

  // Not `mode === "manual"`. The privilege granted by `auto` is running without
  // a human, so the test is for the single value that grants it and everything
  // else — including a value that reached here without passing `solveMode` —
  // lands on the side that asks a person first.
  if (mode !== "auto" && !present.has(AGENT_LABELS.start)) {
    return {
      eligible: false,
      reason: `no ${AGENT_LABELS.start} label — manual mode waits for a human`,
    };
  }

  const blocking = CLAIM_BLOCKING_LABELS.filter((label) => present.has(label));
  if (blocking.length > 0) {
    return { eligible: false, reason: `already carries ${blocking.join(", ")}` };
  }

  return { eligible: true };
}

export function isEligible(labels: readonly string[], mode: SolveMode): boolean {
  return eligibility(labels, mode).eligible;
}

/**
 * The claim: `agent:solving` on, `agent:start` off, in one edit.
 *
 * Removing `agent:start` is what makes the human's authorisation single-use.
 * Left in place it would sit on the ticket indefinitely, and any later event
 * that clears the lifecycle label — a solver marking the ticket failed and a
 * human clearing `agent:failed` to look at it themselves, say — would silently
 * re-authorise a solve nobody asked for a second time. An approval that
 * survives the thing it approved is not an approval, it is a standing
 * permission.
 *
 * It is removed only when present, because in auto mode it never was, and an
 * edit listing a removal that does nothing makes the log harder to read for no
 * gain.
 *
 * Refuses outright on an ineligible ticket rather than returning an empty edit.
 * A caller that got the eligibility check wrong should find out here, where the
 * ticket is still untouched, rather than by writing a claim over somebody
 * else's.
 */
export function claimTransition(labels: readonly string[], mode: SolveMode): LabelEdit {
  const verdict = eligibility(labels, mode);
  if (!verdict.eligible) {
    throw new LabelStateError(`refusing to claim a ticket that is not eligible: ${verdict.reason}`);
  }

  const remove = labels.includes(AGENT_LABELS.start) ? [AGENT_LABELS.start] : [];
  return labelEdit([AGENT_LABELS.solving], remove);
}

/**
 * Solve finished, pull request open: add `agent:reviewing`, keep the claim.
 *
 * See the module header. `agent:solving` staying on is what keeps the ticket
 * out of the queue while its pull request is being reviewed.
 */
export function reviewTransition(labels: readonly string[]): LabelEdit {
  if (!labels.includes(AGENT_LABELS.solving)) {
    throw new LabelStateError(
      `refusing to move to ${AGENT_LABELS.reviewing} without ${AGENT_LABELS.solving} — the claim is what proves this instance owns the ticket`,
    );
  }
  return labelEdit([AGENT_LABELS.reviewing], []);
}

export type SolveOutcomeLabel = "done" | "failed";

/**
 * The terminal transition: the lifecycle labels come off, one verdict goes on.
 *
 * `agent:solvable` deliberately stays. It is triage's assessment, not the
 * solver's, and a record of what was believed before the attempt is exactly
 * what a calibration period needs to read back off the board afterwards.
 */
export function completionTransition(
  labels: readonly string[],
  outcome: SolveOutcomeLabel,
): LabelEdit {
  const present = new Set(labels);
  const remove = [AGENT_LABELS.solving, AGENT_LABELS.reviewing].filter((label) =>
    present.has(label),
  );
  return labelEdit([outcome === "done" ? AGENT_LABELS.done : AGENT_LABELS.failed], remove);
}

/** Whether the machine has already stopped for this ticket. */
export function isTerminal(labels: readonly string[]): boolean {
  return labels.includes(AGENT_LABELS.done) || labels.includes(AGENT_LABELS.failed);
}

/** The labels a ticket would carry after an edit, for reporting a dry run. */
export function applyEdit(labels: readonly string[], change: LabelEdit): readonly string[] {
  const removing = new Set(change.remove);
  const next = labels.filter((label) => !removing.has(label));
  for (const label of change.add) {
    if (!next.includes(label)) {
      next.push(label);
    }
  }
  return next;
}
