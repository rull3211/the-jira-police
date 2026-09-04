/**
 * ADF (Atlassian Document Format) rendered down to plain text.
 *
 * Jira Cloud's REST API v3 does not return rich text as a string. Descriptions
 * and comments come back as ADF — a JSON tree of typed nodes — and every
 * consumer in this service ultimately wants a string to hand to a model as
 * data. This module is that conversion, and nothing else: it reads a tree and
 * returns text. It performs no I/O, so it can be tested exhaustively against
 * payloads copied verbatim off the board.
 *
 * The output is markdown-flavoured rather than stripped bare. The reader is a
 * language model, and `**must**` carries the emphasis the author intended in a
 * notation the reader already understands, whereas dropping the marks throws
 * that signal away and keeping the raw JSON spends tokens on structure. The
 * same reasoning covers links: `[text](href)` keeps both halves, where a bare
 * `text` loses the destination and a bare href loses the sentence.
 *
 * ## The media/attachment id trap
 *
 * This is the one non-obvious fact in the format, and it has already cost time
 * once. A media node looks like this:
 *
 * ```json
 * {"type":"media","attrs":{"type":"file","id":"fd700241-…","alt":"svgtest.svg",
 *  "collection":"","localId":"d9fe878bd36b"}}
 * ```
 *
 * `attrs.id` is a **Media Services UUID**. It is *not* the Jira attachment id,
 * it does not appear anywhere in the issue's `attachment` array, and no amount
 * of string matching will connect the two. The only field that links a media
 * node to a real attachment is `attrs.alt`, which holds the **filename** —
 * matched against `attachment[].filename`. So the rendering here is
 * `[attachment: svgtest.svg]`, built from `alt`, and `referencedAttachments`
 * returns filenames for the same reason. Anyone who "fixes" this to use the id
 * because it looks more like an identifier will produce a lookup that matches
 * nothing, and will get an empty result rather than an error.
 *
 * ## Totality
 *
 * `renderAdf` never throws, whatever it is given. That is a hard requirement,
 * not politeness: the input is the body of a ticket or comment written by
 * whoever opened it, which makes it attacker-controlled, and it arrives from a
 * remote API whose shape can change without notice. A parser that throws on an
 * unexpected shape turns "one weird comment" into "the poller is down". So
 * every shape that is not recognised renders as the empty string, and both
 * public entry points sit behind a catch that logs and degrades.
 *
 * Two specific defences hold that promise up:
 *
 * 1. **Unknown node types recurse into `content` rather than being dropped.**
 *    Atlassian adds node types; this service does not get to be told. Losing a
 *    paragraph of a bug report because it was wrapped in something new is worse
 *    than rendering it without its wrapper's formatting, so the default case is
 *    "render the children" and not "return nothing".
 *
 * 2. **Recursion is depth-capped.** A hand-built payload can nest a thousand
 *    blockquotes and blow the call stack, and a `RangeError` is still a throw.
 *    The cap also makes a reference cycle — impossible from `JSON.parse`, quite
 *    possible from a caller passing a live object — terminate instead of hang.
 */

import { logger } from "../logger.ts";

/**
 * How deep the walk will follow `content` before giving up on a subtree.
 *
 * Real ADF from a human nests a handful of levels: a list inside a list inside
 * a table cell is already unusual. A hundred is far past anything a person
 * writes and far short of anything that endangers the stack, so the cap only
 * ever bites on input that was constructed to make it bite.
 */
const MAX_DEPTH = 100;

/** Two spaces, so a nested list sits under its parent item rather than beside it. */
const LIST_INDENT = "  ";

/**
 * Node types that are inline by nature, used only to guess at unknown wrappers.
 *
 * Not a general registry — the switch below is that. This exists for the
 * default case: when an unrecognised node's children turn out to be all text,
 * they are a sentence and must be concatenated. Block-joining them would put a
 * blank line between "the" and "cost" merely because a mark change split the
 * run into two `text` nodes.
 */
const INLINE_TYPES = new Set([
  "text",
  "hardBreak",
  "emoji",
  "mention",
  "status",
  "inlineCard",
  "mediaInline",
]);

/**
 * A node as it is actually available to us: a bag of unknowns.
 *
 * Deliberately not an `AdfNode` interface with optional typed fields. Such an
 * interface would be a claim about the payload that this module is in no
 * position to make — it describes what Atlassian sent last time — and it would
 * invite property access that reads as safe while being a lie. A record of
 * `unknown` forces every read through the narrowing helpers below, which is
 * exactly the discipline the totality requirement needs.
 */
type AdfObject = Record<string, unknown>;

