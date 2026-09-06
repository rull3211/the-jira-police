/**
 * The argument and output shapes for `watch:once`, kept out of the command.
 *
 * `watch-once.ts` ends in a top-level `await`, so importing anything from it
 * runs it. That is the same reason `solve-args.ts` exists, and it is what makes
 * these two functions testable at all.
 */

import type { WatchDecision } from "../watch/decide.ts";

/**
 * The one positional argument, or `null` for "sweep the queue".
 *
 * Pure so the two ways of getting this wrong can be pinned. A flag must not be
 * read as an issue key — `watch:once --write` would otherwise become a request
 * to look at a ticket called `--write`, and the day that flag exists it is a
 * typo that silently examines nothing while reporting a clean sweep. And a
 * second positional is refused rather than ignored, because looking at the
 * first of two named tickets and saying nothing about it reads as having looked
 * at both.
 */
export function watchKey(argv: readonly string[]): string | null {
  const positional = argv.filter((arg) => !arg.startsWith("-"));

  if (positional.length > 1) {
    throw new Error(
      `watch:once takes at most one issue key, got ${positional.length}: ${positional.join(", ")}`,
    );
  }

  return positional[0] ?? null;
}

/**
 * One ticket's decision as one line, because a sweep is read as a table.
 *
 * The three prefixes are padded to the same width and only the two that cost
 * something are capitalised: a queue of quiet tickets is the steady state and
 * should be scannable past, while a `RETRIAGE` is the line that says money is
 * about to be spent once anything is wired to spend it.
 */
export function describeDecision(key: string, decision: WatchDecision): string {
  switch (decision.kind) {
    case "retriage":
      return `RETRIAGE  ${key}  ${decision.trigger} at ${decision.at}`;
    case "unsubscribe":
      return `DROP      ${key}  ${decision.reason} — ${decision.note}`;
    case "quiet":
      return `quiet     ${key}`;
  }
}
