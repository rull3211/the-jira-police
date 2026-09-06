/**
 * The solve queue's state machine, as pure functions over a ticket's labels.
 *
 * ```
 * agent:solvable          triage's call; set by the grooming poster
 *    + agent:start        the human go-ahead (manual mode) — the only human step
 *                         a *running service* takes. See `ClaimAuthority`: an
 *                         operator naming one ticket is the same authorisation
 *                         arriving through argv instead of the board.
 *    → agent:solving      claimed; agent:start removed in the same edit
 *    → agent:reviewing    draft PR open; agent:solving removed in the same edit
 *    ⇄ agent:review-done  undrafted — the agentic cycle is finished and only
 *                         human approval is left. Two-way: a later round that
 *                         pushes goes back to agent:reviewing.
 *    → agent:done         the pull request was MERGED
 *    → agent:closed       the pull request was closed unmerged
 *    → agent:failed       bailed
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
 * 2. **`agent:solving` *is* removed when review begins, and what replaces it must
 *    exclude just as hard.** This rule was the opposite until D4, and the reason
 *    it turned over is worth keeping: `buildInFlightJql` counts `agent:solving`
 *    against `MAX_CONCURRENT_SOLVES`, so a ticket that held the claim until merge
 *    would hold the only slot for as long as a human took to review — days, where
 *    active work is minutes. At `MAX_CONCURRENT_SOLVES=1` the queue delivers one
 *    pull request and then stops. Concurrency has to bound *work in progress*,
 *    and a pull request waiting on a person is not that.
 *
 *    The half of the old rule that was never wrong is the reason
 *    `SOLVE_QUEUE_EXCLUDED_LABELS` grew instead of shrinking: dropping the claim
 *    without excluding the state that replaces it puts a ticket with an open pull
 *    request back in the queue to be solved a second time. The two edits are one
 *    change and neither is safe alone.
 *
 * 3. **The review phase oscillates, and the labels are allowed to say so.**
 *    Undrafting is a transition, not an ending — the loop keeps listening for
 *    human review — so `agent:review-done` can be handed back to
 *    `agent:reviewing` by a round that pushes. `reviewStageTransition` is one
 *    function over both directions rather than two mirror-image ones, because a
 *    mirror is a thing that can be broken on one side only.
 */

import type { SolveMode } from "../settings.ts";

export const AGENT_LABELS = {
  /** Triage's assessment: a coding agent could plausibly fix this. */
  solvable: "agent:solvable",
  /** A human's authorisation. Required in manual mode, single-use. */
  start: "agent:start",
  /** The claim. Written before any work begins; this is what makes the queue idempotent. */
  solving: "agent:solving",
  /**
   * Pull request open and being iterated on. Replaces the claim.
   *
   * "Still claimed" until D4, and the sentence had to go along with the
   * behaviour — see rule 2 in the module header.
   */
  reviewing: "agent:reviewing",
  /**
   * Undrafted: the agentic cycle is finished and only human approval is left.
   *
   * The longest-lived state in the machine by a wide margin — days, waiting for a
   * person, where `agent:solving` is minutes. That is why it is in the exclusions
   * rather than merely in the diagram.
   */
  reviewDone: "agent:review-done",
  /**
   * The pull request was **merged**.
   *
   * Narrowed in D4 from "the agent finished" to this, because the label is also
   * the metric for how many bugs this tool actually fixed and a metric cannot
   * read the prose in a comment. What it used to also cover is `closed`.
   */
  done: "agent:done",
  /**
   * The pull request was closed unmerged.
   *
   * Deliberately neither `done` nor `failed`. The agent did the job and a person
   * declined it, which is not a failure of the agent and is not a bug fixed —
   * and it is the more interesting of the two numbers, so it does not get folded
   * into the other one.
   */
  closed: "agent:closed",
  failed: "agent:failed",
  /**
   * Triage sent the ticket back and thinks it is nearly solvable — watch it.
   *
   * **Not part of the lifecycle above, and it is worth being blunt about that.**
   * Every other label here is a state a ticket passes through on its way to a
   * pull request, written by the solver, and each one excludes the ticket from
   * the queue. This one is written by *triage*, on a ticket that never entered
   * the queue and cannot, and it excludes nothing: a watched ticket is a
   * send-back, so `agent:solvable` is absent and the queue's positive clause
   * already refuses it. It lives in this object because it is the same
   * namespace and a second vocabulary for one namespace is how the two drift —
   * not because it is a sixth state of the same machine.
   *
   * The subscription *is* the label, on the same principle as the claim: state
   * on the board rather than on disk, so it survives a restart and a person can
   * see what the service thinks it is waiting for. What ends it is the ticket
   * becoming ready, being closed, or the re-triage bound running out.
   */
  watching: "agent:watching",
} as const;

export type AgentLabel = (typeof AGENT_LABELS)[keyof typeof AGENT_LABELS];

