/**
 * Measures both halves of the audit thread's store against the real systems: a Slack message posted,
 * edited and deleted in SLACK_CHANNEL_ID, a reply to it sent to the channel, edited and deleted, and
 * a record written to, read back from and deleted on the ticket named. With SLACK_OPERATOR_USER_ID
 * set, also a direct message to that person, deleted.
 *
 *   pnpm slack:probe SSX-1234
 *   pnpm slack:probe SSX-1234 --keep
 *
 * Leaves nothing behind unless `--keep`, which leaves the messages and the property to look at.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { assertIssueKey } from "../jira/client.ts";
import { createLogger } from "../logger.ts";
import { readSettings, withConfigErrors } from "../settings.ts";
import { EXIT, PROBE_PROPERTY, exitCodeFor, formatReport, runProbe } from "../slack/probe.ts";
import { createJiraClient, createSlackTarget, operatorUserId } from "../wiring.ts";

const log = createLogger("slack-probe");

function usage(): never {
  process.stderr.write(
    "usage: pnpm slack:probe <ISSUE-KEY> [--keep]\n" +
      "  Posts one message to SLACK_CHANNEL_ID and edits it, sends a reply to the channel,\n" +
      "  edits that and deletes it, then deletes the message; with\n" +
      "  SLACK_OPERATOR_USER_ID set, sends that person a direct message and deletes it; then\n" +
      `  writes the ${PROBE_PROPERTY} issue property on the ticket, reads it back and deletes\n` +
      "  it. Writes the verdict per step to <OUTPUT_DIR>/slack-probe.md. --keep leaves all.\n" +
      "  Exit: 0 every step passed, 1 a step failed, 2 this usage, 3 the run threw,\n" +
      "  78 a setting missing, a token that is not a bot token, a malformed member ID, or a\n" +
      "  keychain dialog denied.\n",
  );
  process.exit(EXIT.usage);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const keys = args.filter((argument) => !argument.startsWith("--"));
  const flags = args.filter((argument) => argument.startsWith("--"));
  const issueKey = keys[0];
  if (issueKey === undefined || keys.length > 1 || flags.some((flag) => flag !== "--keep")) {
    usage();
  }
  try {
    assertIssueKey(issueKey);
  } catch {
    usage();
  }

  const settings = readSettings();
  const { client: slack, channel } = createSlackTarget(settings);
  const target = {
    channel,
    operator: operatorUserId(settings),
    issueKey,
    keep: flags.includes("--keep"),
    nonce: randomUUID(),
    now: new Date(),
  };

  const result = await runProbe(slack, createJiraClient(settings), target);
  for (const step of result.steps) {
    process.stdout.write(`${step.ok ? "PASS" : "FAIL"}  ${step.name}  ${step.detail}\n`);
  }

  await mkdir(settings.OUTPUT_DIR, { recursive: true });
  const reportPath = join(settings.OUTPUT_DIR, "slack-probe.md");
  await writeFile(reportPath, formatReport(result, target), "utf8");
  process.stdout.write(`\nreport: ${reportPath}\n`);
  if (result.messageLeft !== null) {
    process.stdout.write(`left in the channel: ts ${result.messageLeft}\n`);
  }
  if (result.replyLeft !== null) {
    process.stdout.write(`left in the channel, as a broadcast reply: ts ${result.replyLeft}\n`);
  }
  if (result.directLeft !== null) {
    process.stdout.write(
      `left with ${target.operator ?? "the operator"}: ${result.directLeft.channel}, ts ${result.directLeft.ts}\n`,
    );
  }
  if (result.propertyLeft) {
    process.stdout.write(`left on ${issueKey}: ${PROBE_PROPERTY}\n`);
  }

  process.exitCode = exitCodeFor(result);
}

try {
  await withConfigErrors(main);
} catch (error) {
  log.error("slack-probe.failed", {
    reason: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = EXIT.threw;
}
