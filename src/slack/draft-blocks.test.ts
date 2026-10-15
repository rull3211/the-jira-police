import { describe, expect, it } from "vitest";

import {
  BLOCKS_MAX,
  POST_ACTION_ID,
  SECTION_MAX,
  draftBlocks,
  splitSections,
} from "./draft-blocks.ts";

const ID = "d-0123456789abcdef01234567";

interface Section {
  readonly type: string;
  readonly text: { readonly type: string; readonly text: string };
}

describe("draftBlocks", () => {
  it("shows a short draft as one section, with the Post button under it carrying the record's id", () => {
    expect(draftBlocks("*Draft ticket*\nBody", ID)).toEqual([
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
    ]);
  });

  it("puts the button last, after every section of a long draft", () => {
    const blocks = draftBlocks(Array.from({ length: 200 }, () => "x".repeat(60)).join("\n"), ID);

    expect(blocks?.at(-1)).toMatchObject({ type: "actions" });
    expect(
      (blocks ?? []).slice(0, -1).every((block) => (block as Section).type === "section"),
    ).toBe(true);
    expect((blocks ?? []).length).toBeGreaterThan(2);
  });

  it("offers no button for a draft Slack would refuse, rather than a message it would", () => {
    const fits = "y".repeat(SECTION_MAX);
    // Each line fills a section on its own, so n lines are n sections.
    const lines = (count: number): string => Array.from({ length: count }, () => fits).join("\n");

    expect(draftBlocks(lines(BLOCKS_MAX - 1), ID)).toHaveLength(BLOCKS_MAX);
    expect(draftBlocks(lines(BLOCKS_MAX), ID)).toBeNull();
  });

  it("offers no button for a draft with nothing in it", () => {
    expect(draftBlocks("", ID)).toBeNull();
    expect(draftBlocks("\n \n", ID)).toBeNull();
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
