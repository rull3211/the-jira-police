/**
 * ADF (Atlassian Document Format) rendered to markdown-flavoured plain text, for feeding to a model.
 *
 * A media node's `attrs.id` is a Media Services UUID, not the Jira attachment id — only `attrs.alt`
 * (the filename) links it to `attachment[].filename`. `renderAdf` never throws: unknown node types
 * recurse into `content` rather than being dropped, and recursion is depth-capped against both a
 * stack overflow and quadratic blowup from a reference cycle.
 */

import { logger } from "../logger.ts";

/** How deep the walk follows `content` before giving up on a subtree; real ADF nests only a handful of levels. */
const MAX_DEPTH = 100;

/** Two spaces, so a nested list sits under its parent item rather than beside it. */
const LIST_INDENT = "  ";

/** Node types treated as inline when guessing whether an unknown wrapper's children are a sentence or a block list. */
const INLINE_TYPES = new Set([
  "text",
  "hardBreak",
  "emoji",
  "mention",
  "status",
  "inlineCard",
  "mediaInline",
]);

/** A node as received: an untyped bag of unknowns, forcing every read through the narrowing helpers below. */
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

/** A node's children, or none — `content` not being an array is the likeliest way a malformed payload arrives. */
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

/** Block-level children, separated by a blank line; empty renderings are dropped rather than joined. */
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

/** Blocks inside one list item, joined by a single newline — a blank line here reads as markdown's "loose" list. */
function renderItemBlocks(children: readonly unknown[], depth: number): string {
  return children
    .map((child) => renderNode(child, depth + 1))
    .filter(hasContent)
    .join("\n");
}

/** A mark, wrapped around already-rendered text; unknown marks return the text untouched. */
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
      // No usable href: emit the bare text rather than a link to nowhere.
      const href = asText(attrs["href"]).trim();
      return href === "" ? text : `[${text}](${href})`;
    }
    default:
      return text;
  }
}

/**
 * A text node with its marks applied, outermost last, matching Atlassian's own nesting order.
 * Whitespace-only text keeps its marks off, since `**  **` is not emphasis.
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

/** `[attachment: filename]`, built from `attrs.alt`; a missing alt still renders as `[attachment]` rather than nothing. */
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

/** A list, one item per line; an item that renders to nothing still gets a marker so later items keep their numbers. */
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

/** Prefixes every line, so a multi-line quote stays one quote; a bare blank line would otherwise end the quote early. */
function prefixLines(text: string, prefix: string): string {
  if (text === "") {
    return "";
  }
  return text
    .split("\n")
    .map((line) => (line === "" ? prefix.trimEnd() : prefix + line))
    .join("\n");
}

/** Flattens a rendering onto one line — for table cells, where a newline would break the row into a bogus new one. */
function singleLine(text: string): string {
  return text.replace(/\s*\n+\s*/gu, " ").trim();
}

/** One row: cells joined by a pipe, including the empty ones. */
function renderRow(node: AdfObject, depth: number): string {
  // Not filtered on `hasContent`: an empty cell is still a column, and dropping it shifts every later value left.
  return contentOf(node)
    .map((cell) => renderNode(cell, depth + 1))
    .join(" | ");
}

/** The dispatcher; an unrecognised node type is treated as a transparent wrapper around its children rather than an error. */
function renderNode(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) {
    return "";
  }

  // A bare array (e.g. `doc.content` handed over alone) is read as a sequence of blocks.
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
      // `shortName` survives a terminal, log line or diff; the codepoint in `text` may not.
      return asText(attrs["shortName"]) || asText(attrs["text"]);

    case "mention":
      // `attrs.text` is the display form; the account id beside it means nothing to a reader.
      return asText(attrs["text"]);

    case "status":
      return asText(attrs["text"]);

    case "inlineCard":
    case "blockCard":
      // A card is a URL Jira draws as a preview; there is no other text to recover.
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
      // Marks are ignored inside a fence so the sample matches the code the reporter actually ran.
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

    // Transparent wrappers; `mediaSingle` wraps exactly one `media` node and its layout carries no meaning here.
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

/** Normalises whitespace once, at the top, so individual renderers can emit whatever is natural. */
function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** Renders an ADF document, subtree, or anything at all, as plain text; unrecognised input returns the empty string rather than throwing. */
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
 * Filenames referenced by media nodes, in document order, deduplicated — never the media UUID in
 * `attrs.id`, which matches nothing in `attachment[].filename`.
 */
export function referencedAttachments(node: unknown): readonly string[] {
  const found: string[] = [];
  try {
    collectAttachments(node, 0, found);
  } catch (error) {
    // Partial results are kept: whatever was collected before the walk failed is still valid.
    logger.warn("adf.attachment_scan_failed", { error });
  }
  return [...new Set(found)];
}
