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
 * Whether the run may act on an `unsubscribe`, and nothing else.
 *
 * **It is `--unsubscribe` rather than `--write`, and the narrow name is the
 * honest one.** A decision has three outcomes and only one of them has a
 * writer: the re-triage hand-off is not built. A `--write` flag would therefore
 * do nothing on the outcome that matters most, while still reporting a
 * successful run — which is this project's own defect class spelled as a
 * command-line flag.
 *
 * The name also matches what the flag turns on rather than how much privilege
 * it grants, and those differ here in the reassuring direction: unsubscribing
 * only ever *stops* the watcher spending. It is the brake, and it ships before
 * the engine so that the engine cannot be armed without one.
 *
 * When the re-triage lands this becomes `--write`, which is what the plan's
 * command table has always called it.
 */
export function watchWrites(argv: readonly string[]): boolean {
  return argv.includes("--unsubscribe");
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
