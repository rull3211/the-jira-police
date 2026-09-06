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
   * ISO-8601, equal to `created` on a comment nobody has edited.
   *
   * Both timestamps are read, and on our own comments that is not an
   * improvement but a requirement — see `lastSpokeAt`. On somebody else's it
   * closes a blind spot recorded when this file was written: a reporter who
   * answers by editing their own earlier comment used to be invisible here.
   */
  readonly updated: string;
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

/**
 * The footer's words, with the emphasis delimiters taken off both ends.
 *
 * **The delimiters do not survive the round trip, and comparing the sentinel
 * whole would have matched nothing.** The poster writes markdown; Jira stores
 * ADF, so `_…_` becomes a text node under an `em` mark; `renderAdf` puts marks
 * back as `*…*`, because that is the one markdown spells emphasis with here.
 * Every character between the delimiters is preserved and the delimiters
 * themselves are not, so the identity check has to be about the words.
 *
 * Derived from `FOOTER_SENTINEL` rather than written out again, so a change to
 * the footer moves both and the two cannot drift into disagreeing about which
 * comments are ours — which would read every watched ticket as unwatched and
 * re-triage the lot.
 *
 * Found by writing the test that renders a real ADF payload through
 * `toWatchSignals` rather than by reasoning about it, which is the only way
 * this class of bug is ever found.
 */
export const FOOTER_TEXT: string = FOOTER_SENTINEL.replace(/^[_*]+/, "").replace(/[_*]+$/, "");

/** True when a comment body is one this service wrote. */
export function isOurComment(comment: WatchComment): boolean {
  return comment.text.includes(FOOTER_TEXT);
}

function parsed(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NaN : ms;
}

/**
 * The later of a comment's two timestamps, or `NaN` if either will not read.
 *
 * One rule for both sides of the comparison, and the strictness is the point:
 * `Math.max` propagates `NaN`, so a comment this function cannot fully date is
 * a comment nothing downstream will act on. A partially-readable comment
 * resolving to its earlier timestamp would be a mark that is plausibly too
 * early, and too early is the direction that spends.
 *
 * Exported for the same reason `lastSpokeAt` is. The re-triage context dates
 * the very same comments, and a second dating rule living next door would
 * eventually disagree with this one — invisibly, until a comment triggers a
 * look and then does not appear in the prompt, which is a paid session asked to
 * explain an empty page.
 */
export function touchedAt(comment: WatchComment): number {
  return Math.max(parsed(comment.created), parsed(comment.updated));
}

/**
 * The high-water mark: when this service last spoke on the ticket, in epoch ms.
 *
 * **It reads `updated`, and that is a correctness fix rather than a refinement.
 * The triage poster does not add a comment on a re-run — it finds its own
 * previous one by the footer sentinel and rewrites it in place.** So on exactly
 * the ticket this feature exists for, our comment count stays at one and its
 * `created` stays pinned at the first triage, however many times the ticket is
 * re-triaged. A mark built from `created` alone therefore reports that this
 * service last spoke days before it did, every foreign comment since stays
 * newer than it forever, and the watch re-triages the same unchanged activity
 * on every sweep — §7b's infinite paid loop, arriving through the one write
 * path nobody thought to ask about because it does the *considerate* thing.
 *
 * Found by mapping the triage entry path while wiring the re-triage, not by a
 * test, and it is worth naming why no test could have: every test in this file
 * builds its own comments, so the poster's idempotency is a fact about a
 * different module that this module's fixtures quietly assumed away.
 *
 * `NaN` when the mark cannot be established — no comment of ours, or one whose
 * timestamps will not parse. That propagates to a refusal, which is the cheap
 * direction; a plausible wrong number propagates to a charge.
 *
 * Exported because the re-triage context has to slice the ticket at exactly the
 * same instant the decision did. Two functions computing *when we last spoke*
 * from the same comments would eventually disagree, and the disagreement would
 * show up as a check judging a different set of activity than the one that
 * triggered it — which is the shape of bug that reads as a bad model answer.
 */
export function lastSpokeAt(comments: readonly WatchComment[]): number {
  const ours = comments.filter(isOurComment);
  if (ours.length === 0) {
    return Number.NaN;
  }
  return Math.max(...ours.map(touchedAt));
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

  // **The first comment is the sendback, not a re-triage, so it is not
  // counted.** A watched ticket exists *because* triage looked once and asked
  // for something, and that look is the reason the watch was started rather
  // than an attempt to end it. Counting it made `MAX_RETRIAGE_PER_TICKET=3`
  // buy two re-triages while the setting's own name and every description of
  // it promised three — the prose and the behaviour disagreeing about a number,
  // which is the defect class this repository is organised around, in the one
  // number that decides how much a ticket may cost.
  //
  // Subtracting rather than comparing against `maxRetriage + 1`, because the
  // quantity this function is bounding is *re-triages* and the arithmetic
  // should say so; a `+ 1` at the comparison is the same fix written where the
  // next reader has to reconstruct why it is there.
  //
  // **This brake cannot currently fire, and the re-triage must not ship until
  // it can.** Counting our comments only counts re-triages if a re-triage
  // leaves a comment, and it does not: the poster finds its previous one by the
  // footer sentinel and rewrites it, so `ours.length` is one however many runs
  // a ticket has had. Found while wiring the hand-off, before anything spent
  // anything — the same discovery that forced `lastSpokeAt` to read `updated`,
  // and the more dangerous half of it, because the mark at least fails toward
  // refusing while a count stuck at zero fails toward paying.
  //
  // Kept, not deleted. It is the correct arithmetic over the quantity it names,
  // it does fire on the cases that *do* produce a second comment of ours — a
  // pasted sentinel, a hand-posted verdict — and deleting a brake because the
  // odometer is broken is how the odometer stays broken. What has to change is
  // where the count comes from, and that is a decision the plan owns: it needs
  // a counter the watcher can write *before* the run it authorises, which the
  // comment body is not, since writing it costs a paid session of its own.
  const retriages = ours.length - 1;
  if (retriages >= maxRetriage) {
    return {
      kind: "unsubscribe",
      reason: "exhausted",
      note: `${retriages} re-triage${retriages === 1 ? "" : "s"} already, at a limit of ${maxRetriage} — a ticket edited this many times is a conversation rather than a signal`,
    };
  }

  // The high-water mark: when we last spoke. Anything at or before it has been
  // seen, by definition, because it was on the ticket when the comment was
  // written.
  const spokeAt = lastSpokeAt(signals.comments);
  if (Number.isNaN(spokeAt)) {
    return {
      kind: "unsubscribe",
      reason: "uncountable",
      note: `${signals.key} has a triage comment with an unreadable timestamp, so there is no high-water mark to compare against and every look would read as new`,
    };
  }

  // Somebody else's comment, dated by whichever of its two timestamps is
  // later. The blind spot recorded here — a reporter who answers by editing
  // their own earlier comment, invisible because `created` does not move — is
  // closed, and it was closed by accident: `updated` had to be fetched for our
  // own comments anyway, and once it is on the wire withholding it from this
  // side would be a deliberate choice to keep missing the answers.
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
    const at = touchedAt(comment);
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
