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

import { shorten } from "../text.ts";
import {
  BLOCKER_CLEARING_FIELDS,
  isOurComment,
  lastSpokeAt,
  touchedAt,
  type WatchContent,
  type WatchSignals,
} from "./decide.ts";
import type { EditedField, RelevanceInput } from "./relevance.ts";

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

/**
 * How much of one edited field the check is shown.
 *
 * Generous next to a comment, because a description is the field a sendback
 * most often asks to be filled in and the answer is usually appended to the
 * end of one that was already long. Bounded all the same: this is
 * attacker-controlled text going into a prompt, and "however long the reporter
 * made it" is not a bound.
 */
export const MAX_FIELD_CHARS = 4000;

/**
 * How many attachments are named.
 *
 * Names only, so each costs a line. A ticket past this many is one where the
 * question *did they attach what we asked for* is not going to be settled by
 * reading a longer list.
 */
export const MAX_CONTEXT_ATTACHMENTS = 20;

function parsed(iso: string): number {
  return Date.parse(iso);
}

/** `12345` → `12.1 KB`, so a size reads as a size rather than as a number. */
function sizeOf(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "unknown size";
  }
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * What one moved field now says.
 *
 * **An empty field still gets an entry.** A reporter who cleared the
 * description moved it, and dropping the section would leave the check reading
 * a ticket where nothing appeared to change — the same blindness this whole
 * change is closing, arriving through an omission instead of a missing fetch.
 * `content` is empty and the prompt says the field is empty.
 */
function contentOf(name: string, content: WatchContent): string {
  switch (name) {
    case "description":
      return content.description;
    case "summary":
      return content.summary;
    case "environment":
      return content.environment;
    case "attachment":
      return content.attachments
        .slice(0, MAX_CONTEXT_ATTACHMENTS)
        .map(
          (file) => `${file.filename} (${file.mimeType || "unknown type"}, ${sizeOf(file.size)})`,
        )
        .join("\n");
    default:
      // Unreachable while the caller filters on `BLOCKER_CLEARING_FIELDS`, and
      // an empty string rather than a throw because the failure it would cause
      // — a check told a field moved and shown nothing — is the one already
      // being fixed, not a reason to abandon the whole re-triage.
      return "";
  }
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

  const moved = [
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

  // **Content for the fields that moved, and for no others.** The ticket's
  // whole current state is on `signals.content` and handing all of it over
  // would be cheaper to write and worse to answer: a description that has said
  // the same thing since triage is not evidence the reporter responded, and a
  // check shown it will find the sendback's words in it and say yes. The same
  // filter argument the field *names* already carry, applied one level down.
  const fields: readonly EditedField[] = moved.map((name) => {
    const full = contentOf(name, signals.content).trim();
    return {
      name,
      content: shorten(full, MAX_FIELD_CHARS),
      truncated: full.length > MAX_FIELD_CHARS,
    };
  });

  return {
    key: signals.key,
    sendback,
    comments: kept.map((comment) => comment.text),
    omitted: foreign.length - kept.length,
    fields,
  };
}
