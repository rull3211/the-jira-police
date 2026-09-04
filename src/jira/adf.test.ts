import { describe, expect, it } from "vitest";

import { referencedAttachments, renderAdf } from "./adf.ts";

function text(value: string, ...marks: readonly unknown[]): unknown {
  return marks.length > 0 ? { type: "text", text: value, marks } : { type: "text", text: value };
}

function paragraph(...content: readonly unknown[]): unknown {
  return { type: "paragraph", content };
}

function doc(...content: readonly unknown[]): unknown {
  return { type: "doc", version: 1, content };
}

function listItem(...content: readonly unknown[]): unknown {
  return { type: "listItem", content };
}

function mediaNode(alt: string): unknown {
  return { type: "media", attrs: { type: "file", id: "a-media-uuid", alt, collection: "" } };
}

/**
 * A comment as it actually came off the board, copied rather than invented.
 *
 * Written out longhand instead of through the helpers above, because the point
 * of this fixture is to be the payload Jira sent — a helper could agree with
 * the renderer while both disagreed with Atlassian. Note `attrs.id`: a Media
 * Services UUID that appears nowhere in the issue's `attachment` array, which
 * is the whole reason `alt` is what gets rendered.
 */
const OBSERVED_COMMENT = {
  type: "doc",
  version: 1,
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "This is the svg that should be used in thest" }],
    },
    {
      type: "mediaSingle",
      attrs: { layout: "center", width: 250, widthType: "pixel" },
      content: [
        {
          type: "media",
          attrs: {
            type: "file",
            id: "fd700241-3f0b-4c2c-8a3a-9d0f5b21c7ae",
            alt: "svgtest.svg",
            collection: "",
            localId: "d9fe878bd36b",
          },
        },
      ],
    },
  ],
};

describe("renderAdf, on the comment the board actually carries", () => {
  it("renders the paragraph and the attachment as two blocks", () => {
    expect(renderAdf(OBSERVED_COMMENT)).toBe(
      "This is the svg that should be used in thest\n\n[attachment: svgtest.svg]",
    );
  });

  it("names the attachment by its filename and never by its media id", () => {
    // The trap this module exists to document. `attrs.id` is a Media Services
    // UUID; it does not appear in the issue's `attachment` array, so a reader
    // handed the id has been handed something it cannot look anything up with.
    const rendered = renderAdf(OBSERVED_COMMENT);
    expect(rendered).toContain("svgtest.svg");
    expect(rendered).not.toContain("fd700241");
    expect(rendered).not.toContain("d9fe878bd36b");
  });

  it("sees through mediaSingle to the media node it wraps", () => {
    // Every image on this board arrives inside a mediaSingle. If the wrapper
    // were opaque, every image on this board would render as nothing.
    expect(renderAdf(OBSERVED_COMMENT)).toContain("[attachment:");
  });
});