function asObject(value: unknown): AdfObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as AdfObject;
}

/** A string field, or the empty string — never `undefined`, never a coerced number. */
function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function attrsOf(node: AdfObject): AdfObject {
  return asObject(node["attrs"]) ?? {};
}

/**
 * A node's children, or none.
 *
 * `content` being something other than an array is the single most likely way
 * for a malformed payload to reach this module, so it is answered here once and
 * every caller below can treat children as an array without asking again.
 */
function contentOf(node: AdfObject): readonly unknown[] {
  const content = node["content"];
  return Array.isArray(content) ? content : [];
}

function hasContent(rendered: string): boolean {
  return rendered.trim() !== "";
}

function isInline(value: unknown): boolean {
  const node = asObject(value);
  return node !== null && INLINE_TYPES.has(asText(node["type"]));
}

/**
 * Block-level children, separated by a blank line.
 *
 * Empty renderings are dropped rather than joined. ADF is full of nodes that
 * produce no text — an empty paragraph used as a spacer, a media node the
 * author deleted the alt from — and keeping them would emit runs of blank lines
 * that say nothing and cost tokens.
 */
function renderBlocks(children: readonly unknown[], depth: number): string {
  return children
    .map((child) => renderNode(child, depth + 1))
    .filter(hasContent)
    .join("\n\n");
}

/** Inline children, concatenated. No separator: the text nodes carry their own spaces. */
function renderInline(children: readonly unknown[], depth: number): string {
  return children.map((child) => renderNode(child, depth + 1)).join("");
}

/** The guess described at `INLINE_TYPES`: all-inline children are a sentence. */
function renderChildren(children: readonly unknown[], depth: number): string {
  if (children.length > 0 && children.every(isInline)) {
    return renderInline(children, depth);
  }
  return renderBlocks(children, depth);
}

/**
 * Blocks inside a single list item, separated by one newline rather than two.
 *
 * A list item's own bullet already separates it from its neighbours, and a
 * blank line between an item's text and the list nested under it is what
 * markdown reads as a "loose" list — extra vertical space for no reason, and a
 * structure that looks broken when the text is shown back to a human.
 */
function renderItemBlocks(children: readonly unknown[], depth: number): string {
  return children
    .map((child) => renderNode(child, depth + 1))
    .filter(hasContent)
    .join("\n");
}

/**
 * A mark, wrapped around already-rendered text.
 *
 * Unknown marks return the text untouched, for the same reason unknown nodes
 * recurse: the mark is decoration, the text is the message, and a mark this
 * service has never heard of is not a reason to lose a sentence.
 */
function applyMark(text: string, type: string, attrs: AdfObject): string {
  switch (type) {
    case "strong":
      return `**${text}**`;
    case "em":
      return `*${text}*`;
    case "code":
      return `\`${text}\``;
    case "strike":
      return `~~${text}~~`;
    case "link": {
      // A link mark with no usable href is a link to nowhere; emitting
      // `[text]()` would be worse than emitting the text, since it reads as a
      // deliberate empty destination rather than as missing data.
      const href = asText(attrs["href"]).trim();
      return href === "" ? text : `[${text}](${href})`;
    }
    default:
      return text;
  }
}

/**
 * A text node with its marks applied, outermost last.
 *
 * Marks are applied in array order, so the first mark ends up innermost. That
 * matches how Atlassian's own renderer nests them, and it is the order that
 * makes `[**text**](href)` out of `[strong, link]` — a bolded link — rather
 * than the meaningless `**[text](href)**`.
 *
 * Whitespace-only text keeps its marks off. A `**  **` in the output is not
 * emphasis, it is a rendering artefact that markdown does not even parse as a
 * mark, and the space between two bolded words arrives as exactly such a node.
 */
function renderText(node: AdfObject): string {
  const text = asText(node["text"]);
  if (text.trim() === "") {
    return text;
  }

  const marks = node["marks"];
  if (!Array.isArray(marks)) {
    return text;
  }

  let rendered = text;
  for (const raw of marks) {
    const mark = asObject(raw);
    if (mark !== null) {
      rendered = applyMark(rendered, asText(mark["type"]), attrsOf(mark));
    }
  }
  return rendered;
}

/**
 * `[attachment: filename]`, built from `attrs.alt`.
 *
 * See the module header: `alt` is the only field that ties this node to an
 * entry in the issue's `attachment` array. When it is missing the node is still
 * announced, because "there is a file here and I cannot name it" is information
 * the reader needs — silently omitting it makes a comment that says "see the
 * screenshot" look like it referenced nothing.
 */
