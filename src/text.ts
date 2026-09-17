/** Text bounds shared by everything that puts untrusted content somewhere it has to fit. */

/**
 * Collapses every whitespace run to one space, so untrusted text cannot forge structure (a
 * heading, a list row) in a document that separates its parts by newline.
 */
export function oneLine(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

/**
 * Trims to a length on a word boundary, marking that it did. Cutting at a space rather than at
 * the raw index avoids ending inside something like `mapToCommerceCar.ts:162`, where the
 * fragment left behind would be a plausible-looking wrong line number.
 */
export function shorten(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const cut = text.slice(0, limit);
  // A cut already on a word boundary keeps the whole word; otherwise the last complete word
  // would be thrown away for nothing.
  if (text[limit] === " ") {
    return `${cut.trimEnd()}…`;
  }
  const space = cut.lastIndexOf(" ");
  // No space to cut at (a limit shorter than the first word) falls back to the hard slice,
  // rather than returning the whole string and capping nothing.
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
