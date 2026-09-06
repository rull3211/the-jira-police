/**
 * The argument and output shapes for `watch:once`, kept out of the command.
 *
 * `watch-once.ts` ends in a top-level `await`, so importing anything from it
 * runs it. That is the same reason `solve-args.ts` exists, and it is what makes
 * these two functions testable at all.
 */

import type { WatchDecision } from "../watch/decide.ts";
import type { RetriageOutcome } from "../watch/retriage.ts";

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

/** Every flag this command knows. Anything else is refused — see `watchWrites`. */
const WATCH_FLAGS: ReadonlySet<string> = new Set(["--write"]);

/**
 * Whether the run may act on its decisions.
 *
 * **It was `--unsubscribe` until the re-triage hand-off landed, and the rename
 * is the flag catching up with what it does.** The narrow name was honest while
 * only one of three outcomes had a writer: a `--write` that did nothing on the
 * outcome that matters most, while reporting a clean run, is this project's own
 * defect class spelled as a command-line flag. Both outcomes now have writers,
 * so the honest name is the broad one — and it has to change, because a flag
 * that reads as a brake is the wrong label on the switch that arms the engine.
 *
 * **An unrecognised flag is an error, which is what makes the rename safe.**
 * `watchKey` filters anything beginning with `-` out of the positionals, so
 * without this an operator's muscle memory for `--unsubscribe` would produce a
 * silent dry run reporting a clean sweep over tickets it declined to touch —
 * the same divergence, arriving through the rename that was meant to close it.
 */
export function watchWrites(argv: readonly string[]): boolean {
  const unknown = argv.filter((arg) => arg.startsWith("-") && !WATCH_FLAGS.has(arg));
  if (unknown.length > 0) {
    throw new Error(
      `watch:once does not know ${unknown.join(", ")} (--unsubscribe is now --write); accepted: ${[...WATCH_FLAGS].join(", ")}`,
    );
  }

  return argv.includes("--write");
}

/**
 * One ticket's decision as one line, because a sweep is read as a table.
 *
 * The three prefixes are padded to the same width and only the two that cost
 * something are capitalised: a queue of quiet tickets is the steady state and
 * should be scannable past, while a `RETRIAGE` is the line that says money is
 * about to be spent once anything is wired to spend it.
 */
/**
 * What acting on a `retriage` decision actually did, as the line under it.
 *
 * Four of the five outcomes are refusals and each gets its own words rather
 * than a shared "skipped": they are the difference between *nobody answered*,
 * *the counter is broken* and *Jira would not take the write*, and an operator
 * reading a sweep to decide whether the watch is safe to arm needs to tell them
 * apart. The one that spent money says so with the number it spent it against,
 * because that number is the brake and a sweep is where you find out it moved.
 */
export function describeRetriage(outcome: RetriageOutcome): string {
  switch (outcome.kind) {
    case "retriaged":
      return `re-triaged (attempt ${outcome.count}) → ${outcome.payload.verdict} — ${outcome.reason}`;
    case "irrelevant":
      return `no re-triage: ${outcome.reason}`;
    case "unreserved":
      return `no re-triage: the attempt would not reserve — ${outcome.error}`;
    case "uncountable":
      return "no re-triage: the counter on this ticket will not read";
    case "no-mark":
      return "no re-triage: no comment of ours to measure from";
  }
}

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
