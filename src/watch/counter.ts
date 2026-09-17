/**
 * How many re-triages a watched ticket has already been given, and how to
 * reserve the next one, kept as a label rather than a count of the bot's own
 * comments (§7b) — the triage poster rewrites its own comment in place, so
 * that count is zero forever.
 *
 * The count is a reservation written before the run, not a receipt written
 * after (§6.3): a failed write must not hand back a free run. `assertPostable`
 * keeps a re-triage's own label clear (`INTAKE_INSTRUCTIONS.md` §11) from
 * touching this namespace, via `TRIAGE_OWNED_AGENT_LABELS`, so the counter
 * can't reset the thing it's counting.
 */

/** The namespace the count lives in. One label, whose suffix is the number. */
export const RETRIAGE_LABEL_PREFIX = "agent:retriage-";

/**
 * A count of at most four digits, with no leading zero and no zero — the only
 * string standing between a watched ticket and an unbounded spend, so a
 * malformed label is refused rather than interpreted (see `retriageCount`).
 */
const COUNT_PATTERN = /^agent:retriage-([1-9]\d{0,3})$/;

/** Every label in the counter's namespace, in the order given. */
export function retriageLabels(labels: readonly string[]): readonly string[] {
  return labels.filter((label) => label.startsWith(RETRIAGE_LABEL_PREFIX));
}

/**
 * How many re-triages have been reserved on this ticket, or `null` if that
 * cannot be read. `null` is not zero: a malformed label must refuse the
 * ticket rather than read as a fresh count. No label at all is zero.
 *
 * Several readable labels resolve to the highest, since a reservation whose
 * add landed and whose remove did not is the only way that shape occurs, and
 * taking the max can't be engineered into overspending.
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
 * The write that must land *before* a re-triage runs. Removes the labels it
 * supersedes in the same delta, applied by `updateLabels` as one server-side
 * operation. `null` when the current count can't be read.
 */
export function reserveRetriage(labels: readonly string[]): RetriageReservation | null {
  const count = retriageCount(labels);
  if (count === null) {
    return null;
  }

  const next = count + 1;
  // Ceiling of the four-digit range: refused here, before the write, rather
  // than round-tripped through Jira first.
  if (!COUNT_PATTERN.test(`${RETRIAGE_LABEL_PREFIX}${String(next)}`)) {
    return null;
  }

  return {
    add: [`${RETRIAGE_LABEL_PREFIX}${String(next)}`],
    remove: retriageLabels(labels),
    count: next,
  };
}
