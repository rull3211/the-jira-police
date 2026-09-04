/**
 * The ticket, rendered as the text a solve pass is actually given.
 *
 * `SolveRequest.ticket` has always been documented as "the ticket, rendered as
 * text", and until now nothing rendered it. This is that function, and writing
 * it turned up the gap it exists to close: the only Jira reader in the service
 * is `JiraClient.search`, whose field list carries neither `description` nor
 * `comment`. Wiring the solver to that would have handed it a summary, a status
 * and a label list — no acceptance criteria, no attachments, and no sign that
 * anything was missing, because "the ticket" would have been present and merely
 * empty of everything that matters.
 *
 * ## Comments are part of the ticket, not commentary on it
 *
 * The same lesson the triage path learned. On this board the specification
 * routinely arrives in a comment: acceptance criteria added after review, a
 * reproduction supplied later, an asset attached with "use this one". A reader
 * that stops at `description` reads a draft and believes it read the ticket.
 *
 * ## Attachments, and why SVG in particular
 *
 * An attachment is inlined only when it is text by content, which is a
 * different question from being text by media type. `image/svg+xml` is the case
 * that matters: it sorts as an image and reads as a file, and a ticket that
 * says "here is the icon to use" means the bytes, not the filename. Binary
 * attachments are listed by name, type and size and not fetched — the solver
 * can then say it needs a file it cannot see, which is a better failure than
 * silently shipping something else.
 *
 * ## Everything here is attacker-controlled
 *
 * Summary, description, comment bodies, attachment filenames and attachment
 * contents are all written by whoever opened or touched the issue. This module
 * renders them; it never interprets them, and it never lets them stop looking
 * like data — see `fenceFor` for the one place that could otherwise be
 * subverted.
 */

import { type IssueDetail, type JiraAttachment, isInlineable } from "../jira/client.ts";
import { renderAdf } from "../jira/adf.ts";
import { logger } from "../logger.ts";

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
  // Comfortably larger than any icon, stylesheet or config fragment, and small
  // enough that a ticket cannot push the real instructions out of the context
  // window by attaching a large file.
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
 * A code fence guaranteed not to be closed by its own content.
 *
 * Attachment bytes are attacker-controlled, so a fixed three-backtick fence is
 * escapable by attaching a file that contains one. Counting the longest run in
 * the content and going one longer is the rule CommonMark already defines for
 * this, and it makes the escape impossible rather than unlikely.
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
      // One unreadable attachment must not fail the solve. The solver is told
      // the file exists and could not be read, and can bail on that if it
      // matters to the fix.
      logger.warn("solve.attachment_unreadable", {
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

  logger.debug("solve.ticket_rendered", {
    issueKey: detail.key,
    characters: text.length,
    comments: detail.comments.length,
    inlined: inlined.length,
    omitted: omitted.length,
  });

  return { text, inlined, omitted };
}
