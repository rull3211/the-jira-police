import { describe, expect, it } from "vitest";

import {
  BLOCKS_MAX,
  MESSAGE_MAX,
  POST_ACTION_ID,
  type Piece,
  SECTION_MAX,
  buttonPieces,
  plainPieces,
  splitSections,
} from "./draft-blocks.ts";

const ID = "d-0123456789abcdef01234567";

/** Over three messages' worth, in lines short enough that no line is ever cut. */
const LONG_LINES = Array.from(
  { length: 2000 },
  (_, index) => `line ${String(index)} ${"w".repeat(40)}`,
);

function typesOf(piece: Piece): readonly string[] {
  return (piece.blocks ?? []).map((block) => (block as { type: string }).type);
}

describe("buttonPieces", () => {
  it("shows a short draft as one piece of one section, with the Post button under it carrying the record's id", () => {
    expect(buttonPieces("*Draft ticket*\nBody", ID)).toEqual([
      {
        text: "*Draft ticket*\nBody",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "*Draft ticket*\nBody" } },
          {
            type: "actions",
            block_id: POST_ACTION_ID,
            elements: [
              {
                type: "button",
                action_id: POST_ACTION_ID,
                text: { type: "plain_text", text: "Post to Jira" },
                style: "primary",
                value: ID,
              },
            ],
          },
        ],
      },
    ]);
  });

  it("sends the first paragraph as the message and everything after it as one reply, the button under that", () => {
    const pieces = buttonPieces(
      "*Title*\nProject: SSX\n\n*Questions*\n• one\n\nBody\n\nFooter",
      ID,
    );

    expect(pieces.map((piece) => piece.text)).toEqual([
      "*Title*\nProject: SSX",
      "*Questions*\n• one\n\nBody\n\nFooter",
    ]);
    expect(typesOf(pieces[0] as Piece)).toEqual(["section"]);
    expect(typesOf(pieces[1] as Piece).at(-1)).toBe("actions");
  });

  it("takes a line of spaces between paragraphs for a blank one, and drops every blank line it cuts at", () => {
    expect(buttonPieces("head\n \t\n\n\ntail", ID).map((piece) => piece.text)).toEqual([
      "head",
      "tail",
    ]);
  });

  it("puts the button under the head when the draft is a single paragraph", () => {
    const pieces = buttonPieces("one paragraph\nof two lines", ID);

    expect(pieces).toHaveLength(1);
    expect(typesOf(pieces[0] as Piece).at(-1)).toBe("actions");
  });

  it("still cuts what follows the first paragraph into messages Slack takes whole", () => {
    const pieces = buttonPieces(`head\n\n${LONG_LINES.join("\n")}`, ID);

    expect(pieces[0]?.text).toBe("head");
    expect(pieces.length).toBeGreaterThan(2);
    expect(pieces.every((piece) => piece.text.length <= MESSAGE_MAX)).toBe(true);
    expect(
      pieces
        .slice(1)
        .map((piece) => piece.text)
        .join("\n")
        .split("\n"),
    ).toEqual(LONG_LINES);
    expect(pieces.flatMap(typesOf).filter((type) => type === "actions")).toHaveLength(1);
  });

  it("keeps a draft of several sections in one message, which is the size real drafts are", () => {
    const pieces = buttonPieces(LONG_LINES.slice(0, 300).join("\n"), ID);

    expect(pieces).toHaveLength(1);
    expect((pieces[0]?.blocks ?? []).length).toBeGreaterThan(3);
  });

  it("cuts a draft over a message into pieces and loses none of its lines", () => {
    const pieces = buttonPieces(LONG_LINES.join("\n"), ID);

    expect(pieces.length).toBeGreaterThan(2);
    expect(
      pieces
        .map((piece) => piece.text)
        .join("\n")
        .split("\n"),
    ).toEqual(LONG_LINES);
  });

  it("keeps every piece within what Slack keeps of a message's text", () => {
    const pieces = buttonPieces(LONG_LINES.join("\n"), ID);

    // Slack's documented cut-off, written out so raising MESSAGE_MAX past it fails here.
    expect(MESSAGE_MAX).toBeLessThanOrEqual(40_000);
    expect(pieces.every((piece) => piece.text.length <= MESSAGE_MAX)).toBe(true);
  });

  it("puts the button under the last piece only, so a press comes after the whole draft", () => {
    const pieces = buttonPieces(LONG_LINES.join("\n"), ID);

    expect(typesOf(pieces.at(-1) as Piece).at(-1)).toBe("actions");
    for (const piece of pieces.slice(0, -1)) {
      expect(typesOf(piece).every((type) => type === "section")).toBe(true);
    }
    expect(pieces.flatMap(typesOf).filter((type) => type === "actions")).toHaveLength(1);
  });

  it("gives every piece blocks, so the thread reads one way throughout", () => {
    expect(buttonPieces(LONG_LINES.join("\n"), ID).every((piece) => piece.blocks !== null)).toBe(
      true,
    );
  });

  it("keeps the worst piece within Slack's blocks per message", () => {
    // A line just over half a section: two never share one, so each is a section of its own.
    const wide = "y".repeat(SECTION_MAX / 2 + 1);
    const pieces = buttonPieces(
      Array.from({ length: Math.ceil((MESSAGE_MAX / wide.length) * 4) }, () => wide).join("\n"),
      ID,
    );

    expect(pieces.length).toBeGreaterThan(2);
    expect(Math.max(...pieces.map((piece) => piece.blocks?.length ?? 0))).toBeLessThanOrEqual(
      BLOCKS_MAX,
    );
    // Not a vacuous bound: the pieces really are the one-line-a-section kind.
    expect(Math.max(...pieces.map((piece) => piece.blocks?.length ?? 0))).toBeGreaterThan(20);
  });

  it("has no piece for a draft with nothing in it", () => {
    expect(buttonPieces("", ID)).toEqual([]);
    expect(buttonPieces("\n \n", ID)).toEqual([]);
  });
});