describe("renderAdf, blocks and whitespace", () => {
  it("separates block-level nodes with a blank line", () => {
    expect(renderAdf(doc(paragraph(text("first")), paragraph(text("second"))))).toBe(
      "first\n\nsecond",
    );
  });

  it("concatenates inline runs within a paragraph without separators", () => {
    // A mark change splits one sentence into several text nodes; anything but a
    // bare concatenation here inserts punctuation the author never wrote.
    expect(
      renderAdf(paragraph(text("this "), text("costs", { type: "strong" }), text(" us"))),
    ).toBe("this **costs** us");
  });

  it("drops empty paragraphs instead of emitting the blank lines they imply", () => {
    expect(renderAdf(doc(paragraph(), paragraph(text("body")), paragraph(), paragraph()))).toBe(
      "body",
    );
  });

  it("collapses three or more newlines down to a blank line", () => {
    // Reachable without trying: a paragraph ending in two hard breaks, meeting
    // the blank line that separates it from the next block.
    const trailing = paragraph(text("a"), { type: "hardBreak" }, { type: "hardBreak" });
    expect(renderAdf(doc(trailing, paragraph(text("b"))))).toBe("a\n\nb");
  });

  it("leaves no leading or trailing blank lines", () => {
    const rendered = renderAdf(doc(paragraph(), paragraph(text("only")), paragraph()));
    expect(rendered).toBe("only");
    expect(rendered).not.toMatch(/^\s/u);
    expect(rendered).not.toMatch(/\s$/u);
  });

  it("trims trailing whitespace from every line", () => {
    const rendered = renderAdf(doc(paragraph(text("a   ")), paragraph(text("b"))));
    expect(rendered).toBe("a\n\nb");
  });

  it("renders a hard break as a single newline inside its paragraph", () => {
    expect(renderAdf(paragraph(text("one"), { type: "hardBreak" }, text("two")))).toBe("one\ntwo");
  });

  it("renders a rule", () => {
    expect(renderAdf(doc(paragraph(text("a")), { type: "rule" }, paragraph(text("b"))))).toBe(
      "a\n\n---\n\nb",
    );
  });

  it("accepts a bare array of blocks, not only a doc", () => {
    expect(renderAdf([paragraph(text("a")), paragraph(text("b"))])).toBe("a\n\nb");
  });

  it("renders a subtree handed over on its own", () => {
    expect(renderAdf(paragraph(text("just a paragraph")))).toBe("just a paragraph");
    expect(renderAdf(text("just a text node"))).toBe("just a text node");
  });
});

describe("renderAdf, marks", () => {
  it("renders strong as bold", () => {
    expect(renderAdf(paragraph(text("urgent", { type: "strong" })))).toBe("**urgent**");
  });

  it("renders em, code and strike", () => {
    expect(renderAdf(paragraph(text("maybe", { type: "em" })))).toBe("*maybe*");
    expect(renderAdf(paragraph(text("npm ci", { type: "code" })))).toBe("`npm ci`");
    expect(renderAdf(paragraph(text("gone", { type: "strike" })))).toBe("~~gone~~");
  });

  it("renders a link with both its text and its href", () => {
    const link = { type: "link", attrs: { href: "https://example.test/x" } };
    expect(renderAdf(paragraph(text("the docs", link)))).toBe("[the docs](https://example.test/x)");
  });

  it("nests marks with the first one innermost, so a bold link is a link", () => {
    // `[**text**](href)` is a link that is bold. `**[text](href)**` is not
    // markdown anyone means to write, and is what the reverse order produces.
    const marks = [{ type: "strong" }, { type: "link", attrs: { href: "https://example.test" } }];
    expect(renderAdf(paragraph(text("read this", ...marks)))).toBe(
      "[**read this**](https://example.test)",
    );
  });

  it("falls back to the bare text when a link has no usable href", () => {
    expect(renderAdf(paragraph(text("nowhere", { type: "link" })))).toBe("nowhere");
    expect(renderAdf(paragraph(text("nowhere", { type: "link", attrs: { href: "  " } })))).toBe(
      "nowhere",
    );
  });

  it("passes text through an unknown mark unchanged", () => {
    // Same rule as unknown nodes: the mark is decoration, the text is the
    // message, and Atlassian adds marks without asking.
    expect(
      renderAdf(paragraph(text("plain", { type: "textColor", attrs: { color: "#ff0000" } }))),
    ).toBe("plain");
  });

  it("does not decorate whitespace-only text", () => {
    // The space between two bolded words arrives as its own text node, and
    // `** **` is a rendering artefact rather than emphasis.
    const rendered = renderAdf(
      paragraph(text("a", { type: "strong" }), text(" ", { type: "strong" }), text("b")),
    );
    expect(rendered).toBe("**a** b");
  });

  it("ignores a marks field that is not an array", () => {
    expect(renderAdf({ type: "text", text: "safe", marks: "strong" })).toBe("safe");
  });

  it("ignores non-object entries inside marks", () => {
    expect(renderAdf({ type: "text", text: "safe", marks: [null, 7, { type: "strong" }] })).toBe(
      "**safe**",
    );
  });
});

