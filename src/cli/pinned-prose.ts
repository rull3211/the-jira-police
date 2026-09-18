/**
 * `CLAUDE.md` copies `FINISHING.md`'s four checklist questions verbatim, which is normally
 * forbidden (a fact with two homes drifts silently) — this module is what makes the copy a
 * *checked* one, the one exemption `docs-check.ts` allows. The copy exists because those four
 * questions have no command behind them and are exactly what a compacted context loses first;
 * `CLAUDE.md` is the one file guaranteed to survive that.
 *
 * Separate from `docs-check.ts` because importing that file runs `vitest list`, which from inside
 * a test would spawn vitest within vitest.
 */

/**
 * Collapses every run of whitespace — and a blockquote's `> ` prefix — into a single space.
 *
 * Both sides of every comparison here are flattened first, because `oxfmt` reflows prose and a
 * literal-space pattern is a bet against the formatter that this codebase has already lost.
 */
export function flatten(text: string): string {
  return text.replaceAll(/\s+(?:>\s*)?/gu, " ").trim();
}

/**
 * Where the checklist starts and stops in `FINISHING.md`. `session-brief.sh` slices the same
 * section with the same two markers in awk, a second implementation that can't import this one —
 * renaming the heading must break both loudly, not just one.
 */
const CHECKLIST_OPENS = "## The checklist";
const CHECKLIST_CLOSES = "**And the rules";

/**
 * How many questions the checklist is known to have, declared rather than derived: a reworded list
 * marker should make the extractor find too few, not silently derive and report zero as correct.
 */
export const CHECKLIST_QUESTIONS = 4;

/**
 * The bold headline of each checklist question, in order. Flattened *before* extraction, not
 * after — matching line-by-line breaks the moment a headline wraps, as `session-brief.sh`'s awk did.
 */
export function checklistHeadlines(finishing: string): string[] {
  const opens = finishing.indexOf(CHECKLIST_OPENS);
  if (opens === -1) {
    return [];
  }

  const after = finishing.slice(opens + CHECKLIST_OPENS.length);
  const closes = after.indexOf(CHECKLIST_CLOSES);
  const section = closes === -1 ? after : after.slice(0, closes);

  return [...flatten(section).matchAll(/- \[ \] \*\*(.+?)\*\*/gu)].map((match) => match[1] ?? "");
}

/**
 * Every way the copy in `CLAUDE.md` can be wrong, as messages ready to print. Compares headline
 * text only, without `**` markers, so `CLAUDE.md` may format the questions however it likes.
 */
export function pinnedProseProblems(finishing: string, claude: string): string[] {
  const headlines = checklistHeadlines(finishing);

  if (headlines.length !== CHECKLIST_QUESTIONS) {
    return [
      `FINISHING.md's checklist: expected ${CHECKLIST_QUESTIONS} question(s), extracted ` +
        `${headlines.length}.\n` +
        `  The copy in CLAUDE.md is not necessarily wrong — this check has stopped being able to\n` +
        `  read the original. Either the "${CHECKLIST_OPENS}" heading was renamed, the list markers\n` +
        `  changed, or a question was added or removed. If the count genuinely changed, update\n` +
        `  CHECKLIST_QUESTIONS in src/cli/pinned-prose.ts and the copy in CLAUDE.md together.`,
    ];
  }

  const body = flatten(claude);
  const problems: string[] = [];

  for (const headline of headlines) {
    if (!body.includes(flatten(headline))) {
      problems.push(
        `CLAUDE.md is missing a checklist question that FINISHING.md still asks:\n` +
          `  "${headline}"\n` +
          `  CLAUDE.md copies these four deliberately, because it is the only file a compacted\n` +
          `  context is guaranteed to still have. Re-copy the headline, or if the question was\n` +
          `  retired, remove it from FINISHING.md first — that file is the original.`,
      );
    }
  }

  return problems;
}
