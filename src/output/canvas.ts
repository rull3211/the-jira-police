/**
 * Builds Slack canvas edit payloads.
 *
 * Constraints that shaped this module, all from the canvases.edit reference:
 *   - exactly ONE operation per call, so a batch of issues must be rendered
 *     into a single markdown blob rather than one operation each;
 *   - markdown must end with a newline or the call is rejected;
 *   - there is no "append to list X" — `insert_after` a section id is the
 *     closest thing, and it prepends beneath that heading;
 *   - canvas markdown is a richer dialect than message mrkdwn: real
 *     `[text](url)` links and `- [ ]` checkboxes both work.
 */

import { type TriageResult, VERDICT_EMOJI } from "./sink.ts";

export type CanvasOperationName =
  | "insert_after"
  | "insert_before"
  | "insert_at_start"
  | "insert_at_end"
  | "replace"
  | "delete";

export interface CanvasDocumentContent {
  readonly type: "markdown";
  readonly markdown: string;
}

export interface CanvasEditOperation {
  readonly operation: CanvasOperationName;
  readonly section_id?: string;
  readonly document_content?: CanvasDocumentContent;
}

export interface CanvasEditRequest {
  readonly canvas_id: string;
  readonly changes: readonly [CanvasEditOperation];
}

/**
 * Escapes the label half of a markdown link.
 *
 * Jira summaries are free text and SSX tickets are Norwegian; a summary
 * containing `]` would otherwise terminate the link early and corrupt the line.
 */
export function escapeLinkLabel(text: string): string {
  return text
    .replace(/([[\]\\])/g, "\\$1")
    .replace(/\r?\n/g, " ")
    .trim();
}

/** A single checklist row: unchecked box, verdict emoji, linked issue, summary. */
export function renderChecklistItem(result: TriageResult): string {
  const emoji = VERDICT_EMOJI[result.verdict];
  const label = escapeLinkLabel(`${result.issueKey} — ${result.summary}`);
  const labels = result.labels.length > 0 ? `  \`${result.labels.join("` `")}\`` : "";
  return `- [ ] ${emoji} [${label}](${result.issueUrl})${labels}`;
}

/**
 * Renders a batch as one markdown blob.
 *
 * Returns null for an empty batch: canvases.edit rejects empty content, and a
 * no-op poll cycle is the common case on a board seeing ~5 issues a day.
 */
export function renderChecklist(results: readonly TriageResult[]): string | null {
  if (results.length === 0) {
    return null;
  }
  // Trailing newline is required by the API, not cosmetic.
  return `${results.map(renderChecklistItem).join("\n")}\n`;
}

/**
 * Builds the edit request for appending under a known section heading.
 *
 * `insert_after` places content directly beneath the target section, which
 * means newest-first ordering. That is the intended reading order for a triage
 * queue, but it is a consequence of the API rather than a choice.
 */
export function buildAppendRequest(
  canvasId: string,
  sectionId: string,
  results: readonly TriageResult[],
): CanvasEditRequest | null {
  const markdown = renderChecklist(results);
  if (markdown === null) {
    return null;
  }

  return {
    canvas_id: canvasId,
    changes: [
      {
        operation: "insert_after",
        section_id: sectionId,
        document_content: { type: "markdown", markdown },
      },
    ],
  };
}

/** Fallback when no section heading is resolvable: append to the document end. */
export function buildAppendAtEndRequest(
  canvasId: string,
  results: readonly TriageResult[],
): CanvasEditRequest | null {
  const markdown = renderChecklist(results);
  if (markdown === null) {
    return null;
  }

  return {
    canvas_id: canvasId,
    changes: [
      {
        operation: "insert_at_end",
        document_content: { type: "markdown", markdown },
      },
    ],
  };
}