describe("renderAdf, lists", () => {
  it("renders a bullet list one item per line", () => {
    const list = {
      type: "bulletList",
      content: [listItem(paragraph(text("one"))), listItem(paragraph(text("two")))],
    };
    expect(renderAdf(list)).toBe("- one\n- two");
  });

  it("numbers an ordered list incrementally", () => {
    const list = {
      type: "orderedList",
      content: [
        listItem(paragraph(text("first"))),
        listItem(paragraph(text("second"))),
        listItem(paragraph(text("third"))),
      ],
    };
    expect(renderAdf(list)).toBe("1. first\n2. second\n3. third");
  });

  it("restarts an ordered list from attrs.order when the ticket says so", () => {
    const list = {
      type: "orderedList",
      attrs: { order: 3 },
      content: [listItem(paragraph(text("third"))), listItem(paragraph(text("fourth")))],
    };
    expect(renderAdf(list)).toBe("3. third\n4. fourth");
  });

  it("ignores a nonsensical attrs.order rather than counting from it", () => {
    for (const order of [0, -4, 2.5, "3", null]) {
      const list = {
        type: "orderedList",
        attrs: { order },
        content: [listItem(paragraph(text("a")))],
      };
      expect(renderAdf(list)).toBe("1. a");
    }
  });

  it("indents a nested list two spaces under its parent item", () => {
    const nested = {
      type: "bulletList",
      content: [
        listItem(paragraph(text("one")), {
          type: "orderedList",
          content: [listItem(paragraph(text("first"))), listItem(paragraph(text("second")))],
        }),
        listItem(paragraph(text("two"))),
      ],
    };
    expect(renderAdf(nested)).toBe("- one\n  1. first\n  2. second\n- two");
  });

  it("indents a list nested two levels deep by four spaces", () => {
    const inner = { type: "bulletList", content: [listItem(paragraph(text("deep")))] };
    const middle = { type: "bulletList", content: [listItem(paragraph(text("mid")), inner)] };
    const outer = { type: "bulletList", content: [listItem(paragraph(text("top")), middle)] };
    expect(renderAdf(outer)).toBe("- top\n  - mid\n    - deep");
  });

  it("keeps an item's own blocks on adjacent lines rather than spaced apart", () => {
    // A blank line between an item and what follows it inside the item is what
    // markdown reads as a loose list; it looks broken when shown to a human.
    const list = {
      type: "bulletList",
      content: [listItem(paragraph(text("intro")), paragraph(text("more")))],
    };
    expect(renderAdf(list)).toBe("- intro\n  more");
  });

  it("keeps a marker for an empty item, so later items keep their numbers", () => {
    // Dropping the empty item would renumber everything after it, and "step 3"
    // in the output would no longer be step 3 on the ticket.
    const list = {
      type: "orderedList",
      content: [
        listItem(paragraph(text("first"))),
        listItem(paragraph()),
        listItem(paragraph(text("third"))),
      ],
    };
    expect(renderAdf(list)).toBe("1. first\n2.\n3. third");
  });

  it("separates a list from surrounding paragraphs with a blank line", () => {
    const list = { type: "bulletList", content: [listItem(paragraph(text("item")))] };
    expect(renderAdf(doc(paragraph(text("before")), list, paragraph(text("after"))))).toBe(
      "before\n\n- item\n\nafter",
    );
  });
});

