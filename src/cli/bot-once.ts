/**
 * The whole bot against one named ticket: triage, the fitness call, and — if
 * that call says yes — the claim, the solver and the draft pull request.
 *
 *   node src/cli/bot-once.ts SSX-3822           triage only, writes nothing
 *   node src/cli/bot-once.ts SSX-3822 --claim   ... writes the verdict, claims it
 *   node src/cli/bot-once.ts SSX-3822 --solve   ... and solves, nothing pushed
 *   node src/cli/bot-once.ts SSX-3822 --pr      ... and opens the pull request
 *   node src/cli/bot-once.ts SSX-3822 --review  ... and works the review to a handover
 *
 * The last of those is the whole value chain in one command — triage, fitness,
 * claim, solve, verify, push, draft pull request, then rounds against the
 * reviewer until the pull request is out of draft and the ticket is on
 * `agent:review-done`. It is also the only thing in this service that loops
 * without a person between the iterations; `runReviewChain` is where the bounds
 * on that live, and they are worth reading before typing it.
 *
 * ## Why this exists when `triage:once` and `solve:once` already do
 *
 * They do, and running them in sequence is three commands with a human step in
 * the middle, because the queue's manual mode waits for an `agent:start` label.
 * That gate is right for a service polling a board unattended. It is ceremony
 * for an operator who has already chosen the ticket, typed its key, and is
 * watching the output — and ceremony that has to be clicked through in a
 * browser is ceremony people route around by turning the gate off globally.
 *
 * So this command asks for the authorisation in the form the operator is
 * already using: the command line. `ClaimAuthority` is `"named"` here, which
 * satisfies the same requirement `agent:start` satisfies and cannot be reached
 * from `.env` or from the daemon. See that type for why it is not a `SolveMode`.
 *
 * ## What it does not skip
 *
 * **The fitness call.** `agentFitness.solvable === false` ends the run before
 * the claim, printing the blockers. An operator naming a ticket has answered
 * "may this run", which is not the same question as "can an agent fix this" —
 * and the second question is the one triage exists to answer. This is the first
 * thing in the service that acts on that assessment rather than recording it,
 * which is also what finally makes it measurable: until now a wrong `solvable`
 * cost nothing and so told us nothing.
 *
 * **`SOLVE_REPOS`.** Checked in `buildSolveRequest`, unchanged. Naming a ticket
 * says which ticket, not which repositories may be written to.
 *
 * **The issue type.** Auto mode only fires on `SOLVE_AUTO_ISSUE_TYPES` — `Feil`
 * on this board — because a poller choosing its own work should choose the
 * narrowest class. A named ticket has already been chosen, so the filter has
 * nothing left to protect and is not applied. That is the one place this command
 * is broader than auto mode, and it is deliberate: the pilot ticket is an
 * `Oppgave`, and a singleton run that silently refused it would be useless.
 *
 * ## Triage always runs, and always first
 *
 * Even on a ticket triaged an hour ago. The claim reads `agent:solvable` off the
 * board, so a run that skipped triage would depend on a label whose reasoning is
 * no longer in front of anyone — and the fitness call is cheap next to a solve.
 * Running it first also means the solver reads a ticket whose verdict, labels
 * and comment are current, which is the state the recon pass is written for.
 */

import { logger } from "../logger.ts";
import { FileSink } from "../output/sink.ts";
import { type Settings, readSettings, withConfigErrors } from "../settings.ts";
import { syntheticTicket, toTriageResult } from "../triage/single.ts";
import type { AgentFitness } from "../triage/runner.ts";
import { buildTriageOptions, createGroom, createJiraClient } from "../wiring.ts";
import { USAGE, parseBotArgs } from "./bot-args.ts";
import { type SolvePhase, unavailable, writes } from "./solve-args.ts";
import { runWriteRungs } from "./solve-run.ts";