function renderMedia(node: AdfObject): string {
  const filename = asText(attrsOf(node)["alt"]).trim();
  return filename === "" ? "[attachment]" : `[attachment: ${filename}]`;
}

/** `attrs.level`, clamped into the range markdown has headings for. */
function headingLevel(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }
  return Math.min(6, Math.max(1, Math.trunc(value)));
}

/** Where an ordered list starts counting; ADF's `attrs.order`, when it is sane. */
function listStart(attrs: AdfObject): number {
  const order = attrs["order"];
  if (typeof order === "number" && Number.isInteger(order) && order > 0) {
    return order;
  }
  return 1;
}

/**
 * A list, one item per line, with continuation lines indented under the marker.
 *
 * Numbering is this module's, counted off the items present, rather than
 * anything read out of the individual items — ADF does not put a number on a
 * `listItem`, the position in `content` *is* the number.
 *
 * An item that renders to nothing still gets its marker. Dropping it would
 * renumber every item after it, which turns a cosmetically empty bullet into a
 * quietly wrong document: "step 4" in the output would no longer be step 4 on
 * the ticket.
 */
function renderList(node: AdfObject, ordered: boolean, depth: number): string {
  const items = contentOf(node);
  let counter = listStart(attrsOf(node));

  const lines = items.map((item) => {
    const marker = ordered ? `${counter}. ` : "- ";
    counter += 1;

    const [first = "", ...rest] = renderNode(item, depth + 1).split("\n");
    return [marker + first, ...rest.map((line) => LIST_INDENT + line)].join("\n");
  });

  return lines.join("\n");
}

/**
 * Prefixes every line, so a multi-line quote stays one quote.
 *
 * Blank lines get the prefix with its trailing space removed rather than being
 * left bare. A bare blank line inside a blockquote ends the quote, so the
 * second paragraph of a quoted passage would silently stop being quoted.
 */
function prefixLines(text: string, prefix: string): string {
  if (text === "") {
    return "";
  }
  return text
    .split("\n")
    .map((line) => (line === "" ? prefix.trimEnd() : prefix + line))
    .join("\n");
}

/**
 * Flattens a rendering onto one line.
 *
 * Table cells only. A cell holds blocks, blocks are separated by newlines, and
 * a newline inside a cell breaks the row it belongs to — the columns after it
 * would appear to be a new row with a different number of fields.
 */
function singleLine(text: string): string {
  return text.replace(/\s*\n+\s*/gu, " ").trim();
}

/** One row: cells joined by a pipe, including the empty ones. */
function renderRow(node: AdfObject, depth: number): string {
  // Not filtered on `hasContent`, unlike every other join here. An empty cell
  // is still a column, and dropping it would shift every value after it left
  // by one — a table that reads as well-formed while saying something else.
  return contentOf(node)
    .map((cell) => renderNode(cell, depth + 1))
    .join(" | ");
}

/**
 * The dispatcher. Every recursion in this module goes through here.
 *
 * The cases are ordered inline atoms first, then blocks, then the containers,
 * and the default is deliberately not an error: see point 1 of the module
 * header. A node type nobody here has heard of is treated as a transparent
 * wrapper around its children.
 */