describe("renderAdf, media", () => {
  it("renders a media node by its alt filename", () => {
    expect(renderAdf(mediaNode("screenshot.png"))).toBe("[attachment: screenshot.png]");
  });

  it("still announces a media node whose alt is missing or blank", () => {
    // "There is a file here and I cannot name it" is information; a comment
    // that says "see the screenshot" must not render as if it referenced none.
    expect(renderAdf({ type: "media", attrs: { type: "file", id: "u" } })).toBe("[attachment]");
    expect(renderAdf({ type: "media", attrs: { alt: "   " } })).toBe("[attachment]");
    expect(renderAdf({ type: "media" })).toBe("[attachment]");
  });

  it("does not fall back to the media id when alt is missing", () => {
    const rendered = renderAdf({ type: "media", attrs: { id: "fd700241-3f0b", alt: "" } });
    expect(rendered).toBe("[attachment]");
    expect(rendered).not.toContain("fd700241");
  });

  it("renders every member of a mediaGroup", () => {
    const group = { type: "mediaGroup", content: [mediaNode("a.png"), mediaNode("b.png")] };
    expect(renderAdf(group)).toBe("[attachment: a.png]\n\n[attachment: b.png]");
  });

  it("renders an inline media node inside the sentence that mentions it", () => {
    const inline = { type: "mediaInline", attrs: { id: "u", alt: "logo.png" } };
    expect(renderAdf(paragraph(text("see "), inline, text(" for the mark")))).toBe(
      "see [attachment: logo.png] for the mark",
    );
  });

  it("ignores an alt that is not a string", () => {
    expect(renderAdf({ type: "media", attrs: { alt: 42 } })).toBe("[attachment]");
    expect(renderAdf({ type: "media", attrs: { alt: ["a.png"] } })).toBe("[attachment]");
  });
});

describe("renderAdf, headings, code and quotes", () => {
  it("renders a heading with one hash per level", () => {
    expect(renderAdf({ type: "heading", attrs: { level: 1 }, content: [text("Top")] })).toBe(
      "# Top",
    );
    expect(renderAdf({ type: "heading", attrs: { level: 3 }, content: [text("Sub")] })).toBe(
      "### Sub",
    );
  });

  it("clamps a heading level into the range markdown has headings for", () => {
    expect(renderAdf({ type: "heading", attrs: { level: 12 }, content: [text("x")] })).toBe(
      "###### x",
    );
    expect(renderAdf({ type: "heading", attrs: { level: 0 }, content: [text("x")] })).toBe("# x");
    expect(renderAdf({ type: "heading", attrs: { level: "2" }, content: [text("x")] })).toBe("# x");
    expect(renderAdf({ type: "heading", content: [text("x")] })).toBe("# x");
  });

  it("drops an empty heading rather than emitting a bare hash", () => {
    expect(renderAdf(doc({ type: "heading", attrs: { level: 2 } }, paragraph(text("body"))))).toBe(
      "body",
    );
  });

  it("fences a code block and keeps its language", () => {
    const code = {
      type: "codeBlock",
      attrs: { language: "typescript" },
      content: [{ type: "text", text: "const a = 1;\nconst b = 2;" }],
    };
    expect(renderAdf(code)).toBe("```typescript\nconst a = 1;\nconst b = 2;\n```");
  });

  it("fences a code block with no language", () => {
    const code = { type: "codeBlock", content: [{ type: "text", text: "make build" }] };
    expect(renderAdf(code)).toBe("```\nmake build\n```");
  });

  it("does not apply marks inside a code block", () => {
    // The sample must be the code the reporter ran. Rendering a mark would put
    // asterisks into a command line that never had any.
    const code = {
      type: "codeBlock",
      content: [{ type: "text", text: "a ** b", marks: [{ type: "strong" }] }],
    };
    expect(renderAdf(code)).toBe("```\na ** b\n```");
  });

  it("prefixes every line of a blockquote", () => {
    const quote = { type: "blockquote", content: [paragraph(text("they said"))] };
    expect(renderAdf(quote)).toBe("> they said");
  });

  it("keeps a multi-paragraph blockquote contiguous", () => {
    // A bare blank line ends a quote, so the second paragraph would silently
    // stop being quoted.
    const quote = {
      type: "blockquote",
      content: [paragraph(text("first")), paragraph(text("second"))],
    };
    expect(renderAdf(quote)).toBe("> first\n>\n> second");
  });

  it("renders an empty blockquote as nothing", () => {
    expect(renderAdf(doc({ type: "blockquote" }, paragraph(text("body"))))).toBe("body");
  });

  it("renders a panel's contents without decoration", () => {
    const panel = {
      type: "panel",
      attrs: { panelType: "warning" },
      content: [paragraph(text("mind the gap"))],
    };
    expect(renderAdf(panel)).toBe("mind the gap");
  });
});

