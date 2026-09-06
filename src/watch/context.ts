/**
 * What the relevance check is shown, sliced at the same instant the decision
 * was made.
 *
 * `decideWatch` returns on its first trigger, which is right for a decision —
 * one reason to look is enough — and wrong for a question about *what
 * happened*. The first live run made that concrete: on a ticket with both a new
 * comment and a description edit, the decision names the comment and the edit
 * is never mentioned, so anything reading the decision's own trigger string
 * would be judging half the activity. This module does the other job: collect
 * everything foreign since we last spoke, and hand the check all of it.
 *
 * Pure, and separate from `relevance.ts` for the reason `decide.ts` is separate
 * from `signals.ts` — the module that spawns a paid session should not also be
 * the one deciding what goes into the prompt, because then the prompt can only
 * be tested by paying.
 */

import {
  BLOCKER_CLEARING_FIELDS,
  isOurComment,
  lastSpokeAt,
  touchedAt,
  type WatchSignals,
} from "./decide.ts";
import type { RelevanceInput } from "./relevance.ts";

/**
 * How many foreign comments the check is shown.
 *
 * A bound rather than a guess at what a ticket looks like: every one of these
 * is attacker-controlled text going into a prompt, and an unbounded count is an
 * unbounded prompt. The newest are kept because an answer to a sendback is the
 * thing somebody wrote most recently, and the count that was dropped is stated
 * rather than the older ones being dropped quietly — a check told it is seeing
 * everything, while seeing ten of forty, is being asked a different question
 * from the one it is answering.
 */
export const MAX_CONTEXT_COMMENTS = 10;

function parsed(iso: string): number {
  return Date.parse(iso);
}

/**
 * Everything foreign that has happened since we last spoke.
 *
 * `null` when there is no readable high-water mark, which is the same condition
 * `decideWatch` unsubscribes on: with no mark, *everything* on the ticket reads
 * as new, and a check handed the ticket's whole history would be judging the
 * sendback against the conversation that produced it.
 *
 * **Only blocker-clearing fields are named.** The rest cannot trigger a
 * re-triage — that is `BLOCKER_CLEARING_FIELDS`' whole argument — so listing
 * them would hand the check a sprint assignment and a rank drag as evidence
 * that the reporter responded. The calibration lesson from the same live run
 * cuts the other way and does not apply here: the *debug log* must not filter,
 * because a filtered list can only confirm the guess it was filtered by; the
 * *prompt* must, because an unfiltered one is an invitation to reason from
 * noise.
 */
export function retriageContext(signals: WatchSignals): RelevanceInput | null {
  const spokeAt = lastSpokeAt(signals.comments);
  if (Number.isNaN(spokeAt)) {
    return null;
  }

  // **Dated with `touchedAt`, not with `created`, and every one of these three
  // uses has to be.** The poster rewrites its own comment in place on a
  // re-triage, so `created` on our comment is the *first* triage however many
  // have run — a sendback looked up by `created === spokeAt` would stop
  // matching the moment a ticket was re-triaged once, and the check would be
  // handed an empty ask. That is the same defect `lastSpokeAt` was written for,
  // one module along, which is why the rule is imported rather than rewritten.
  const ours = signals.comments.filter(isOurComment);
  const sendback = ours.find((comment) => touchedAt(comment) === spokeAt)?.text ?? "";

  const foreign = signals.comments
    .filter((comment) => !isOurComment(comment))
    .filter((comment) => {
      const at = touchedAt(comment);
      // A tie counts as foreign, exactly as it does in the decision. The two
      // must agree: a comment that triggered the look and then did not appear
      // in the prompt is a paid session asked to explain an empty page.
      return !Number.isNaN(at) && at >= spokeAt;
    })
    .toSorted((left, right) => touchedAt(left) - touchedAt(right));

  const kept = foreign.slice(-MAX_CONTEXT_COMMENTS);

  const fields = [
    ...new Set(
      signals.changes
        .filter((change) => {
          const at = parsed(change.created);
          return !Number.isNaN(at) && at >= spokeAt;
        })
        .flatMap((change) => change.fields)
        .map((name) => name.trim().toLowerCase())
        .filter((name) => BLOCKER_CLEARING_FIELDS.has(name)),
    ),
  ].toSorted();

  return {
    key: signals.key,
    sendback,
    comments: kept.map((comment) => comment.text),
    omitted: foreign.length - kept.length,
    fields,
  };
}
