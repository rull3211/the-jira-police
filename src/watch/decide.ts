/**
 * Whether a watched ticket is worth paying to re-triage.
 *
 * This is the whole of the sendback watch's judgement, kept pure and given no
 * I/O, because it is the one decision in the feature that spends money with
 * nobody having asked for anything. Everything it needs is passed in; every
 * failure mode below is reachable from a plain object in a test.
 *
 * **The trap this function exists to avoid.** Posting a triage comment is
 * itself an update to the ticket, and the labels written beside it bump
 * `updated` again a moment later. So the obvious rule — *re-triage when the
 * ticket changed since we last spoke* — is true the instant we stop speaking,
 * and every watched ticket becomes a standing charge of one triage run per
 * cycle, each one leaving a fresh comment on somebody's bug. The answer is the
 * same shape as the review cursor's: **compare against what somebody else did,
 * not against what changed.**
 *
 * Two mechanisms do that, and they are deliberately different from each other.
 *
 * **Comments are keyed on the sentinel, not on the author.** The poster writes
 * through an MCP session on a human's Atlassian account, so authorship cannot
 * separate this service's comment from the operator's own — the same problem
 * `reviewerComments` hit on GitHub, and the same answer. A body carrying
 * `FOOTER_SENTINEL` is ours. A human could forge that by pasting the line, and
 * the consequence is worth naming: a forged comment reads as ours, so it does
 * *not* trigger a re-triage and it *does* count against the ticket's bound.
 * Both directions end the watch sooner rather than spending more, which is the
 * side to be wrong on.
 *
 * **Field changes are keyed on the field, not on the author.** This is a
 * departure from the plan, which proposed reading the changelog's author, and
 * it is better on two counts: it inherits none of the shared-account ambiguity
 * above, and it cannot be defeated by whoever happens to hold the credential.
 * See `BLOCKER_CLEARING_FIELDS` for why it is an allowlist rather than a list
 * of the fields this service writes.
 */

import { FOOTER_SENTINEL } from "../triage/gate.ts";

/** One comment, with its ADF already rendered to text by the caller. */
export interface WatchComment {
  /** ISO-8601. */
  readonly created: string;
  /**
   * The rendered body.
   *
   * Attacker-controlled: a Jira comment is written by whoever can see the
   * ticket. It is searched for one fixed substring and never interpreted.
   */
  readonly text: string;
}

/** One changelog entry, flattened to the fields it touched. */
export interface WatchFieldChange {
  /** ISO-8601. */
  readonly created: string;
  /** Jira's `items[].field` values, as returned. Compared case-insensitively. */
  readonly fields: readonly string[];
}

export interface WatchSignals {
  readonly key: string;
  /** True when the ticket has been closed — `statusCategory` is `Done`. */
  readonly closed: boolean;
  readonly comments: readonly WatchComment[];
  readonly changes: readonly WatchFieldChange[];
}

export type WatchDecision =
  /** Somebody else moved. Worth paying for a re-triage. */
  | { readonly kind: "retriage"; readonly trigger: string; readonly at: string }
  /** Nothing has happened since we last spoke. The common case, and free. */
  | { readonly kind: "quiet" }
  /** Take the label off and stop looking. */
  | { readonly kind: "unsubscribe"; readonly reason: UnsubscribeReason; readonly note: string };

export type UnsubscribeReason = "closed" | "exhausted" | "uncountable";

/**
 * The fields whose change could plausibly clear a send-back blocker.
 *
 * **An allowlist, and the direction of the error is the argument.** The
 * tempting inverse — treat any field this service does not write as somebody
 * else's edit — is simpler and wrong in the expensive direction. Boards get
 * groomed: a sprint assignment, a rank drag, a priority bump or a re-assign
 * would each read as "the reporter responded" and buy a paid triage run. Worse
 * than the money, it would spend the ticket's `MAX_RETRIAGE_PER_TICKET` budget
 * on noise, so the watch would be exhausted by the time the reporter actually
 * answered — the feature failing at exactly the moment it was supposed to work.
 *
 * An allowlist fails the other way: an edit that clears a blocker through a
 * field not named here is missed, the ticket sits watched, and a human can
 * still run `triage:once` on it. Silent and free beats loud and expensive, and
 * it is the same posture as every other switch in this service.
 *
 * **Known gap, stated rather than guessed at.** If this board keeps acceptance
 * criteria in a custom field, a reporter filling that in is the single most
 * likely trigger there is and it is not in this set — Jira reports custom
 * fields in the changelog under their own names, and inventing one here would
 * be a guess that reads as coverage. Add it once somebody has looked at a real
 * changelog on a real sent-back ticket.
 */
export const BLOCKER_CLEARING_FIELDS: ReadonlySet<string> = new Set([
  "description",
  "summary",
  "attachment",
  "environment",
]);