function renderNode(value: unknown, depth: number): string {
  // A bare array is not a node, but it is a perfectly reasonable thing for a
  // caller to hold — `doc.content` handed over on its own, say — and reading it
  // as a sequence of blocks costs one line and removes a sharp edge.
  if (Array.isArray(value)) {
    return renderBlocks(value, depth);
  }

  const node = asObject(value);
  if (node === null) {
    return "";
  }

  const type = asText(node["type"]);
  const attrs = attrsOf(node);

  switch (type) {
    case "text":
      return renderText(node);

    case "hardBreak":
      return "\n";

    case "rule":
      return "---";

    case "emoji":
      // `shortName` first: it is the field ADF guarantees, and `:warning:`
      // survives a terminal, a log line and a diff, where the codepoint in
      // `text` may not.
      return asText(attrs["shortName"]) || asText(attrs["text"]);

    case "mention":
      // `attrs.text` is the display form, "@Jane Doe". The `id` beside it is an
      // Atlassian account id, which means nothing to a reader and is not worth
      // the tokens.
      return asText(attrs["text"]);

    case "status":
      return asText(attrs["text"]);

    case "inlineCard":
    case "blockCard":
      // A card is a URL that Jira draws as a preview. The URL is the whole
      // content; there is no other text to recover.
      return asText(attrs["url"]);

    case "media":
    case "mediaInline":
      return renderMedia(node);

    case "paragraph":
      return renderInline(contentOf(node), depth);

    case "heading": {
      const body = renderInline(contentOf(node), depth);
      if (!hasContent(body)) {
        return "";
      }
      return `${"#".repeat(headingLevel(attrs["level"]))} ${body}`;
    }

    case "codeBlock": {
      // Marks are ignored inside a fence on purpose: a `**` that the author
      // typed as code must survive as `**`, and rendering the marks would make
      // the code sample differ from the code the reporter actually ran.
      const language = asText(attrs["language"]).trim();
      const body = contentOf(node)
        .map((child) => asText(asObject(child)?.["text"]))
        .join("");
      return `\`\`\`${language}\n${body}\n\`\`\``;
    }

    case "blockquote":
      return prefixLines(renderBlocks(contentOf(node), depth), "> ");

    case "bulletList":
    case "orderedList":
      return renderList(node, type === "orderedList", depth);

    case "listItem":
      return renderItemBlocks(contentOf(node), depth);

    case "table":
      return contentOf(node)
        .map((row) => renderNode(row, depth + 1))
        .filter(hasContent)
        .join("\n");

    case "tableRow":
      return renderRow(node, depth);

    case "tableCell":
    case "tableHeader":
      return singleLine(renderBlocks(contentOf(node), depth));

    // Transparent wrappers, named rather than left to the default so a reader
    // can see they were considered. `mediaSingle` is how every image on this
    // board arrives — it wraps exactly one `media` node, and the layout and
    // width it carries have no meaning in plain text.
    case "doc":
    case "mediaSingle":
    case "mediaGroup":
    case "panel":
    case "expand":
    case "nestedExpand":
      return renderBlocks(contentOf(node), depth);

    default:
      return renderChildren(contentOf(node), depth);
  }
}

/**
 * Normalises whitespace, once, at the top.
 *
 * Every rule here exists because some composition of the renderers above can
 * produce the thing it removes: trailing spaces come from an empty list marker,
 * runs of blank lines come from a paragraph that ends in two `hardBreak`s
 * meeting the blank line that separates it from the next block, and leading
 * blank lines come from a document that opens with an empty paragraph. Doing it
 * here rather than in each renderer keeps the renderers composable — they may
 * emit whatever is natural, knowing the seams get cleaned up afterwards.
 */
function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/**
 * Renders an ADF document, subtree, or anything at all, as plain text.
 *
 * Total by contract: unrecognised input is the empty string, and the catch is
 * the backstop for the shapes that narrowing cannot anticipate — an object with
 * a throwing getter, a `Proxy`, a revoked one. It logs, because a silent
 * `return ""` here would look exactly like a genuinely empty comment and there
 * would be nothing to find later.
 */
export function renderAdf(node: unknown): string {
  try {
    return tidy(renderNode(node, 0));
  } catch (error) {
    logger.warn("adf.render_failed", { error });
    return "";
  }
}

function collectAttachments(value: unknown, depth: number, into: string[]): void {
  if (depth > MAX_DEPTH) {
    return;
  }

  if (Array.isArray(value)) {
    for (const child of value) {
      collectAttachments(child, depth + 1, into);
    }
    return;
  }

  const node = asObject(value);
  if (node === null) {
    return;
  }

  const type = asText(node["type"]);
  if (type === "media" || type === "mediaInline") {
    const filename = asText(attrsOf(node)["alt"]).trim();
    if (filename !== "") {
      into.push(filename);
    }
  }

  for (const child of contentOf(node)) {
    collectAttachments(child, depth + 1, into);
  }
}

/**
 * Filenames referenced by media nodes, in document order, deduplicated.
 *
 * Filenames, emphatically not ids — see the module header. This is what lets a
 * caller answer "which of the issue's attachments is this comment actually
 * talking about", by matching these against `attachment[].filename`; the media
 * UUID in `attrs.id` cannot answer it at all.
 *
 * Nodes whose `alt` is missing or blank contribute nothing. `renderAdf` still
 * announces them as `[attachment]`, because a reader benefits from knowing a
 * file is there, but a caller resolving names has nothing to resolve and an
 * empty string in this list would only be a lookup that silently matches
 * nothing.
 *
 * Order is first-appearance and duplicates are collapsed: a comment that embeds
 * the same screenshot twice references one attachment, not two.
 */
export function referencedAttachments(node: unknown): readonly string[] {
  const found: string[] = [];
  try {
    collectAttachments(node, 0, found);
  } catch (error) {
    // Partial results are kept rather than discarded. Whatever was collected
    // before the walk hit trouble is still true.
    logger.warn("adf.attachment_scan_failed", { error });
  }
  return [...new Set(found)];
}
