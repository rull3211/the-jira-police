/**
 * Stages one named ticket's images and reports what a session would be given.
 *
 *   pnpm attach:stage SSX-3917
 *   pnpm attach:stage SSX-3917 --keep
 *
 * Dry run: posts nothing, labels nothing, starts no model session. `--keep` is the only way to
 * see the staged files by eye, since a pass removes its directory on the way out.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describeStagedImages, removeStagedImages, stageImages } from "../attachments/stage.ts";
import { logger } from "../logger.ts";
import { readSettings } from "../settings.ts";
import { attachStagingRoot, createJiraClient, imageStageOptions } from "../wiring.ts";
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

  const parent = attachStagingRoot();
  const result = await stageImages(
    client,
    detail.attachments,
    parent,
    detail.key,
    imageStageOptions(settings),
  );

  process.stdout.write(`outcome: ${result.outcome}\n`);
  if (result.outcome === "refused") {
    process.stdout.write(`reason: ${result.reason}\n`);
  }
  process.stdout.write("\n--- the block a session would be given ---\n");
  // "Nothing" means no raster image; an SVG is inlined as text by `solve/ticket.ts` regardless.
  const block = describeStagedImages(result);
  process.stdout.write(block === "" ? "(nothing — no raster image to stage)\n" : `${block}\n`);

  const staged = result.outcome === "staged" ? result.directory : null;
  if (staged !== null && !keep) {
    await removeStagedImages(staged);
  }
  const keptAt = staged !== null && keep ? staged : null;

  // Written after removal so the report reflects what is actually on disk now.
  await mkdir(settings.OUTPUT_DIR, { recursive: true });
  const reportPath = join(settings.OUTPUT_DIR, `${detail.key}.attachments.md`);
  await writeFile(reportPath, formatReport(detail, result, new Date(), keptAt), "utf8");
  process.stdout.write(`\nreport: ${reportPath}\n`);

  if (keptAt !== null) {
    process.stdout.write(`kept: ${keptAt}\n`);
    process.stdout.write(
      `sweep-once --write removes this once it is past STAGING_SWEEP_MAX_AGE_MS. To remove it now:\n` +
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