/**
 * What this run may write, decided by the phase and nothing else.
 *
 * `WRITE_BACK` is set both ways rather than only turned on, for the reason
 * `triage:once` learned the hard way: leaving `.env` in charge of the case that
 * matters means a daemon-shaped configuration turns the free rung into a run
 * that posts to a shared ticket. The rung an operator typed is the whole answer.
 */
export function resolveSettings(phase: SolvePhase, base: Settings): Settings {
  return { ...base, WRITE_BACK: writes(phase) ? "true" : "false" };
}

/**
 * Whether the run may escalate past triage, as a sentence when it may not.
 *
 * Separate from the reporting below so the decision can be tested without a
 * model, a board or a captured stdout. It is one boolean and a message, and it
 * is the only place in the service where `agentFitness` changes what happens.
 */
export function fitnessRefusal(fitness: AgentFitness): string | null {
  if (fitness.solvable) {
    return null;
  }
  const blockers =
    fitness.blockers.length === 0
      ? "  (none listed, which is itself a gap — a refusal owes a reason)"
      : fitness.blockers.map((blocker) => `  - ${blocker}`).join("\n");
  return (
    `triage says this ticket is not agent-solvable (confidence: ${fitness.confidence}).\n` +
    `${fitness.rationale}\n\nBlockers:\n${blockers}`
  );
}

async function main(): Promise<void> {
  const args = parseBotArgs(process.argv.slice(2));
  if (!args.ok) {
    process.stderr.write(`${args.error}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const { phase } = args.invocation;
  // The parser guarantees this; the cast is narrowing a type, not assuming one.
  const issueKey = args.invocation.issueKey ?? "";

  const settings = resolveSettings(phase, readSettings());

  // Before the model call, not after. A `--pr` run with no `SOLVE_GITHUB_OWNER`
  // would otherwise pay for a triage, write labels to a shared ticket and solve
  // the thing before discovering it could never have opened the pull request.
  const missing = unavailable(phase, settings);
  if (missing !== null) {
    process.stderr.write(`refusing --${phase}: ${missing}\n`);
    logger.warn("bot-once.refused", { phase, issueKey, reason: missing });
    process.exitCode = 3;
    return;
  }

  const options = buildTriageOptions(settings, issueKey);
  logger.info("bot-once.settings", {
    phase,
    issueKey,
    skill: options.skillName,
    writesToJira: writes(phase),
  });

  // Discovery is the half this command skips; only the key crosses into the
  // skill. Same construction as `triage:once`, and for the same reason.
  const ticket = syntheticTicket(issueKey, settings.JIRA_BASE_URL);

  process.stdout.write(`Triaging ${issueKey}…\n`);
  const payload = await createGroom(settings)(ticket);

  const result = toTriageResult(ticket, payload);
  await new FileSink(settings.OUTPUT_DIR).write(result);

  const fitness = payload.agentFitness;
  process.stdout.write(
    `\nVerdict: ${payload.verdict}\n` +
      `Agent-solvable: ${fitness.solvable ? "yes" : "no"} (confidence: ${fitness.confidence})\n` +
      `Wrote ${settings.OUTPUT_DIR}/${issueKey}.md` +
      `${writes(phase) ? " and posted the verdict to Jira" : "; nothing was written to Jira"}\n`,
  );

  const refusal = fitnessRefusal(fitness);
  if (refusal !== null) {
    process.stdout.write(`\n${refusal}\n\nStopping before the claim.\n`);
    logger.info("bot-once.not-solvable", { issueKey, confidence: fitness.confidence });
    process.exitCode = 3;
    return;
  }

  if (!writes(phase)) {
    process.stdout.write(
      `\n${issueKey} is solvable. Nothing else ran — add --claim, --solve or --pr to go further.\n`,
    );
    return;
  }

  // `null` for the cycle: there is no queue in this command, and saying so is
  // different from reporting the ticket as absent from one.
  await runWriteRungs(settings, createJiraClient(settings), issueKey, phase, null, "named");
}

await withConfigErrors(main);
