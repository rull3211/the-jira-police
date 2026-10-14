/**
 * A draft message as Block Kit: the draft in as many sections as Slack's limit takes, and the Post
 * button under them carrying the id of the record it files.
 */

export const POST_ACTION_ID = "draft_post";

/** Slack's limit on the text of one section block. */
export const SECTION_MAX = 3000;
/** Slack's limit on the blocks of one message. */
export const BLOCKS_MAX = 50;

/** `null` when the draft would not fit in one message, which then goes without a button. */
export function draftBlocks(text: string, pendingId: string): readonly object[] | null {
  const sections = splitSections(text);
  if (sections.length === 0 || sections.length + 1 > BLOCKS_MAX) {
    return null;
  }
  return [
    ...sections.map((section) => ({ type: "section", text: { type: "mrkdwn", text: section } })),
    {
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
    },
  ];
}

/** Whole lines where they fit; a line longer than a section is cut at a space, never inside an entity or a character. */
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
