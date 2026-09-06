/**
 * Text bounds shared by everything that puts untrusted content somewhere it has
 * to fit.
 *
 * Top-level beside `duration.ts` rather than inside a slice, because it has two
 * callers in two different directions now: `solve/feedback.ts` shortening a
 * bail so a Jira reader will read it, and `watch/context.ts` bounding a
 * description before it goes into a prompt. Copying it into the second would be
 * the defect this repository keeps naming — **a second copy of a rule is a rule
 * that stops agreeing with itself** — and the copy would have been the one
 * guarding the prompt.
 */

/**
 * Trims to a length on a word boundary, marking that it did.
 *
 * The ellipsis is not decoration. A silently-cut sentence reads as a model that
 * stopped mid-thought, which is a bug report someone will file; a marked one reads
 * as a harness that shortened something, which is what happened. Cutting at a space
 * rather than at the index avoids ending inside `mapToCommerceCar.ts:162`, where the
 * fragment left behind would be a plausible-looking wrong line number.
 *
 * Nothing is lost by this: the full text is in the run's own log, and the reader
 * this was written for is deciding whether to split a ticket or whether a
 * sendback was answered, not auditing the source.
 */
export function shorten(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const cut = text.slice(0, limit);
  // A cut that already lands on a word boundary keeps the whole word. Without
  // this the last complete word is thrown away for nothing, which is most
  // visible on the short limits — it turned "the validation lives" into "the
  // validation" and made the ellipsis look like it had eaten a clause.
  if (text[limit] === " ") {
    return `${cut.trimEnd()}…`;
  }
  const space = cut.lastIndexOf(" ");
  // A limit shorter than the first word leaves no space to cut at. Falling back
  // to the hard slice is right: the alternative is returning the whole string,
  // which is a cap that stops capping exactly when the text is most unusual.
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
