/**
 * Measures whether a Slack message's metadata survives a post, a read and an edit in the configured
 * channel — the round trip every audit thread depends on.
 *
 *   pnpm slack:probe
 *   pnpm slack:probe --keep
 *
 * Posts one message and deletes it again; `--keep` leaves it in the channel to look at.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createLogger } from "../logger.ts";
import { readSettings, withConfigErrors } from "../settings.ts";
import { EXIT, exitCodeFor, formatReport, runProbe } from "../slack/probe.ts";
import { createSlackTarget } from "../wiring.ts";

const log = createLogger("slack-probe");

function usage(): never {
  process.stderr.write(
    "usage: pnpm slack:probe [--keep]\n" +
      "  Posts one message with metadata to SLACK_CHANNEL_ID, reads it back, edits it with\n" +
      "  new metadata, reads it back again, and deletes it. Writes the verdict per step to\n" +
      "  <OUTPUT_DIR>/slack-probe.md. --keep leaves the message in the channel.\n" +
      "  Exit: 0 every step passed, 1 a step failed, 2 this usage, 3 the run threw,\n" +
      "  78 SLACK_BOT_TOKEN or SLACK_CHANNEL_ID missing or not a bot token.\n",
  );
  process.exit(EXIT.usage);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== "--keep")) {
    usage();
  }
  const keep = args.includes("--keep");

  const settings = readSettings();
  const { client, channel } = createSlackTarget(settings);
  const now = new Date();

  const result = await runProbe(client, channel, { keep, nonce: randomUUID(), now });
  for (const step of result.steps) {
    process.stdout.write(`${step.ok ? "PASS" : "FAIL"}  ${step.name}  ${step.detail}\n`);
  }

  await mkdir(settings.OUTPUT_DIR, { recursive: true });
  const reportPath = join(settings.OUTPUT_DIR, "slack-probe.md");
  await writeFile(reportPath, formatReport(result, channel, now), "utf8");
  process.stdout.write(`\nreport: ${reportPath}\n`);
  if (result.leftBehind !== null) {
    process.stdout.write(`left in the channel: ts ${result.leftBehind}\n`);
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
