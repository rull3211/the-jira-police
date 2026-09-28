/**
 * Draws one ticket's Slack thread from its audit record, creating the thread if it has none.
 *
 *   pnpm slack:once SSX-1234
 *   pnpm slack:once SSX-1234 --post
 *
 * Dry by default: reads the ticket and its record, and writes the record and the exact Slack request
 * under <OUTPUT_DIR>/slack/. `--post` posts or edits the thread and saves the record on the ticket.
 */

import { join } from "node:path";

import { assertIssueKey } from "../jira/client.ts";
import { createLogger } from "../logger.ts";
import { readSettings, withConfigErrors } from "../settings.ts";
import { auditNotifierFor, createJiraClient } from "../wiring.ts";

const log = createLogger("slack-once");

const EXIT = { ok: 0, failed: 1, usage: 2, threw: 3 } as const;

function usage(): never {
  process.stderr.write(
    "usage: pnpm slack:once <ISSUE-KEY> [--post]\n" +
      "  Draws the ticket's audit thread from the record on the ticket, creating it if absent.\n" +
      "  Dry by default: writes <OUTPUT_DIR>/slack/<KEY>.record.json and <KEY>.message.json\n" +
      "  and changes nothing remote. --post posts or edits the Slack message and saves the\n" +
      "  record as the ticket's jira-police.slack property.\n" +
      "  Exit: 0 drawn, 1 not drawn (the log line says why), 2 this usage, 3 the run threw,\n" +
      "  78 a setting missing, a token that is not a bot token, or a keychain dialog denied.\n",
  );
  process.exit(EXIT.usage);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const keys = args.filter((argument) => !argument.startsWith("--"));
  const flags = args.filter((argument) => argument.startsWith("--"));
  const issueKey = keys[0];
  if (issueKey === undefined || keys.length > 1 || flags.some((flag) => flag !== "--post")) {
    usage();
  }
  try {
    assertIssueKey(issueKey);
  } catch {
    usage();
  }
  const post = flags.includes("--post");

  const settings = readSettings();
  const detail = await createJiraClient(settings).fetchDetail(issueKey);
  const notifier = auditNotifierFor(settings, post ? "live" : "dry");

  const outcome = await notifier.redraw(issueKey, { summary: detail.summary, url: detail.url });

  if (outcome.kind === "skipped" || outcome.kind === "failed") {
    process.stderr.write(`\n${issueKey}: not drawn (${outcome.kind}) — ${outcome.reason}\n`);
    process.exitCode = EXIT.failed;
    return;
  }
  const verb = outcome.kind === "posted" ? "posted" : "edited";
  process.stdout.write(
    post
      ? `\n${issueKey}: thread ${verb} in Slack, record saved on the ticket.\n`
      : `\n${issueKey}: dry run, would have ${verb} — see ${join(settings.OUTPUT_DIR, "slack", `${issueKey}.message.json`)}\n`,
  );
}

try {
  await withConfigErrors(main);
} catch (error) {
  log.error("slack-once.failed", {
    reason: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = EXIT.threw;
}
