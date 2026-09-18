/**
 * Runs one triage and writes the result to the local sink.
 *
 *   node src/cli/triage-once.ts SSX-1234
 *   node src/cli/triage-once.ts SSX-1234 --skill intake-triage
 *   node src/cli/triage-once.ts SSX-1234 --write
 *
 * Skips discovery entirely — no Jira REST call, no state file, no cursor — to answer "does the
 * skill work on this ticket" without a poll cycle in the way.
 *
 * `--skill` overrides `SKILL_NAME`, which defaults to the mock. `--write` sets `WRITE_BACK` for
 * this run in both directions from the flag alone, never inherited from `.env` — so a run with no
 * flag never posts to a shared ticket regardless of the daemon's own configuration.
 */

import { createLogger } from "../logger.ts";
import { FileSink } from "../output/sink.ts";
import { type Settings, readSettings, withConfigErrors } from "../settings.ts";
import { syntheticTicket, toTriageResult } from "../triage/single.ts";
import { buildTriageOptions, createGroom, shouldPost } from "../wiring.ts";

const log = createLogger("triage-once");

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

/**
 * The command line's last word on what this run may do.
 *
 * Split out from `main` so it can be tested without starting a subprocess: the one thing worth
 * asserting is that an operator who omits `--write` cannot post regardless of `.env`.
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

  // The same three steps the daemon runs — analyse, gate, post — not a bare `runTriage`, which
  // would skip the check that decides whether the verdict is fit to publish.
  const options = buildTriageOptions(settings, issueKey);
  const groom = createGroom(settings);

  // Discovery is what knows an issue's summary, and discovery is the half this command skips —
  // only the key crosses into the skill.
  const ticket = syntheticTicket(issueKey, settings.JIRA_BASE_URL);

  const payload = await groom(ticket);

  const result = toTriageResult(ticket, payload);

  const sink = new FileSink(settings.OUTPUT_DIR);
  await sink.write(result);

  log.info("triage-once.written", {
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
