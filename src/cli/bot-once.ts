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
 * `--review` is the only thing in this service that loops without a person between
 * iterations; see `runReviewChain` for the bounds on that.
 *
 * `ClaimAuthority` is `"named"` here, reachable only from the CLI.
 *
 * Triage always runs first, even on a ticket triaged recently, because the claim reads
 * `agent:solvable` off the board and the solver needs a current verdict and comment.
 * `SOLVE_AUTO_ISSUE_TYPES` is not applied here, since a named ticket has already been chosen and
 * there's nothing left for the issue-type filter to protect.
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

/** `WRITE_BACK` is set both ways, not just turned on, so a daemon-shaped `.env` can't leak into the free rung. */
export function resolveSettings(phase: SolvePhase, base: Settings): Settings {
  return { ...base, WRITE_BACK: writes(phase) ? "true" : "false" };
}

/** Whether the run may escalate past triage; separated out so this decision is testable without a model or board. */
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
  // The parser guarantees a non-null key; this narrows the type, not assumes it.
  const issueKey = args.invocation.issueKey ?? "";

  const settings = resolveSettings(phase, readSettings());

  // Checked before the model call, so a run that can never open a PR doesn't pay for triage and solve first.
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

  // Discovery is skipped; only the key crosses into the skill, same as `triage:once`.
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

  // `null` cycle: there is no queue here, distinct from reporting the ticket absent from one.
  await runWriteRungs(settings, createJiraClient(settings), issueKey, phase, null, "named");
}

await withConfigErrors(main);
