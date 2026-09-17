/**
 * The solve queue's state machine, as pure functions over a ticket's labels.
 *
 * ```
 * agent:solvable          triage's call; set by the grooming poster
 *    + agent:start        the human go-ahead (manual mode)
 *    → agent:solving      claimed; agent:start removed in the same edit
 *    → agent:reviewing    draft PR open; agent:solving removed in the same edit
 *    ⇄ agent:review-done  undrafted; two-way — a round that pushes goes back to agent:reviewing
 *    → agent:done         the pull request was MERGED
 *    → agent:closed       the pull request was closed unmerged
 *    → agent:failed       bailed
 * ```
 *
 * State lives on the ticket's own labels rather than in `state/poll.json` like the new-issue
 * poller, so the queue survives a restart, a deleted `state/` directory, or a second instance
 * running alongside the first. Everything here is pure — it computes edits, never applies them —
 * so the whole machine is testable without a board and readable in one file.
 *
 * Two rules that are load-bearing rather than tidy:
 *
 * 1. **The claim is one edit.** `agent:solving` on and `agent:start` off together, or the gap
 *    between two writes is a window where a second instance sees a solvable, started, unclaimed
 *    ticket — a double claim.
 *
 * 2. **`agent:solving` is removed when review begins, and what replaces it must exclude just as
 *    hard.** `buildInFlightJql` counts `agent:solving` against `MAX_CONCURRENT_SOLVES`, so holding
 *    the claim through review would tie up a slot for as long as a human takes to look, not as
 *    long as the agent takes to work. `SOLVE_QUEUE_EXCLUDED_LABELS` is what has to grow instead so
 *    a ticket with an open pull request does not fall back into the queue.
 *
 * 3. **The review phase oscillates, and the labels are allowed to say so.** `agent:review-done` can
 *    be handed back to `agent:reviewing` by a round that pushes, so `reviewStageTransition` is one
 *    function over both directions rather than a mirror-image pair that can be broken on one side.
 */

import type { SolveMode } from "../settings.ts";

export const AGENT_LABELS = {
  /** Triage's assessment: a coding agent could plausibly fix this. */
  solvable: "agent:solvable",
  /** A human's authorisation. Required in manual mode, single-use. */
  start: "agent:start",
  /** The claim. Written before any work begins; this is what makes the queue idempotent. */
  solving: "agent:solving",
  /** Pull request open and being iterated on. Replaces the claim. */
  reviewing: "agent:reviewing",
  /**
   * Undrafted: the agentic cycle is finished and only human approval is left.
   * The longest-lived state in the machine by a wide margin — days, not the minutes of
   * `agent:solving` — which is why it is in the exclusions and not merely in the diagram.
   */
  reviewDone: "agent:review-done",
  /** The pull request was **merged** — the metric for how many bugs this tool actually fixed. */
  done: "agent:done",
  /**
   * The pull request was closed unmerged.
   * Deliberately neither `done` nor `failed`: the agent did the job and a person declined it,
   * which is neither a failure nor a fix, and is worth counting on its own.
   */
  closed: "agent:closed",
  failed: "agent:failed",
  /**
   * Triage sent the ticket back and thinks it is nearly solvable — watch it.
   * Not part of the lifecycle above: written by *triage* on a ticket that never entered the
   * queue, and excludes nothing since `agent:solvable` is already absent. Same namespace as the
   * lifecycle labels so the two vocabularies cannot drift — not a sixth state of the machine.
   */
  watching: "agent:watching",
} as const;

/**
 * Who is vouching for a claim.
 * `manual`/`auto` describe a running service; `named` means an operator typed one issue key at a
 * terminal, a human authorisation that exists for one process and cannot arrive from `.env` or a
 * config file the way a `SolveMode` could. It still requires `agent:solvable`: naming a ticket
 * answers "may this run", not "is this fixable" — that question stays triage's.
 */
export type ClaimAuthority = SolveMode | "named";

/**
 * The authorities that need no `agent:start` label.
 * An allowlist rather than a comparison against `manual`: a widened union or a stray cast that
 * reaches here lands on the side that asks a person first.
 */
const SELF_AUTHORISING: ReadonlySet<string> = new Set(["auto", "named"]);