describe("renderAdf, tables", () => {
  const row = (kind: string, ...cells: readonly string[]): unknown => ({
    type: "tableRow",
    content: cells.map((value) => ({ type: kind, content: [paragraph(text(value))] })),
  });

  it("joins cells with a pipe and rows with a newline", () => {
    const table = {
      type: "table",
      content: [row("tableHeader", "Name", "Value"), row("tableCell", "timeout", "30s")],
    };
    expect(renderAdf(table)).toBe("Name | Value\ntimeout | 30s");
  });

  it("keeps an empty cell as a column rather than shifting the row left", () => {
    const table = {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [paragraph(text("a"))] },
            { type: "tableCell", content: [] },
            { type: "tableCell", content: [paragraph(text("c"))] },
          ],
        },
      ],
    };
    expect(renderAdf(table)).toBe("a |  | c");
  });

  it("flattens a multi-block cell onto one line", () => {
    // A newline inside a cell breaks the row: everything after it reads as a
    // new row with a different number of columns.
    const table = {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [paragraph(text("one")), paragraph(text("two"))] },
            { type: "tableCell", content: [paragraph(text("three"))] },
          ],
        },
      ],
    };
    expect(renderAdf(table)).toBe("one two | three");
  });
});

describe("renderAdf, inline atoms", () => {
  it("prefers an emoji's shortName over its codepoint", () => {
    const emoji = { type: "emoji", attrs: { shortName: ":warning:", text: "⚠️" } };
    expect(renderAdf(paragraph(emoji, text(" careful")))).toBe(":warning: careful");
  });

  it("falls back to an emoji's text when it has no shortName", () => {
    expect(renderAdf(paragraph({ type: "emoji", attrs: { text: "✅" } }))).toBe("✅");
  });

  it("renders a mention by its display text, not its account id", () => {
    const mention = { type: "mention", attrs: { id: "557058:0f2a", text: "@Jane Doe" } };
    const rendered = renderAdf(paragraph(mention, text(" please look")));
    expect(rendered).toBe("@Jane Doe please look");
    expect(rendered).not.toContain("557058");
  });

  it("renders a status by its text", () => {
    const status = { type: "status", attrs: { text: "In Progress", color: "yellow" } };
    expect(renderAdf(paragraph(text("now "), status))).toBe("now In Progress");
  });

  it("renders inline and block cards as their url", () => {
    const url = "https://example.test/browse/SSX-1";
    expect(renderAdf(paragraph({ type: "inlineCard", attrs: { url } }))).toBe(url);
    expect(renderAdf({ type: "blockCard", attrs: { url } })).toBe(url);
  });

  it("renders an atom with no usable attrs as nothing, without disturbing its neighbours", () => {
    expect(renderAdf(paragraph(text("a "), { type: "mention" }, text("b")))).toBe("a b");
    expect(renderAdf(paragraph({ type: "inlineCard" }))).toBe("");
  });
});

describe("renderAdf, unknown node types", () => {
  it("recurses into an unknown wrapper rather than dropping what is inside it", () => {
    // The property this default exists for. Atlassian adds node types without
    // telling anyone, and losing a paragraph of a bug report to a wrapper
    // nobody has heard of is worse than rendering it without its formatting.
    const wrapped = { type: "someNodeAtlassianAddedLater", content: [paragraph(text("the bug"))] };
    expect(renderAdf(doc(wrapped))).toBe("the bug");
  });

  it("recurses through several unknown wrappers at once", () => {
    const inner = { type: "futureThing", content: [paragraph(text("still here"))] };
    const outer = { type: "otherFutureThing", content: [inner] };
    expect(renderAdf(doc(outer))).toBe("still here");
  });

  it("keeps an unknown wrapper's inline children in one sentence", () => {
    // Block-joining these would put a blank line between two halves of a
    // sentence merely because a mark change split the run in two.
    const caption = { type: "caption", content: [text("part one "), text("part two")] };
    expect(renderAdf(caption)).toBe("part one part two");
  });

  it("block-joins an unknown wrapper's children once any of them is a block", () => {
    const mixed = { type: "mystery", content: [paragraph(text("a")), paragraph(text("b"))] };
    expect(renderAdf(mixed)).toBe("a\n\nb");
  });

  it("recurses into a node with no type at all", () => {
    expect(renderAdf({ content: [paragraph(text("orphan"))] })).toBe("orphan");
  });
});