/**
 * Who is vouching for a claim.
 *
 * The two `SolveMode` values describe a *running service*: `manual` waits for a
 * human's `agent:start`, `auto` does not. `named` is neither, and it is the
 * reason this is a wider type rather than one more `SolveMode` value.
 *
 * `named` means an operator typed one issue key at a terminal. That is a human
 * authorisation — a stronger one than the label, since a label can be added by
 * anyone with a Jira account at any time and then sit there, whereas this one
 * exists for the length of one process and names its ticket. So it satisfies
 * the same requirement `agent:start` satisfies, and consumes nothing, because
 * there was no standing approval to consume.
 *
 * **It is deliberately not a `SolveMode`.** `solveMode` parses `SOLVE_MODE` and
 * refuses any value that is not `manual` or `auto`, so `named` cannot arrive
 * from `.env`, from a config file, or from the daemon — which has no argv. The
 * only way to produce it is the CLI, and that is the property the separation
 * buys: widening `SolveMode` instead would have made "skip the human" a setting.
 *
 * What `named` does **not** skip is the assessment. `agent:solvable` is still
 * required, and that is the whole check in singleton mode — an operator naming
 * a ticket is answering "may this run", not "is this fixable", and the second
 * question is triage's.
 */
export type ClaimAuthority = SolveMode | "named";

/**
 * The authorities that need no `agent:start` label.
 *
 * An allowlist rather than a comparison against `manual`, and the direction is
 * the point: any value reaching here that is not named below — a widened union
 * someone forgot to consider, a string cast past the type system — lands on the
 * side that asks a person first. This replaces an earlier `mode !== "auto"`
 * test, which had the same defaulting property and stopped having it the moment
 * a third value existed.
 */
const SELF_AUTHORISING: ReadonlySet<string> = new Set(["auto", "named"]);

/**
 * The labels the queue query excludes, and the reason it can.
 *
 * Exported so `buildSolveQueueJql` and the local eligibility check below cannot
 * name different sets. They are two enforcements of one rule — the query keeps
 * the work off the wire, the predicate keeps it off the wire *and* survives a
 * hand-written query — and a rule enforced twice from two lists is a rule
 * enforced once, badly.
 *
 * Every state the machine can be in except the two it starts from. A ticket is
 * claimable when nothing here is on it; anything else is either being worked on,
 * waiting on a person, or over.
 *
 * **`agent:reviewing` and `agent:review-done` are the entries that make this list
 * load-bearing rather than tidy**, and until D4 the first was absent with a
 * comment explaining that a ticket under review still carried `agent:solving`.
 * It does not any more (rule 2), so the exclusion that used to come free has to
 * be written down. `agent:review-done` matters most of the three: it is where a
 * ticket sits for days, so omitting it is the double-solve bug with the widest
 * window in the whole design.
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
 * Labels that make a ticket unclaimable, checked locally. Now the same list.
 *
 * It used to be a strict superset, holding `agent:reviewing` when the query did
 * not, and the comment here said why: *"if someone later decides that reviewing
 * should replace solving rather than accompany it, this list is what stops that
 * change from silently becoming a double-solve bug."* **That is D4, and the guard
 * did its job** — the extra entry was already correct when the transition changed
 * underneath it, so the local check never had a window the query had.
 *
 * With the hypothetical arrived, the two sets coincide, and an alias is the
 * honest way to say so. Two identical literals would be the failure the module
 * header names at `SOLVE_QUEUE_EXCLUDED_LABELS` — a rule enforced twice from two
 * lists is a rule enforced once, badly — and the next divergence between them
 * would be a typo rather than a decision. If a future state ever needs to block a
 * claim without being excluded from the query, split them again *and say which
 * entry is the reason*, the way this comment used to.
 */
const CLAIM_BLOCKING_LABELS = SOLVE_QUEUE_EXCLUDED_LABELS;

/**
 * The prefix that names the owning repository.
 *
 * Not part of `AGENT_LABELS`, and that separation is the point: `svc:` is not
 * this feature's to define. It is an existing board convention, written by
 * triage today (`INTAKE_INSTRUCTIONS.md:359`, `intake-triage.spec.md:110`) and
 * read here. The solve queue is a consumer of it, so it gets no say in its
 * shape and must not write it.
 */
const SVC_PREFIX = "svc:";

/**
 * The label triage uses instead of `svc:` when it could not tell.
 *
 * Worth naming rather than treating as just another unrecognised label. It is a
 * positive statement — "I looked and I do not know" — and the correct response
 * to it is the same as to silence, so the code reads better for saying that
 * once, out loud, than for arriving at it by omission.
 */
const IMPL_UNCERTAIN = "impl-uncertain";