/**
 * The labels the queue query excludes. Exported so `buildSolveQueueJql` and the local eligibility
 * check below share one list rather than enforcing the same rule twice from two places.
 * `agent:reviewing` and `agent:review-done` are the load-bearing entries — `agent:review-done`
 * especially, since a ticket sits there for days and omitting it is the double-solve bug with the
 * widest window in the design.
 */
export const SOLVE_QUEUE_EXCLUDED_LABELS: readonly string[] = [
  AGENT_LABELS.solving,
  AGENT_LABELS.reviewing,
  AGENT_LABELS.reviewDone,
  AGENT_LABELS.done,
  AGENT_LABELS.closed,
  AGENT_LABELS.failed,
];

/**
 * Labels that make a ticket unclaimable, checked locally.
 * An alias of `SOLVE_QUEUE_EXCLUDED_LABELS` rather than a second literal, so the two cannot
 * silently diverge. If a future state needs to block a claim without being excluded from the
 * query, split them again and say why.
 */
const CLAIM_BLOCKING_LABELS = SOLVE_QUEUE_EXCLUDED_LABELS;

/**
 * The prefix that names the owning repository.
 * Not part of `AGENT_LABELS`: `svc:` is an existing board convention triage writes and this
 * module only reads, and must not write.
 */
const SVC_PREFIX = "svc:";

/**
 * The label triage uses instead of `svc:` when it could not tell.
 * A positive statement — "I looked and don't know" — handled the same as silence.
 */
const IMPL_UNCERTAIN = "impl-uncertain";

/**
 * Repository names, and nothing that could be read as a path.
 * Must *begin* with an alphanumeric: `[A-Za-z0-9._-]+` alone would accept `..`, a name made
 * entirely of legal characters that also escapes whatever directory it is joined to. This also
 * rules out dotfiles and a leading `-` that could be read as a command-line flag.
 */
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The same question asked of a name that came from `.env` rather than a label.
 * Exported so `SOLVE_READ_DIRS` reuses this pattern instead of risking a second copy that misses the `..` fix.
 */
export function isRepoName(value: string): boolean {
  return REPO_NAME.test(value);
}

/**
 * The repository a ticket names, or `null` if it does not name exactly one.
 * Every ambiguous answer is `null`, including two `svc:` labels or `impl-uncertain` alongside
 * one — this value chooses which repository gets written to, so a contradiction is never resolved by guessing.
 */
export function repoFromLabels(labels: readonly string[]): string | null {
  const named = labels
    .filter((label) => label.startsWith(SVC_PREFIX))
    .map((label) => label.slice(SVC_PREFIX.length).trim());

  if (named.length !== 1) {
    return null;
  }
  if (labels.includes(IMPL_UNCERTAIN)) {
    return null;
  }

  const repo = named[0] ?? "";
  return REPO_NAME.test(repo) ? repo : null;
}

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
 * Jira resolves add and remove in an order this service does not control, so such an edit has no
 * defined outcome — and the queue's idempotency depends on labels reflecting what the last edit intended.
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
 * Re-checks locally what the JQL already filtered for: the query has documented surprises (an
 * empty `labels` field matches nothing) and callers may hand it a ticket from elsewhere entirely.
 */
