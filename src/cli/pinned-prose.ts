/**
 * The prose `CLAUDE.md` is allowed to copy, and the check that makes copying it
 * safe.
 *
 * `STARTING.md` forbids a fact with two homes, because two homes means one
 * maintainer and silent drift. `docs-check.ts` states the one exemption in its
 * header: something this check verifies *in every place it appears* no longer
 * has that problem, so copying a **checked** thing is fine and copying an
 * unchecked one is not. This module is what makes the checklist a checked thing.
 *
 * Why the checklist earns the exemption at all. `FINISHING.md`'s four questions
 * are the only part of the working contract with no command behind them — every
 * other rule is either enforced by a hook, a test or `docs:check`, so skipping
 * it eventually goes red. These four go unnoticed. They are also the part a
 * compacted context is least likely to have: `CLAUDE.md` is re-injected whether
 * or not anything is registered, and the phase files are model-invoked, so
 * `FINISHING.md` is exactly what gets summarised away. Copying four lines into
 * the file that always survives is the cheapest carrier that needs no hook and
 * no compliance.
 *
 * This module is separate from `docs-check.ts` rather than inside it because
 * that file is a script: importing it runs `vitest list`, which from inside a
 * test would spawn vitest within vitest. The logic that needs a test therefore
 * lives where a test can reach it.
 */

/**
 * Collapse every run of whitespace — and the `> ` that a blockquote puts on a
 * continuation line — into a single space.
 *
 * Both sides of every comparison here are flattened first, because `oxfmt`
 * reflows Markdown prose and a copy that is correct but wrapped in a different
 * place is not a defect. That is not caution: it is the failure that disabled
 * half of the count check in this same command twice, documented at the top of
 * `docs-check.ts`. A literal space inside a pattern is a bet that the
 * repository's own formatter will not put a newline there, and it is a bet that
 * has already lost.
 */
export function flatten(text: string): string {
  return text.replaceAll(/\s+(?:>\s*)?/gu, " ").trim();
}

/**
 * Where the checklist starts and stops in `FINISHING.md`. The hook
 * `session-brief.sh` slices the same section with the same two markers; they
 * are two implementations because one is awk inside a hook and this is
 * TypeScript, and neither can import the other. That is survivable only because
 * renaming the heading breaks **both loudly** — the hook prints nothing, which
 * `test-hooks.sh` asserts against, and this check reports finding too few
 * questions rather than silently finding none.
 */
const CHECKLIST_OPENS = "## The checklist";
const CHECKLIST_CLOSES = "**And the rules";

/**
 * How many questions the checklist is known to have.
 *
 * Declared rather than derived, for the reason `docs-check.ts` declares
 * `expectSites`: the failure mode being designed against is not a wrong copy,
 * it is the extractor quietly stopping. Reword the list markers and a derived
 * count finds zero, compares nothing, and reports green forever. Finding fewer
 * than this is a failure with the same weight as a copy that has drifted.
 */
export const CHECKLIST_QUESTIONS = 4;

/**
 * The bold headline of each checklist question, in order.
 *
 * The section is flattened *before* the questions are picked out of it, not
 * after. Matching line-by-line looks correct in the file and breaks the moment
 * a headline wraps — which is the same defect `session-brief.sh` hit when its
 * awk took only the first line of each item and cut every sentence in half.
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
 * Every way the copy in `CLAUDE.md` can be wrong, as messages ready to print.
 *
 * The comparison is on the headline text without its `**` markers, so
 * `CLAUDE.md` may present the questions however it likes — as a task list, a
 * table, prose — and only the words are pinned. Pinning the formatting too
 * would make this fail on changes that are not drift.
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