/** True when a comment body is one this service wrote. */
export function isOurComment(comment: WatchComment): boolean {
  return comment.text.includes(FOOTER_SENTINEL);
}

function parsed(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NaN : ms;
}

/**
 * Decides what to do about one watched ticket.
 *
 * `maxRetriage` is `MAX_RETRIAGE_PER_TICKET`. The count it bounds is read from
 * the bot's own comments on the ticket rather than from disk, so it survives a
 * restart, a wiped `state/` and a second instance — the same reason the solve
 * queue keeps its dedupe in Jira.
 */
export function decideWatch(signals: WatchSignals, maxRetriage: number): WatchDecision {
  // First, because it is free and it is the only terminal that does not depend
  // on anything else being readable. A closed ticket is also the case the query
  // deliberately still returns, so that this branch can reach it at all.
  if (signals.closed) {
    return {
      kind: "unsubscribe",
      reason: "closed",
      note: "the ticket is closed, so the watch has nothing left to wait for",
    };
  }

  const ours = signals.comments.filter(isOurComment);

  // **A watch with no countable history is refused rather than started.**
  //
  // The bound is a receipt: it is read back from comments this service already
  // posted. So a ticket with none has no bound at all, and re-triaging it would
  // pay for a run, post a comment, and — if that post failed for any reason —
  // arrive back here at zero, forever. That is the marker rule from the review
  // cursor, arriving in a second loop: a count that will not read must not read
  // as zero, because losing the count and starting again from one is how a
  // bounded loop quietly becomes an unbounded one.
  //
  // It costs the hand-labelled case: a human who adds `agent:watching`
  // themselves gets a refusal rather than a look. That is a visible refusal
  // with a one-command remedy, and the alternative is an unbounded spend on a
  // ticket nobody is reading.
  if (ours.length === 0) {
    return {
      kind: "unsubscribe",
      reason: "uncountable",
      note: `${signals.key} carries the watch label but no comment this service wrote, so there is nothing to count re-triage attempts from — run triage:once by hand instead of starting a watch that cannot be bounded`,
    };
  }

  if (ours.length >= maxRetriage) {
    return {
      kind: "unsubscribe",
      reason: "exhausted",
      note: `${ours.length} triage comments already, at a limit of ${maxRetriage} — a ticket edited this many times is a conversation rather than a signal`,
    };
  }

  // The high-water mark: when we last spoke. Anything at or before it has been
  // seen, by definition, because it was on the ticket when the comment was
  // written.
  const spokeAt = Math.max(...ours.map((comment) => parsed(comment.created)));
  if (Number.isNaN(spokeAt)) {
    return {
      kind: "unsubscribe",
      reason: "uncountable",
      note: `${signals.key} has a triage comment with an unreadable timestamp, so there is no high-water mark to compare against and every look would read as new`,
    };
  }

  // Somebody else's comment. `created` never moves when a comment is edited —
  // Jira reports an `updated` this service does not fetch — so a reporter who
  // answers by editing their own earlier comment is missed. Recorded rather
  // than worked around: the same blind spot the review marker has, failing the
  // same safe way.
  //
  // **A tie counts as somebody else, in both loops, and that is what keeps the
  // self-trigger guard alive.** `>=` rather than `>` means a comment written in
  // the same millisecond as ours triggers a look. It is safe *because* the skip
  // on the line above is what excludes our own — and it is what makes that skip
  // load-bearing rather than decorative. `spokeAt` is the maximum over our own
  // comments, so under a strict `>` no comment of ours could satisfy the test
  // whether it was skipped or not: the guard this whole feature rests on would
  // be unreachable, and unplugging it would fail nothing. Written as `>` first,
  // and the mutation run is what said so.
  //
  // The general rule both loops follow: **our own activity is excluded by kind,
  // never by clock.** A comment of ours is excluded by the sentinel; a field
  // write of ours is excluded by not being in `BLOCKER_CLEARING_FIELDS`, since
  // this service writes labels and comments and nothing else. So neither loop
  // needs the timestamp to do that job, and neither should give a tie away.
  for (const comment of signals.comments) {
    if (isOurComment(comment)) {
      continue;
    }
    const at = parsed(comment.created);
    if (!Number.isNaN(at) && at >= spokeAt) {
      return { kind: "retriage", trigger: "a comment from somebody else", at: comment.created };
    }
  }

  for (const change of signals.changes) {
    const at = parsed(change.created);
    if (Number.isNaN(at) || at < spokeAt) {
      continue;
    }
    const field = change.fields.find((name) =>
      BLOCKER_CLEARING_FIELDS.has(name.trim().toLowerCase()),
    );
    if (field !== undefined) {
      return { kind: "retriage", trigger: `${field} was edited`, at: change.created };
    }
  }

  return { kind: "quiet" };
}
