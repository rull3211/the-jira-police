/**
 * How many re-triages a watched ticket has already been given, and how to
 * reserve the next one.
 *
 * **This exists because the obvious counter does not count.** §7b said to read
 * the number off the bot's own comments, for the reason everything else in this
 * service keeps its state in Jira: it survives a restart, a wiped `state/` and a
 * second instance. Then the triage poster turned out to *update its own comment
 * in place* — it finds the previous one by the footer sentinel and rewrites it —
 * so a ticket triaged five times has exactly one comment of ours and the count
 * is zero forever. A brake wired to a stuck odometer is not a brake.
 *
 * **The count has to be a reservation, not a receipt**, which is the same rule
 * §6.3 arrived at for the review marker and for the same reason: written after
 * the run, a failed write hands back a free run on every sweep, forever, on the
 * one loop that spends money with nobody having asked. A comment body cannot
 * carry a reservation, because writing one costs a paid session of its own. A
 * label can: `updateLabels` is REST, free, applied as a server-side delta with
 * no read-modify-write window, and visible to a human on the board.
 *
 * **What makes the label safe from the run it authorises.** A re-triage may
 * clear `agent:*` labels — `INTAKE_INSTRUCTIONS.md` §11 says so — which would be
 * a counter reset by the thing being counted. It cannot happen here, and not
 * merely by convention: `assertPostable` refuses any triage mutation touching an
 * `agent:` label outside `TRIAGE_OWNED_AGENT_LABELS`, which is `agent:solvable`
 * and `agent:watching` and nothing else. The protection is mechanical, in the
 * gate, with a test that fails if the counter namespace is ever added to that
 * set.
 *
 * Pure, and no I/O, so every refusal below is reachable from a plain array.
 */

/** The namespace the count lives in. One label, whose suffix is the number. */
export const RETRIAGE_LABEL_PREFIX = "agent:retriage-";

/**
 * A count of at most four digits, with no leading zero and no zero.
 *
 * Deliberately strict, because this is the only string standing between a
 * watched ticket and an unbounded spend. `agent:retriage-0` means *zero
 * reservations reserved*, which is not a thing that can be written down; a
 * leading zero means two labels could name the same count; and an unbounded
 * digit run is a label somebody can paste to make the arithmetic meaningless.
 * Every one of those is refused rather than interpreted — see `retriageCount`.
 */
const COUNT_PATTERN = /^agent:retriage-([1-9]\d{0,3})$/;

/** Every label in the counter's namespace, in the order given. */
export function retriageLabels(labels: readonly string[]): readonly string[] {
  return labels.filter((label) => label.startsWith(RETRIAGE_LABEL_PREFIX));
}

/**
 * How many re-triages have been reserved on this ticket, or `null` if that
 * cannot be read.
 *
 * **`null` is not zero, and the distinction is the whole guard.** A count that
 * will not read must not read as zero — the marker rule from the review cursor,
 * arriving in a second loop — because losing the count and starting again from
 * one is how a bounded loop quietly becomes an unbounded one. So a malformed
 * label in this namespace refuses the ticket, loudly, rather than being skipped
 * as noise. No label at all *is* zero: that is a ticket nothing has spent on
 * yet, which is the ordinary case and the one the watch exists for.
 *
 * **Several readable labels resolve to the highest**, rather than refusing.
 * That shape has one ordinary cause: a reservation whose add landed and whose
 * remove did not. Taking the maximum spends less than the alternatives and
 * cannot be engineered into spending more, since adding a label can only ever
 * raise the number.
 */
export function retriageCount(labels: readonly string[]): number | null {
  const mine = retriageLabels(labels);
  if (mine.length === 0) {
    return 0;
  }

  let highest = 0;
  for (const label of mine) {
    const digits = COUNT_PATTERN.exec(label)?.[1];
    if (digits === undefined) {
      return null;
    }
    highest = Math.max(highest, Number(digits));
  }
  return highest;
}

/** The label delta that reserves one more re-triage. */
export interface RetriageReservation {
  readonly add: readonly string[];
  readonly remove: readonly string[];
  /** The count the ticket carries once the write lands. */
  readonly count: number;
}

/**
 * The write that must land *before* a re-triage runs.
 *
 * Removes the labels it supersedes in the same delta, so a board shows one
 * counter rather than a growing pile of them, and `updateLabels` applies both
 * halves in one server-side operation — there is no moment where the ticket
 * carries neither.
 *
 * `null` when the current count cannot be read, because reserving from an
 * unreadable base would write a number derived from nothing.
 */
export function reserveRetriage(labels: readonly string[]): RetriageReservation | null {
  const count = retriageCount(labels);
  if (count === null) {
    return null;
  }

  const next = count + 1;
  // The top of the four-digit range, refused here rather than written and
  // refused on the way back in. A ticket cannot reach it under any sane
  // `MAX_RETRIAGE_PER_TICKET`, so this is a ceiling on what a pasted label can
  // do: the answer is that it stops the watch, which is the free direction.
  if (!COUNT_PATTERN.test(`${RETRIAGE_LABEL_PREFIX}${String(next)}`)) {
    return null;
  }

  return {
    add: [`${RETRIAGE_LABEL_PREFIX}${String(next)}`],
    remove: retriageLabels(labels),
    count: next,
  };
}
