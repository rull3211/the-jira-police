/**
 * What `attach:stage` writes down and what it exits with.
 *
 * Split out of `attach-stage.ts` because that file ends in a top-level `await`, so importing it runs the command.
 */

import type { ImageStageResult } from "../attachments/stage.ts";
import { describeStagedImages } from "../attachments/stage.ts";
import type { IssueDetail } from "../jira/client.ts";
import { oneLine } from "../text.ts";

/** Exit codes so a wrapper can tell the outcomes apart; `refused` must not collapse into `ok`. */
export const EXIT = { ok: 0, refused: 1, usage: 2, failed: 3 } as const;

/** `none` is a ticket with no pictures, which is the common case and not a fault. */
export function exitCodeFor(result: ImageStageResult): number {
  return result.outcome === "refused" ? EXIT.refused : EXIT.ok;
}

/** Each attachment row is collapsed via `oneLine`, so a filename with embedded newlines cannot forge extra report lines. */
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
    // Paths below were already removed by the time this is written; say so, or a reader concludes staging failed.
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
    "_stager; see `architecture/not-built.md` §13 for the phases that would change that._",
    "",
  );
  return lines.join("\n");
}
