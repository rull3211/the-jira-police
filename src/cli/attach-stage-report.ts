/**
 * What `attach:stage` writes down and what it exits with.
 *
 * Split out of `attach-stage.ts` for the reason `watch-args.ts` gives: that
 * file ends in a top-level `await`, so importing it into a test runs the
 * command. The report and the exit rule are the two things about this dry run
 * worth asserting on, and neither of them can be asserted on from there.
 */

import type { ImageStageResult } from "../attachments/stage.ts";
import { describeStagedImages } from "../attachments/stage.ts";
import type { IssueDetail } from "../jira/client.ts";
import { oneLine } from "../text.ts";

/**
 * Exit codes, because a wrapper has to be able to tell the outcomes apart.
 *
 * `refused` is the one worth spending a code on: the ticket had an image and
 * this could not produce it, which is the case every later phase has to bail
 * on. Reporting it as success would be the same substitution `stage.ts` splits
 * its outcomes to prevent, made again at the only boundary a script can read.
 */
export const EXIT = { ok: 0, refused: 1, usage: 2, failed: 3 } as const;

/** `none` is a ticket with no pictures, which is the common case and not a fault. */
export function exitCodeFor(result: ImageStageResult): number {
  return result.outcome === "refused" ? EXIT.refused : EXIT.ok;
}

/**
 * The artifact, which is the half of this a person reads tomorrow.
 *
 * Every field on an attachment row comes off the Jira response — the declared
 * MIME type as much as the filename — so the row is collapsed whole rather than
 * field by field, which is the version that does not need revisiting when a
 * fourth field is added to it.
 */
export function formatReport(
  detail: IssueDetail,
  result: ImageStageResult,
  now: Date,
  keptAt: string | null,
): string {
  const lines = [
    `# ${detail.key} — attachment staging`,
    "",
    `- **Ticket:** ${oneLine(detail.summary)}`,
    `- **Run:** ${now.toISOString()}`,
    `- **Outcome:** ${result.outcome}`,
    `- **Staged files:** ${keptAt ?? "removed on the way out"}`,
    "",
    `## Attachments on the ticket (${String(detail.attachments.length)})`,
    "",
  ];

  if (detail.attachments.length === 0) {
    lines.push("None.");
  }
  for (const attachment of detail.attachments) {
    lines.push(
      oneLine(
        `- ${attachment.filename} — ${attachment.mimeType}, ${String(attachment.size)} bytes`,
      ),
    );
  }

  lines.push("", "## What a pass would have been given", "");
  if (result.outcome === "staged" && keptAt === null) {
    // The block below is the one a pass would have been handed, quoted as it
    // was: the paths in it were removed before this file was written, and a
    // reader who tries to open one and finds nothing should be told why here
    // rather than concluding the staging failed.
    lines.push(
      "_Quoted as it was. The paths were removed on the way out; `--keep` holds them._",
      "",
    );
  }
  const block = describeStagedImages(result);
  lines.push(block === "" ? "_Nothing: no raster image to stage._" : block);

  if (result.outcome === "refused") {
    lines.push("", `Refused: ${result.reason}`);
  }

  lines.push(
    "",
    "---",
    "",
    "_Nothing reads these images yet. `attach:stage` is the only caller of the_",
    "_stager; see `ARCHITECTURE.md` §13 for the phases that would change that._",
    "",
  );
  return lines.join("\n");
}