/** Everything a caller might hand these functions that is not an ADF node. */
const NOT_A_DOCUMENT: [label: string, value: unknown][] = [
  ["null", null],
  ["undefined", undefined],
  ["a number", 42],
  ["a string", "a string"],
  ["a boolean", true],
  ["an empty object", {}],
  ["an empty array", []],
  ["an empty doc", { type: "doc" }],
  ["a doc with an empty content array", { type: "doc", content: [] }],
  ["a node whose type is not a string", { type: 7, content: [] }],
  ["a doc whose content is not an array", { type: "doc", content: "nope" }],
  ["a bare NaN", Number.NaN],
];

describe("renderAdf, totality", () => {
  it.each(NOT_A_DOCUMENT)("returns the empty string for %s", (_label, value) => {
    expect(renderAdf(value)).toBe("");
  });

  it("returns the empty string when content is not an array", () => {
    // The likeliest malformed payload there is, and one that would throw on any
    // implementation that trusted `content.map`.
    expect(renderAdf({ type: "doc", content: "not an array" })).toBe("");
    expect(renderAdf({ type: "paragraph", content: { type: "text", text: "x" } })).toBe("");
    expect(renderAdf({ type: "bulletList", content: 3 })).toBe("");
    expect(renderAdf({ type: "table", content: null })).toBe("");
  });

  it("skips junk entries mixed in among real ones", () => {
    expect(renderAdf(doc(null, paragraph(text("real")), 42, "text", [], undefined))).toBe("real");
  });

  it("survives attrs that are not an object", () => {
    expect(renderAdf({ type: "heading", attrs: "level 2", content: [text("x")] })).toBe("# x");
    expect(renderAdf({ type: "media", attrs: null })).toBe("[attachment]");
    expect(renderAdf({ type: "status", attrs: [] })).toBe("");
  });

  it("survives a text node whose text is not a string", () => {
    expect(renderAdf({ type: "text", text: 42 })).toBe("");
    expect(renderAdf({ type: "text" })).toBe("");
  });

  it("does not throw or hang on a pathologically deep document", () => {
    // Deep enough to overflow the stack without the depth cap, which is the
    // point: a RangeError is still a throw, and this input is one line of
    // attacker-written JSON. The cap answers a reference cycle the same way.
    let nested: unknown = paragraph(text("bottom"));
    for (let i = 0; i < 10_000; i += 1) {
      nested = { type: "blockquote", content: [nested] };
    }

    expect(() => renderAdf(nested)).not.toThrow();
    expect(typeof renderAdf(nested)).toBe("string");
  });

  it("still renders a document nested as deeply as a human would nest one", () => {
    // The cap must not be so eager that it truncates real content.
    let nested: unknown = paragraph(text("bottom"));
    for (let i = 0; i < 8; i += 1) {
      nested = { type: "blockquote", content: [nested] };
    }

    expect(renderAdf(nested)).toContain("bottom");
  });

  it("does not throw when a property access itself throws", () => {
    const hostile = {
      get type(): string {
        throw new Error("no");
      },
    };
    expect(() => renderAdf(hostile)).not.toThrow();
    expect(renderAdf(hostile)).toBe("");
  });

  it("does not mutate the document it was given", () => {
    const before = JSON.stringify(OBSERVED_COMMENT);
    renderAdf(OBSERVED_COMMENT);
    referencedAttachments(OBSERVED_COMMENT);
    expect(JSON.stringify(OBSERVED_COMMENT)).toBe(before);
  });
});

