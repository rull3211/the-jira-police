/**
 * The argument and output shapes for `watch:once`, kept out of the command.
 *
 * `watch-once.ts` ends in a top-level `await`, so importing anything from it runs it — the same
 * reason `solve-args.ts` exists.
 */

import type { WatchDecision } from "../watch/decide.ts";
import type { RetriageOutcome } from "../watch/retriage.ts";

/**
 * The one positional argument, or `null` for "sweep the queue".
 *
 * A flag must not be read as an issue key — `watch:once --write` would otherwise look at a
 * ticket called `--write` and silently examine nothing. A second positional is refused rather
 * than ignored, since looking at only the first of two named tickets reads as having looked at both.
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
 * An unrecognised flag is an error rather than ignored — `watchKey` already filters anything
 * beginning with `-` out of the positionals, so without this a mistyped flag would produce a
 * silent dry run reporting a clean sweep over tickets it declined to touch.
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
 * The three prefixes are padded to the same width; only the two that cost something are
 * capitalised, so a queue of quiet tickets stays scannable past.
 */
/**
 * What acting on a `retriage` decision actually did, as the line under it.
 *
 * Four of the five outcomes are refusals, each with its own words rather than a shared
 * "skipped" — an operator deciding whether the watch is safe to arm needs to tell them apart.
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
