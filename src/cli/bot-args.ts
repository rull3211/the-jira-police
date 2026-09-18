/**
 * The singleton command line, parsed: same ladder as `solve-args.ts`, but an issue key is always
 * required since this command has no queue to run against everything.
 *
 * `--claim` implies the write because escalating past `plan` requires triage's labels already on
 * the board.
 */

import { type ParsedLadderArgs, parseSolveArgs } from "./solve-args.ts";

export const USAGE =
  "usage: bot-once <ISSUE-KEY> [--claim | --solve | --pr | --review]\n" +
  "  <ISSUE-KEY>             triage only; nothing is written anywhere\n" +
  "  <ISSUE-KEY> --claim     ... and writes triage's verdict, then claims the ticket\n" +
  "  <ISSUE-KEY> --solve     ... and runs the solver; nothing is pushed\n" +
  "  <ISSUE-KEY> --pr        ... and opens the draft pull request\n" +
  "  <ISSUE-KEY> --review    ... and works the review to a handover: the whole\n" +
  "                          chain, triage to agent:review-done, in one command\n" +
  "Each flag does everything the ones above it do. Triage's own labels are written\n" +
  "from --claim onward, because the claim refuses a ticket without agent:solvable.\n" +
  "The run stops before the claim if triage says the ticket is not agent-solvable.\n";

/**
 * Checks for a key before delegating: `parseSolveArgs`'s own keyless-`--pr` refusal talks about a
 * queue this command doesn't have, so this command's own message needs to come first.
 */
export function parseBotArgs(argv: readonly string[]): ParsedLadderArgs {
  if (!argv.some((arg) => !arg.startsWith("-"))) {
    return {
      ok: false,
      error: "an issue key is required — this command triages one named ticket, not a queue",
    };
  }
  const parsed = parseSolveArgs(argv);
  if (!parsed.ok) {
    return parsed;
  }
  // Refused rather than silently ignored: this command has no pull request for `--advance` to act on.
  if (parsed.invocation.mode !== "ladder") {
    return {
      ok: false,
      error:
        "--advance is not a bot:once flag — this command triages a ticket and then solves it, so there is no pull request to advance yet. Use --review to open one and work it in the same run, or solve:once <ISSUE-KEY> --advance to act on one that already exists.",
    };
  }
  return { ok: true, invocation: parsed.invocation };
}