describe("referencedAttachments", () => {
  it("returns the filename the observed comment points at", () => {
    expect(referencedAttachments(OBSERVED_COMMENT)).toEqual(["svgtest.svg"]);
  });

  it("returns filenames rather than media ids", () => {
    // Matching against `attachment[].filename` is the only join that works.
    // The UUID in attrs.id matches nothing in the issue payload at all.
    expect(referencedAttachments(OBSERVED_COMMENT)).not.toContain(
      "fd700241-3f0b-4c2c-8a3a-9d0f5b21c7ae",
    );
  });

  it("returns filenames in document order", () => {
    const document = doc(
      paragraph(text("first")),
      { type: "mediaSingle", content: [mediaNode("one.png")] },
      paragraph(text("then")),
      { type: "mediaSingle", content: [mediaNode("two.png")] },
      { type: "mediaGroup", content: [mediaNode("three.pdf")] },
    );
    expect(referencedAttachments(document)).toEqual(["one.png", "two.png", "three.pdf"]);
  });

  it("deduplicates a file embedded more than once, keeping first appearance", () => {
    const document = doc(
      { type: "mediaSingle", content: [mediaNode("shot.png")] },
      { type: "mediaSingle", content: [mediaNode("other.png")] },
      { type: "mediaSingle", content: [mediaNode("shot.png")] },
    );
    expect(referencedAttachments(document)).toEqual(["shot.png", "other.png"]);
  });

  it("returns an empty list for a document with no media", () => {
    expect(referencedAttachments(doc(paragraph(text("no files here"))))).toEqual([]);
  });

  it("omits media nodes with no usable filename", () => {
    // A blank entry here would become a lookup that silently matches nothing.
    const document = doc(
      { type: "mediaSingle", content: [{ type: "media", attrs: { id: "uuid-only" } }] },
      { type: "mediaSingle", content: [{ type: "media", attrs: { alt: "   " } }] },
      { type: "mediaSingle", content: [mediaNode("real.png")] },
    );
    expect(referencedAttachments(document)).toEqual(["real.png"]);
  });

  it("finds media buried inside list items and table cells", () => {
    const document = doc({
      type: "bulletList",
      content: [
        listItem(paragraph(text("with a file")), {
          type: "mediaSingle",
          content: [mediaNode("nested.png")],
        }),
      ],
    });
    expect(referencedAttachments(document)).toEqual(["nested.png"]);
  });

  it("finds media inside an unknown wrapper", () => {
    const document = doc({ type: "somethingNew", content: [mediaNode("hidden.png")] });
    expect(referencedAttachments(document)).toEqual(["hidden.png"]);
  });

  it("counts an inline media node too", () => {
    const document = doc(
      paragraph(text("see "), { type: "mediaInline", attrs: { alt: "inline.png" } }),
    );
    expect(referencedAttachments(document)).toEqual(["inline.png"]);
  });

  it("trims a filename with stray whitespace around it", () => {
    expect(referencedAttachments(mediaNode("  padded.png  "))).toEqual(["padded.png"]);
  });

  it.each(NOT_A_DOCUMENT)("returns an empty list for %s", (_label, value) => {
    expect(referencedAttachments(value)).toEqual([]);
  });

  it("accepts a bare array of nodes", () => {
    expect(referencedAttachments([mediaNode("a.png"), mediaNode("b.png")])).toEqual([
      "a.png",
      "b.png",
    ]);
  });

  it("does not throw on a pathologically deep document", () => {
    let nested: unknown = mediaNode("bottom.png");
    for (let i = 0; i < 10_000; i += 1) {
      nested = { type: "blockquote", content: [nested] };
    }
    expect(() => referencedAttachments(nested)).not.toThrow();
  });

  it("does not throw when a property access itself throws", () => {
    const hostile = {
      get content(): readonly unknown[] {
        throw new Error("no");
      },
    };
    expect(() => referencedAttachments(hostile)).not.toThrow();
    expect(referencedAttachments(hostile)).toEqual([]);
  });
});
