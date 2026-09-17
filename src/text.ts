/**
 * Text bounds shared by everything that puts untrusted content somewhere it has
 * to fit.
 *
 * Top-level beside `duration.ts` rather than inside a slice, because the callers
 * pull in different directions: a bail shortened so a Jira reader will read it,
 * a description bounded before it goes into a prompt, a ticket summary
 * collapsed so it cannot forge a heading in a report. Copying any of them into
 * a second slice would be the defect this repository keeps naming — **a second
 * copy of a rule is a rule that stops agreeing with itself** — and the copy
 * would have been the one guarding the prompt.
 */

/**
 * Collapses every whitespace run to one space, so untrusted text cannot forge
 * structure in a document that separates its parts by newline.
 *
 * A filename or a model's sentence containing a newline followed by `## ` or
 * `- ` writes a heading or a list row that the run never produced, in exactly
 * the artifact a person reads to find out what the run concluded. Markdown's
 * remaining tricks can make a line ugly; none of them can make it lie about
 * structure.
 *
 * Three copies of this existed before it moved here — `report.ts`,
 * `feedback.ts`'s `safeText` and very nearly the image stager — which is the
 * shape this module was created to stop.
 */
export function oneLine(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

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
