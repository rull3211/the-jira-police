/**
 * A draft as the messages that carry it: the text cut on lines into pieces Slack takes whole, the
 * first sent as the message and each later one as a reply in its thread, and the Post button under
 * the last of them, carrying the id of the record it files.
 */

export const POST_ACTION_ID = "draft_post";

/** Slack's limit on the text of one section block. */
export const SECTION_MAX = 3000;
/** Slack's limit on the blocks of one message. */
export const BLOCKS_MAX = 50;
/** Where Slack cuts the `text` of a message off. */
export const MESSAGE_MAX = 40_000;

/** One message of a draft; `blocks` is `null` for a message sent as plain text. */
export interface Piece {
  readonly text: string;
  readonly blocks: readonly object[] | null;
}

/** Empty only for a draft with nothing in it. */
export function plainPieces(text: string): readonly Piece[] {
  return splitSections(text, MESSAGE_MAX).map((piece) => ({ text: piece, blocks: null }));
}

/** Every piece in sections, so the thread reads one way throughout; the button is under the last. */
export function buttonPieces(text: string, pendingId: string): readonly Piece[] {
  const pieces = splitSections(text, MESSAGE_MAX);
  return pieces.map((piece, index) => ({
    text: piece,
    blocks: [
      ...splitSections(piece).map((section) => ({
        type: "section",
        text: { type: "mrkdwn", text: section },
      })),
      ...(index === pieces.length - 1 ? [postButton(pendingId)] : []),
    ],
  }));
}

function postButton(pendingId: string): object {
  return {
    type: "actions",
    block_id: POST_ACTION_ID,
    elements: [
      {
        type: "button",
        action_id: POST_ACTION_ID,
        text: { type: "plain_text", text: "Post to Jira" },
        style: "primary",
        value: pendingId,
      },
    ],
  };
}

/** Whole lines where they fit; a line longer than `max` is cut at a space, never inside an entity or a character. */
export function splitSections(text: string, max: number = SECTION_MAX): readonly string[] {
  const sections: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    for (const piece of cut(line, max)) {
      const joined = current === "" ? piece : `${current}\n${piece}`;
      if (joined.length > max) {
        sections.push(current);
        current = piece;
      } else {
        current = joined;
      }
    }
  }
  sections.push(current);
  return sections.filter((section) => section.trim() !== "");
}

function cut(line: string, max: number): readonly string[] {
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > max) {
    const space = rest.lastIndexOf(" ", max);
    let end = space > max / 2 ? space : max;
    if (space <= max / 2) {
      const entity = rest.lastIndexOf("&", end - 1);
      if (entity > 0 && entity >= end - 5 && !rest.slice(entity, end).includes(";")) {
        end = entity;
      } else if (end > 1 && isHighSurrogate(rest.charCodeAt(end - 1))) {
        end -= 1;
      }
    }
    pieces.push(rest.slice(0, end));
    rest = rest.slice(end).replace(/^ /u, "");
  }
  pieces.push(rest);
  return pieces;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
