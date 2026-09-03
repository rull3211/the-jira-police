/**
 * Runs one triage and writes the result to the local sink.
 *
 *   node src/cli/triage-once.ts SSX-1234
 *   node src/cli/triage-once.ts SSX-1234 --skill intake-triage
 *   node src/cli/triage-once.ts SSX-1234 --write
 *
 * Skips discovery entirely: no Jira REST call, no state file, no cursor. It
 * exists to answer "does the skill work on this ticket" without a poll cycle
 * in the way — which makes it the right place to try a new skill first.
 *
 * `--skill` overrides `SKILL_NAME`, which defaults to the mock, so this is safe
 * to run before the real skill is configured.
 *
 * `--write` decides `WRITE_BACK` for this run, and exists so the first real
 * comment the service ever posts is one an operator chose, on a ticket they
 * picked, rather than whichever issue the poller happened to find first. There
 * is no `--no-write` counterpart: preview is the default, and the override that
 * needs to be deliberate is the one that mutates a shared ticket.
 *
 * Note "decides", not "overrides". This previously only *added* `WRITE_BACK`
 * when the flag was present, which left `.env` in charge of the case that
 * matters: with `WRITE_BACK=true` configured for the daemon, a `triage:once`
 * run with no flag would post to the ticket, and the flag whose entire purpose
 * is to make that deliberate became decorative. The value is now set both ways
 * from the flag alone, so what this command does to a shared ticket is legible
 * from the command line that started it.
 */

import type { TicketRef } from "../jira/types.ts";
import { logger } from "../logger.ts";
import { FileSink, type TriageResult } from "../output/sink.ts";
import { type Settings, readSettings, withConfigErrors } from "../settings.ts";
import { buildTriageOptions, createGroom, shouldPost } from "../wiring.ts";

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

/**
 * The command line's last word on what this run may do.
 *
 * Split out from `main` so it can be tested without starting a subprocess. That
 * is not ceremony: the one thing worth asserting about this command is that an
 * operator who does not type `--write` cannot post to a shared ticket no matter
 * what `.env` says, and until this was a function there was nowhere to assert it.
 */
export function resolveSettings(argv: readonly string[], base: Settings): Settings {
  const skill = flagValue(argv, "--skill");
  return {
    ...base,
    ...(skill === undefined ? {} : { SKILL_NAME: skill }),
    WRITE_BACK: argv.includes("--write") ? "true" : "false",
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const issueKey = argv[0];

  if (issueKey === undefined || issueKey.startsWith("-")) {
    process.stderr.write("usage: triage-once <ISSUE-KEY> [--skill <name>] [--write]\n");
    process.exitCode = 2;
    return;
  }

  const settings = resolveSettings(argv, readSettings());

  // The same three steps the daemon runs — analyse, gate, post — rather than a
  // bare `runTriage`. Calling the analyst directly would make this command a
  // rehearsal of something the service does not do, and would quietly skip the
  // check that decides whether the verdict is fit to publish.
  const options = buildTriageOptions(settings, issueKey);
  const groom = createGroom(settings);

  // Discovery is what knows an issue's summary, and discovery is the half this
  // command skips. The remaining fields are unused by grooming: only the key
  // crosses into the skill.
  const ticket: TicketRef = {
    key: issueKey,
    summary: `${issueKey} (summary not fetched in single-run mode)`,
    url: `${settings.JIRA_BASE_URL}/browse/${issueKey}`,
    created: new Date().toISOString(),
    updated: "",
    labels: [],
    issueTypeId: "",
    issueTypeName: "",
  };

  const payload = await groom(ticket);

  const result: TriageResult = {
    issueKey,
    issueUrl: ticket.url,
    summary: ticket.summary,
    verdict: payload.verdict,
    labels: payload.labels,
    recommendedNextStep: payload.recommendedNextStep,
    report: payload.report,
    agentFitness: payload.agentFitness,
  };

  const sink = new FileSink(settings.OUTPUT_DIR);
  await sink.write(result);

  logger.info("triage-once.written", {
    issueKey,
    verdict: result.verdict,
    path: `${settings.OUTPUT_DIR}/${issueKey}.md`,
    skill: options.skillName,
    vault: options.vaultPath ?? "<none>",
    // Whether the ticket itself was touched is the one fact worth being able to
    // grep for afterwards.
    wroteToJira: shouldPost(settings),
  });
}

await withConfigErrors(main);
