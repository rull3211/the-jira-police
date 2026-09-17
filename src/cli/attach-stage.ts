/**
 * Stages one named ticket's images and reports what a session would be given.
 *
 *   pnpm attach:stage SSX-3917
 *   pnpm attach:stage SSX-3917 --keep
 *
 * **The dry run of the image capability, and no longer its only driver.**
 * Triage constructs the stager behind `TRIAGE_IMAGES` (`wiring.ts:320`); the
 * solve path still does not. This command remains step 2 of the privilege
 * ladder in `STARTING.md` — does everything, changes nothing, writes its report
 * to a file to be judged — and is the only way to see the staged files
 * themselves, since a pass removes its directory on the way out.
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

import { mkdir, writeFile } from "node:fs/promises";
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
import { EXIT, exitCodeFor, formatReport } from "./attach-stage-report.ts";

function usage(): never {
  process.stderr.write(
    "usage: pnpm attach:stage <ISSUE-KEY> [--keep]\n" +
      "  Downloads the ticket's image attachments, stages them read-only under\n" +
      "  tmpdir(), and writes the block a session would be given to\n" +
      "  <OUTPUT_DIR>/<KEY>.attachments.md. --keep leaves the directory behind\n" +
      "  so you can look at the files.\n" +
      "  Exit: 0 staged or nothing on the ticket to stage, 1 the ticket has\n" +
      "  images and they are not staged, 2 this usage, 3 the run threw.\n",
  );
  process.exit(EXIT.usage);
}

async function main(): Promise<number> {
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
  // "Nothing" is not the same as "no pictures": an SVG is an image and is
  // inlined as text by `solve/ticket.ts`, so a ticket can show this line and
  // still put a picture in front of a session by the older route.
  const block = describeStagedImages(result);
  process.stdout.write(block === "" ? "(nothing — no raster image to stage)\n" : `${block}\n`);

  const staged = result.outcome === "staged" ? result.directory : null;
  if (staged !== null && !keep) {
    await removeStagedImages(staged);
  }
  const keptAt = staged !== null && keep ? staged : null;

  // Written after the removal so the report states what is actually on disk
  // now, rather than what was there while it ran.
  await mkdir(settings.OUTPUT_DIR, { recursive: true });
  const reportPath = join(settings.OUTPUT_DIR, `${detail.key}.attachments.md`);
  await writeFile(reportPath, formatReport(detail, result, new Date(), keptAt), "utf8");
  process.stdout.write(`\nreport: ${reportPath}\n`);

  if (keptAt !== null) {
    process.stdout.write(`kept: ${keptAt}\n`);
    // The tree is `0o555`/`0o444` on purpose, which also means the obvious
    // removal fails. Saying "remove it yourself" without saying how is how the
    // one on this machine survived a week.
    process.stdout.write(
      "Nothing sweeps this directory, and the tree is read-only, so remove it with:\n" +
        `  chmod -R u+w ${keptAt} && rm -r ${keptAt}\n`,
    );
  } else if (staged !== null) {
    process.stdout.write(`removed: ${staged}\n`);
  }

  return exitCodeFor(result);
}

try {
  process.exitCode = await main();
} catch (error) {
  logger.error("attach-stage.failed", {
    reason: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = EXIT.failed;
}
