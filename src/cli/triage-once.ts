/**
 * Runs one triage and writes the result to the local sink.
 *
 *   node src/cli/triage-once.ts SSX-1234
 *   node src/cli/triage-once.ts SSX-1234 --skill intake-triage
 *
 * Skips discovery entirely: no Jira REST call, no state file, no cursor. It
 * exists to answer "does the skill work on this ticket" without a poll cycle
 * in the way — which makes it the right place to try a new skill first.
 *
 * `--skill` overrides `SKILL_NAME`, which defaults to the mock, so this is safe
 * to run before the real skill is configured.
 */

import { logger } from "../logger.ts";
import { FileSink, type TriageResult } from "../output/sink.ts";
import { readSettings, withConfigErrors } from "../settings.ts";
import { runTriage } from "../triage/runner.ts";
import { buildTriageOptions } from "../wiring.ts";

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const issueKey = argv[0];

  if (issueKey === undefined || issueKey.startsWith("-")) {
    process.stderr.write("usage: triage-once <ISSUE-KEY> [--skill <name>]\n");
    process.exitCode = 2;
    return;
  }

  const skill = flagValue(argv, "--skill");
  const settings = { ...readSettings(), ...(skill === undefined ? {} : { SKILL_NAME: skill }) };

  // The same options the daemon would build, so a run here proves something
  // about the run there rather than about this file.
  const options = buildTriageOptions(settings, issueKey);
  const payload = await runTriage(options);

  const result: TriageResult = {
    issueKey,
    issueUrl: `${settings.JIRA_BASE_URL}/browse/${issueKey}`,
    // Discovery is what knows an issue's summary, and discovery is the half
    // this command skips. Naming that beats inventing a plausible-looking one.
    summary: `${issueKey} (summary not fetched in single-run mode)`,
    verdict: payload.verdict,
    labels: payload.labels,
    recommendedNextStep: payload.recommendedNextStep,
    report: payload.report,
  };

  const sink = new FileSink(settings.OUTPUT_DIR);
  await sink.write(result);

  logger.info("triage-once.written", {
    issueKey,
    verdict: result.verdict,
    path: `${settings.OUTPUT_DIR}/${issueKey}.md`,
    skill: options.skillName,
    vault: options.vaultPath ?? "<none>",
  });
}

await withConfigErrors(main);