/**
 * Repository names, and nothing that could be read as a path.
 *
 * Phase C turns this string into a git worktree directory, so the check belongs
 * here at the parse boundary rather than there at the point of use. `SOLVE_REPOS`
 * is an exact-match allowlist and would already stop a traversal attempt today,
 * but that is one careless widening away from being the only thing that does,
 * and a value derived from a Jira label is derived from something a stranger
 * can edit.
 *
 * Must *begin* with an alphanumeric, which is not decoration. An earlier version
 * of this pattern was `[A-Za-z0-9._-]+` and happily returned `..` — a name made
 * entirely of legal characters that is also the one string guaranteed to escape
 * whatever directory it is joined to. Requiring a leading alphanumeric rules out
 * `.` and `..` together with dotfiles, and rules out a leading `-` besides,
 * which is how a repository name gets read as a command-line flag.
 */
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The repository a ticket names, or `null` if it does not name exactly one.
 *
 * Every ambiguous answer is `null`, including two `svc:` labels at once. The
 * tempting alternative — take the first — invents a decision out of a
 * contradiction, and this value chooses which repository gets written to. There
 * is no reading of "this ticket says two different things" that justifies
 * picking one and proceeding.
 *
 * `impl-uncertain` alongside an `svc:` label is treated the same way. The spec
 * offers them as alternatives, so a ticket carrying both is in a state the
 * convention does not describe, and guessing which half is stale would be
 * guessing in the direction of doing more work rather than less.
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
export function eligibility(labels: readonly string[], authority: ClaimAuthority): Eligibility {
  const present = new Set(labels);

  // Checked for every authority, including `named`. This is the one question an
  // operator typing a key has not answered: they decided the run may happen,
  // not that the ticket is fixable, and only triage has made that call.
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

export function isEligible(labels: readonly string[], authority: ClaimAuthority): boolean {
  return eligibility(labels, authority).eligible;
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
 * It is removed only when present, because under `auto` and `named` it usually
 * never was, and an edit listing a removal that does nothing makes the log
 * harder to read for no gain. Note "usually": a ticket a human already
 * authorised can still be picked up by a named run, and then the label is there
 * and is consumed — which is right, since leaving it would hand the queue a
 * standing approval for work that has already been done.
 *
 * Refuses outright on an ineligible ticket rather than returning an empty edit.
 * A caller that got the eligibility check wrong should find out here, where the
 * ticket is still untouched, rather than by writing a claim over somebody
 * else's.
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
 *
 * The claim comes off because it is a concurrency slot, not a record — see rule
 * 2 in the module header. What keeps the ticket out of the queue from here on is
 * `SOLVE_QUEUE_EXCLUDED_LABELS`, which is why the two changed together.
 *
 * Still refuses without `agent:solving`, and the reason is unchanged by the
 * removal: the claim is what proves this instance owns the ticket, and a caller
 * that cannot show one is either confused or racing.
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
 *
 * One function rather than an undraft transition and a resume transition,
 * because the two are one axis and mirror-image functions can be broken on one
 * side only. A round that undrafts asks for `review-done`; a later round that
 * pushes a commit asks for `reviewing` again, because while it is pushing, "only
 * human approval is left" is false.
 *
 * **Idempotent on purpose, and that is not a convenience.** Most rounds neither
 * undraft nor resume — they arrive with the ticket already in the stage they
 * want — and the advance step will run on a timer. Returning an empty edit lets
 * the caller skip the write (see `isNoopEdit`) instead of either writing a label
 * that is already there or having to reproduce this comparison at every call
 * site.
 *
 * **Refuses a ticket that is in neither stage**, which is the guard worth having.
 * The stage a round wants is decided from a pull request; whether the ticket is
 * still under review is a fact about the board, and a person can have moved it
 * to `agent:done` or cleared it entirely in between. Writing `agent:reviewing`
 * onto a ticket somebody just finished would resurrect it into a state the queue
 * excludes and nothing else will ever clear.
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
 *
 * `done` is **merged**, and nothing else, because it is what a report counts.
 * `closed` is a pull request a person closed unmerged — work the tool completed
 * that nobody wanted, which is a number worth having and is invisible the moment
 * it is folded into either neighbour. `failed` is the agent bailing.
 */
export type SolveOutcomeLabel = "done" | "closed" | "failed";

const OUTCOME_LABELS: Readonly<Record<SolveOutcomeLabel, string>> = {
  done: AGENT_LABELS.done,
  closed: AGENT_LABELS.closed,
  failed: AGENT_LABELS.failed,
};

/**
 * The terminal transition: the lifecycle labels come off, one verdict goes on.
 *
 * `agent:solvable` deliberately stays. It is triage's assessment, not the
 * solver's, and a record of what was believed before the attempt is exactly
 * what a calibration period needs to read back off the board afterwards.
 *
 * Every in-flight label is swept, including the ones a correct run would not
 * have left behind together. A ticket reaching here with both `agent:reviewing`
 * and `agent:review-done` is in a state no transition produces, but it is also a
 * ticket that is over, and the useful response to an impossible state at the end
 * of the machine is to clear it rather than to preserve it.
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
 *
 * All three verdicts, not the two that mean the agent succeeded. This answers
 * "is there anything left to do", and a pull request somebody closed is as over
 * as one they merged.
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