export function eligibility(labels: readonly string[], authority: ClaimAuthority): Eligibility {
  const present = new Set(labels);

  // Checked for every authority, including `named`: naming a ticket authorises the run, not the fix — only triage decides fixability.
  if (!present.has(AGENT_LABELS.solvable)) {
    return {
      eligible: false,
      reason: `no ${AGENT_LABELS.solvable} label — triage has not assessed this ticket as agent-fixable`,
    };
  }

  if (!SELF_AUTHORISING.has(authority) && !present.has(AGENT_LABELS.start)) {
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

/**
 * The claim: `agent:solving` on, `agent:start` off, in one edit.
 * Removing `agent:start` makes the human's authorisation single-use — left in place, a later
 * event that clears the lifecycle label would silently re-authorise a solve nobody asked for.
 * Refuses outright on an ineligible ticket rather than returning an empty edit, so a caller with a
 * wrong eligibility check finds out here rather than by writing a claim over somebody else's.
 */
export function claimTransition(labels: readonly string[], authority: ClaimAuthority): LabelEdit {
  const verdict = eligibility(labels, authority);
  if (!verdict.eligible) {
    throw new LabelStateError(`refusing to claim a ticket that is not eligible: ${verdict.reason}`);
  }

  const remove = labels.includes(AGENT_LABELS.start) ? [AGENT_LABELS.start] : [];
  return labelEdit([AGENT_LABELS.solving], remove);
}

/**
 * Solve finished, pull request open: `agent:reviewing` on, the claim off.
 * The claim comes off because it is a concurrency slot, not a record — see rule 2 in the module
 * header. Still refuses without `agent:solving`: the claim is what proves this instance owns the ticket.
 */
export function reviewTransition(labels: readonly string[]): LabelEdit {
  if (!labels.includes(AGENT_LABELS.solving)) {
    throw new LabelStateError(
      `refusing to move to ${AGENT_LABELS.reviewing} without ${AGENT_LABELS.solving} — the claim is what proves this instance owns the ticket`,
    );
  }
  return labelEdit([AGENT_LABELS.reviewing], [AGENT_LABELS.solving]);
}

/** The two positions of the review phase, which a ticket moves between freely. */
export type ReviewStage = "reviewing" | "review-done";

const REVIEW_STAGE_LABELS: Readonly<Record<ReviewStage, string>> = {
  reviewing: AGENT_LABELS.reviewing,
  "review-done": AGENT_LABELS.reviewDone,
};

/**
 * Moves a ticket between the two review stages, in either direction.
 * One function rather than a mirror-image pair, since a mirror can be broken on one side only.
 * Idempotent: most rounds arrive with the ticket already in the wanted stage, so an empty edit
 * lets the caller skip the write (see `isNoopEdit`).
 * Refuses a ticket in neither stage — writing `agent:reviewing` onto one a person already moved to
 * `agent:done` would resurrect it into a state nothing else will ever clear.
 */
export function reviewStageTransition(labels: readonly string[], stage: ReviewStage): LabelEdit {
  const present = new Set(labels);
  if (!present.has(AGENT_LABELS.reviewing) && !present.has(AGENT_LABELS.reviewDone)) {
    throw new LabelStateError(
      `refusing to set ${REVIEW_STAGE_LABELS[stage]} on a ticket carrying neither ${AGENT_LABELS.reviewing} nor ${AGENT_LABELS.reviewDone} — it is not under review, and something else has moved it`,
    );
  }

  const wanted = REVIEW_STAGE_LABELS[stage];
  const other = stage === "reviewing" ? AGENT_LABELS.reviewDone : AGENT_LABELS.reviewing;
  return labelEdit(present.has(wanted) ? [] : [wanted], present.has(other) ? [other] : []);
}

/** Whether an edit would change nothing, so the caller can skip the write. */
export function isNoopEdit(change: LabelEdit): boolean {
  return change.add.length === 0 && change.remove.length === 0;
}

/**
 * The three ways this ends, and they are three rather than two on purpose.
 * `closed` is a pull request a person closed unmerged — work completed that nobody wanted, a
 * number that disappears the moment it is folded into `done` or `failed`.
 */
export type SolveOutcomeLabel = "done" | "closed" | "failed";

const OUTCOME_LABELS: Readonly<Record<SolveOutcomeLabel, string>> = {
  done: AGENT_LABELS.done,
  closed: AGENT_LABELS.closed,
  failed: AGENT_LABELS.failed,
};

/**
 * The terminal transition: the lifecycle labels come off, one verdict goes on.
 * `agent:solvable` deliberately stays — it is triage's pre-attempt assessment, needed to read
 * back for calibration. Every in-flight label is swept, even a combination a correct run couldn't
 * have left behind: an impossible state at the end of the machine is cleared, not preserved.
 */
export function completionTransition(
  labels: readonly string[],
  outcome: SolveOutcomeLabel,
): LabelEdit {
  const present = new Set(labels);
  const remove = [AGENT_LABELS.solving, AGENT_LABELS.reviewing, AGENT_LABELS.reviewDone].filter(
    (label) => present.has(label),
  );
  return labelEdit([OUTCOME_LABELS[outcome]], remove);
}

/**
 * Whether the machine has already stopped for this ticket.
 * All three verdicts, not just the two where the agent succeeded — a closed pull request is as over as a merged one.
 */
export function isTerminal(labels: readonly string[]): boolean {
  return (
    labels.includes(AGENT_LABELS.done) ||
    labels.includes(AGENT_LABELS.closed) ||
    labels.includes(AGENT_LABELS.failed)
  );
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