describe("plainPieces", () => {
  it("sends a short draft as one piece of plain text", () => {
    expect(plainPieces("*Draft ticket*\nBody")).toEqual([
      { text: "*Draft ticket*\nBody", blocks: null },
    ]);
  });

  it("sends the first paragraph as the message and the rest as one reply, in plain text", () => {
    expect(plainPieces("*Title*\nProject: SSX\n\nBody\n\nFooter")).toEqual([
      { text: "*Title*\nProject: SSX", blocks: null },
      { text: "Body\n\nFooter", blocks: null },
    ]);
  });

  it("keeps a draft of several sections in one message", () => {
    expect(plainPieces(LONG_LINES.slice(0, 300).join("\n"))).toHaveLength(1);
  });

  it("cuts a draft over a message into pieces of plain text and loses none of its lines", () => {
    const pieces = plainPieces(LONG_LINES.join("\n"));

    expect(pieces.length).toBeGreaterThan(2);
    expect(pieces.every((piece) => piece.blocks === null)).toBe(true);
    expect(pieces.every((piece) => piece.text.length <= MESSAGE_MAX)).toBe(true);
    expect(
      pieces
        .map((piece) => piece.text)
        .join("\n")
        .split("\n"),
    ).toEqual(LONG_LINES);
  });

  it("has no piece for a draft with nothing in it", () => {
    expect(plainPieces("")).toEqual([]);
  });
});

describe("splitSections", () => {
  it("keeps whole lines together and loses none of them", () => {
    const lines = Array.from(
      { length: 500 },
      (_, index) => `line ${String(index)} ${"w".repeat(40)}`,
    );

    const sections = splitSections(lines.join("\n"));

    expect(sections.length).toBeGreaterThan(1);
    expect(sections.every((section) => section.length <= SECTION_MAX)).toBe(true);
    expect(sections.join("\n").split("\n")).toEqual(lines);
  });

  it("cuts a line longer than a section at a space, and every word survives", () => {
    const words = Array.from({ length: 2000 }, (_, index) => `word${String(index)}`);

    const sections = splitSections(words.join(" "));

    expect(sections.length).toBeGreaterThan(1);
    expect(sections.every((section) => section.length <= SECTION_MAX)).toBe(true);
    expect(sections.join(" ").split(" ")).toEqual(words);
  });

  it("cuts a line with no space in it at the limit, and every character survives", () => {
    const line = "z".repeat(SECTION_MAX * 2 + 10);

    const sections = splitSections(line);

    expect(sections.map((section) => section.length)).toEqual([SECTION_MAX, SECTION_MAX, 10]);
    expect(sections.join("")).toBe(line);
  });

  it("never cuts inside an escaped entity, which Slack would show as its fragments", () => {
    for (const entity of ["&amp;", "&lt;", "&gt;"]) {
      // The entity straddles the limit at every offset it can.
      for (let offset = 1; offset < entity.length; offset += 1) {
        const line = `${"a".repeat(SECTION_MAX - offset)}${entity}${"b".repeat(50)}`;

        const sections = splitSections(line);

        expect(sections.join("")).toBe(line);
        expect(sections.every((section) => !/&[a-z]*$/u.test(section))).toBe(true);
      }
    }
  });

  it("never cuts between the halves of a character outside the basic plane", () => {
    const line = `${"a".repeat(SECTION_MAX - 1)}😀${"b".repeat(50)}`;

    const sections = splitSections(line);

    expect(sections.join("")).toBe(line);
    expect(sections.every((section) => !/[\uD800-\uDBFF]$/u.test(section))).toBe(true);
    expect(sections.every((section) => !/^[\uDC00-\uDFFF]/u.test(section))).toBe(true);
  });

  it("terminates on a limit too small to hold an entity", () => {
    expect(splitSections("&amp;&amp;&amp;", 3).join("")).toBe("&amp;&amp;&amp;");
  });
});
