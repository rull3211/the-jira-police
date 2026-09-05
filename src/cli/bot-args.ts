/**
 * The singleton command line, parsed.
 *
 * Same ladder as `solve-args.ts` — same phases, same ordering, same
 * cumulativeness — with one rule added and one meaning changed.
 *
 * ## The rule: an issue key is always required
 *
 * `solve:once` with no key runs the whole queue, because that is what a queue
 * command is for. This command has no queue path at all. It runs triage, and
 * triage is a paid model call against one ticket; "every ticket in the queue"
 * is not a thing to do by accident at the free rung, let alone at `--pr`.
 *
 * Reusing `parseSolveArgs` and then rejecting a null key afterwards is the whole
 * implementation, and it is deliberately that rather than a second parser. The
 * flags, their ordering and the highest-wins rule have exactly one definition;
 * what this module adds is a refusal, which is the only thing that differs.
 *
 * ## The meaning: the free rung is a triage preview, not a queue plan
 *
 * At `plan`, `solve:once` reports the claims the queue would make. Here it runs
 * triage and prints the fitness call, writing nothing to Jira and nothing to a
 * repository. The rung is free in the same sense — no writes — and it is
 * answering a different question: not "would the queue pick this up" but "does
 * triage think an agent can fix it".
 *
 * ## Why there is no `--write` for triage
 *
 * `triage:once` has one, because posting a verdict is the only thing it does and
 * that decision should be typed. Here the decision is already typed, one rung
 * higher: escalating past `plan` requires triage's labels to be on the board,
 * because the claim reads them back and refuses a ticket without
 * `agent:solvable`. So `--claim` implies a triage write not as a convenience but
 * because the alternative is a claim that cannot succeed. A separate flag would
 * only have created the combination that always fails.
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
 * The key is checked before anything is delegated, and the order is the point.
 *
 * `parseSolveArgs` also refuses a keyless `--pr`, but its reason is "it would
 * otherwise run against every ticket in the queue" — a sentence about a queue
 * this command does not have, printed above a usage block that never mentions
 * one. Delegating first and correcting afterwards would have meant matching on
 * that string to recognise it, so the check moved in front instead.
 *
 * The cost is that `bot:once --yolo` reports the missing key rather than the
 * unknown flag. That is the right one to report: naming a ticket is the
 * precondition for this command existing at all, and an operator who supplies
 * one gets the flag error on the next attempt from the parser below.
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
  // Refused rather than quietly ignored. This command's whole shape is triage
  // *then* solve, so there is no pull request for a review round to act on —
  // and an operator who typed `--advance` here wants the other command, not a
  // run that silently did something else with their ticket.
  //
  // `--review` is not this, and the error below names it because the two are
  // easy to confuse from the outside. `--advance` acts on a pull request some
  // earlier run left behind; `--review` opens one and then works it. An operator
  // typing `--advance` at this command usually wants `--review`.
  if (parsed.invocation.mode !== "ladder") {
    return {
      ok: false,
      error:
        "--advance is not a bot:once flag — this command triages a ticket and then solves it, so there is no pull request to advance yet. Use --review to open one and work it in the same run, or solve:once <ISSUE-KEY> --advance to act on one that already exists.",
    };
  }
  return { ok: true, invocation: parsed.invocation };
}
