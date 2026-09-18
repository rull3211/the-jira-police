/**
 * The ticket, rendered as the text a solve pass is actually given.
 *
 * Renders comments as part of the ticket, not commentary on it — on this board the specification
 * routinely arrives in a later comment, and a reader that stops at `description` reads a draft.
 * Everything here (summary, description, comments, attachment filenames and contents) is
 * attacker-controlled; this module renders it but never interprets it or lets it stop looking like
 * data — see `fenceFor` for the one place that could otherwise be subverted.
 */

import { type IssueDetail, type JiraAttachment, isInlineable } from "../jira/client.ts";
import { renderAdf } from "../jira/adf.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("solve");

/** Reads an attachment's bytes. The half of `JiraClient` this module needs. */
export interface AttachmentReader {
  fetchAttachmentText(id: string, maxBytes: number): Promise<string | null>;
}

export interface TicketRenderOptions {
  /** Per-attachment ceiling. Larger files are named but not inlined. */
  readonly maxAttachmentBytes: number;
  /** How many attachments may be inlined at all. */
  readonly maxAttachments: number;
}

export const DEFAULT_TICKET_RENDER_OPTIONS: TicketRenderOptions = {
  // Large enough for an icon or config fragment, small enough that a ticket can't push instructions out of the context window.
  maxAttachmentBytes: 32 * 1024,
  maxAttachments: 5,
};

export interface RenderedTicket {
  readonly text: string;
  /** Filenames whose bytes are in `text`. */
  readonly inlined: readonly string[];
  /** Filenames present on the issue but not inlined, each with the reason. */
  readonly omitted: readonly string[];
}

/**
 * A code fence guaranteed not to be closed by its own content — attachment bytes are
 * attacker-controlled, so a fixed three-backtick fence is escapable by a file that contains one.
 */
export function fenceFor(content: string): string {
  let longest = 0;
  for (const run of content.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

function describeAttachment(attachment: JiraAttachment): string {
  const type = attachment.mimeType === "" ? "unknown type" : attachment.mimeType;
  return `${attachment.filename} (${type}, ${attachment.size} bytes)`;
}

/**
 * Renders one ticket, fetching the attachments worth inlining.
 *
 * Async because of those fetches and for no other reason; with no inlineable
 * attachment it performs no I/O.
 */
export async function renderTicket(
  reader: AttachmentReader,
  detail: IssueDetail,
  options: TicketRenderOptions = DEFAULT_TICKET_RENDER_OPTIONS,
): Promise<RenderedTicket> {
  const lines: string[] = [
    `# ${detail.key} — ${detail.summary}`,
    "",
    `Type: ${detail.issueTypeName || "unknown"}`,
    `Status: ${detail.status || "unknown"}`,
    `Labels: ${detail.labels.length === 0 ? "(none)" : detail.labels.join(", ")}`,
    `URL: ${detail.url}`,
    "",
    "## Description",
    "",
    renderAdf(detail.description) || "(no description)",
  ];

  lines.push("", `## Comments (${detail.comments.length})`, "");
  if (detail.comments.length === 0) {
    lines.push("(none)");
  }
  for (const [index, comment] of detail.comments.entries()) {
    lines.push(
      `### Comment ${index + 1} — ${comment.author}, ${comment.created}`,
      "",
      renderAdf(comment.body) || "(empty)",
      "",
    );
  }

  const inlined: string[] = [];
  const omitted: string[] = [];

  lines.push(`## Attachments (${detail.attachments.length})`, "");
  if (detail.attachments.length === 0) {
    lines.push("(none)");
  }

  for (const attachment of detail.attachments) {
    if (!isInlineable(attachment.mimeType)) {
      omitted.push(`${describeAttachment(attachment)} — binary, not inlined`);
      lines.push(`- ${describeAttachment(attachment)} — binary; contents not shown.`);
      continue;
    }
    if (inlined.length >= options.maxAttachments) {
      omitted.push(`${describeAttachment(attachment)} — over the ${options.maxAttachments} cap`);
      lines.push(`- ${describeAttachment(attachment)} — not shown; attachment limit reached.`);
      continue;
    }
    if (attachment.size > options.maxAttachmentBytes) {
      // Checked here as well as inside the reader: knowing the size in advance
      // means not spending the round trip to discover it.
      omitted.push(`${describeAttachment(attachment)} — over ${options.maxAttachmentBytes} bytes`);
      lines.push(`- ${describeAttachment(attachment)} — too large to show.`);
      continue;
    }

    let text: string | null;
    try {
      text = await reader.fetchAttachmentText(attachment.id, options.maxAttachmentBytes);
    } catch (error) {
      // One unreadable attachment must not fail the solve; the solver is told it exists and could not be read.
      log.warn("solve.attachment_unreadable", {
        issueKey: detail.key,
        filename: attachment.filename,
        reason: (error as Error).message,
      });
      omitted.push(`${describeAttachment(attachment)} — could not be read`);
      lines.push(`- ${describeAttachment(attachment)} — could not be read.`);
      continue;
    }

    if (text === null) {
      omitted.push(`${describeAttachment(attachment)} — over ${options.maxAttachmentBytes} bytes`);
      lines.push(`- ${describeAttachment(attachment)} — too large to show.`);
      continue;
    }

    const fence = fenceFor(text);
    inlined.push(attachment.filename);
    lines.push(
      `### ${describeAttachment(attachment)}`,
      "",
      fence,
      text.replace(/\s+$/, ""),
      fence,
      "",
    );
  }

  const text = `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;

  log.debug("solve.ticket_rendered", {
    issueKey: detail.key,
    characters: text.length,
    comments: detail.comments.length,
    inlined: inlined.length,
    omitted: omitted.length,
  });

  return { text, inlined, omitted };
}
