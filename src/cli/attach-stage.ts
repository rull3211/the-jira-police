/**
 * Stages one named ticket's images and reports what a session would be given.
 *
 *   pnpm attach:stage SSX-3917
 *   pnpm attach:stage SSX-3917 --keep
 *
 * **The dry run of the image capability, and for now its only driver.** Nothing
 * in the triage or solve path constructs the stager: this command is step 2 of
 * the privilege ladder in `STARTING.md` — does everything, changes nothing,
 * writes its report for a person to judge — and the passes that will read these
 * files are steps 3 and 4, each behind its own branch.
 *
 * It spends a Jira download and a little disk. It posts nothing, labels
 * nothing, and starts no model session, so the report is the whole output and
 * the cost of being wrong is a directory under `tmpdir()`.
 *
 * `--keep` leaves the staged directory in place, which is how you check the
 * files by eye — or hand one to `storecode` yourself and find out what a model
 * makes of it before any pass is wired to do that unattended. Without it the
 * directory is removed on the way out, including when the report is bad.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_IMAGE_STAGE_OPTIONS,
  describeStagedImages,
  removeStagedImages,
  stageImages,
} from "../attachments/stage.ts";
import { logger } from "../logger.ts";
import { readSettings } from "../settings.ts";
import { createJiraClient } from "../wiring.ts";

function usage(): never {
  process.stderr.write(
    "usage: pnpm attach:stage <ISSUE-KEY> [--keep]\n" +
      "  Downloads the ticket's image attachments, stages them read-only under\n" +
      "  tmpdir(), and prints the block a session would be given. --keep leaves\n" +
      "  the directory behind so you can look at the files.\n",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const keep = args.includes("--keep");
  const key = args.find((argument) => !argument.startsWith("--"));

  if (key === undefined) {
    usage();
  }

  const settings = readSettings();
  const client = createJiraClient(settings);

  const detail = await client.fetchDetail(key);
  process.stdout.write(`${detail.key}  ${detail.summary}\n`);
  process.stdout.write(`attachments on the ticket: ${String(detail.attachments.length)}\n`);
  for (const attachment of detail.attachments) {
    process.stdout.write(
      `  ${attachment.filename}  ${attachment.mimeType}  ${String(attachment.size)} bytes\n`,
    );
  }
  process.stdout.write("\n");

  const parent = join(tmpdir(), "jira-police-attach");
  const result = await stageImages(
    client,
    detail.attachments,
    parent,
    detail.key,
    DEFAULT_IMAGE_STAGE_OPTIONS,
  );

  process.stdout.write(`outcome: ${result.outcome}\n`);
  if (result.outcome === "refused") {
    process.stdout.write(`reason: ${result.reason}\n`);
  }
  process.stdout.write("\n--- the block a session would be given ---\n");
  const block = describeStagedImages(result);
  // "Nothing" is not the same as "no pictures": an SVG is an image and is
  // inlined as text by `solve/ticket.ts`, so a ticket can show this line and
  // still put a picture in front of a session by the older route.
  process.stdout.write(block === "" ? "(nothing — no raster image to stage)\n" : `${block}\n`);

  if (result.outcome !== "staged") {
    // A ticket with no image is the common case and is not a failure of this
    // command. Exit status stays 0 so a wrapper cannot read "nothing to stage"
    // as "the stager is broken".
    return;
  }

  if (keep) {
    process.stdout.write(`\nkept: ${result.directory}\n`);
    process.stdout.write("Remove it yourself — nothing sweeps this directory.\n");
    return;
  }

  await removeStagedImages(result.directory);
  process.stdout.write(`\nremoved: ${result.directory}\n`);
}

try {
  await main();
} catch (error) {
  logger.error("attach-stage.failed", {
    reason: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
