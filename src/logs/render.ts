/**
 * State to screen: exactly `rows` strings, each at most `columns` printable columns.
 *
 * A filter's on/off state is carried by brackets rather than by colour alone — `[1🔍]` against
 * ` 1🔍 ` — because the two forms are the same width, so toggling never moves the row, and the
 * screen still says which filters are on over a connection that drops the escape codes.
 */

import type { Entry, LogEntry } from "./line.ts";
import { clockOf } from "./line.ts";
import { isActive } from "./filter.ts";
import { LEVEL_GLYPHS, LEVEL_ORDER, MARK_GLYPHS, displayWidth, truncateToWidth } from "./glyphs.ts";
import { assignKeys } from "./keys.ts";
import type { ViewerState } from "./state.ts";
import { bodyRows, visibleEntries } from "./state.ts";

const ESC = "\u001B[";

export const DIM = `${ESC}2m`;
export const BOLD = `${ESC}1m`;
export const RESET = `${ESC}0m`;

/** Widest `src` given a column; past this the name is cut rather than allowed to move the message. */
const SRC_COLUMNS = 12;

function padTo(text: string, columns: number): string {
  const short = truncateToWidth(text, columns);
  return short + " ".repeat(Math.max(0, columns - displayWidth(short)));
}

/** `[x]` when on, `  ` of the same width when off, so the row never shifts. */
function chip(label: string, on: boolean): string {
  return on ? `${BOLD}[${label}]${RESET}` : `${DIM} ${label} ${RESET}`;
}

/** `key=value`, with anything that is not a scalar rendered as compact JSON. */
export function formatFields(fields: Readonly<Record<string, unknown>>): string {
  return Object.entries(fields)
    .map(([key, value]) => {
      if (typeof value === "string") {
        return `${key}=${value}`;
      }
      if (typeof value === "number" || typeof value === "boolean" || value === null) {
        return `${key}=${String(value)}`;
      }
      return `${key}=${JSON.stringify(value) ?? "?"}`;
    })
    .join(" ");
}

/** One log line, in fixed columns: mark, clock, level, source, message, then the fields. */
export function formatLog(entry: LogEntry): string {
  const glyph = LEVEL_GLYPHS[entry.level];
  const mark = entry.mark === "" ? "  " : entry.mark;
  const fields = formatFields(entry.fields);
  const tail = fields === "" ? "" : `  ${DIM}${fields}${RESET}`;
  return `${mark} ${clockOf(entry.ts)} ${glyph} ${padTo(entry.src, SRC_COLUMNS)} ${entry.message}${tail}`;
}

/**
 * A line the parser could not read, shown exactly as it arrived.
 *
 * No column layout and no prefix: it is not a log record, and dressing it as one would suggest the
 * viewer understood fields it never parsed.
 */
function formatRaw(entry: Entry): string {
  return `${DIM}${entry.text}${RESET}`;
}

function statusRow(state: ViewerState): string {
  const shown = visibleEntries(state).length;
  const mode = state.follow ? "following" : `paused +${String(state.scroll)}`;
  const ended = state.ended ? " · feed closed" : "";
  const dropped = state.dropped > 0 ? ` · ${String(state.dropped)} dropped` : "";
  return `${BOLD}logs${RESET} ${DIM}${String(shown)}/${String(state.entries.length)} lines · ${mode}${ended}${dropped}${RESET}`;
}

function levelRow(state: ViewerState): string {
  const levels = LEVEL_ORDER.map((level, index) =>
    chip(`${String(index + 1)}${LEVEL_GLYPHS[level]}`, isActive(state.filter.levels, level)),
  );
  const marks = MARK_GLYPHS.map((mark, index) =>
    chip(`${String(index + 5)}${mark}`, isActive(state.filter.marks, mark)),
  );
  return `${levels.join("")}  ${marks.join("")}`;
}

function sourceRow(state: ViewerState): string {
  if (state.sources.length === 0) {
    return `${DIM}(no source seen yet)${RESET}`;
  }
  const keys = assignKeys(state.sources);
  return state.sources
    .map((source) => {
      const key = keys.get(source);
      const label = key === undefined ? source : `${key} ${source}`;
      return chip(label, isActive(state.filter.sources, source));
    })
    .join("");
}

const FOOTER = "q quit · f follow · c clear · j/k scroll · g/G top/bottom · digits+letters filter";

/** Every line of the screen, chrome included, clipped to the window. */
export function render(state: ViewerState): string[] {
  const visible = visibleEntries(state);
  const height = bodyRows(state);
  const end = Math.max(0, visible.length - state.scroll);
  const window = visible.slice(Math.max(0, end - height), end);

  const body = window.map((entry) => (entry.kind === "log" ? formatLog(entry) : formatRaw(entry)));
  while (body.length < height) {
    body.push("");
  }

  return [
    statusRow(state),
    levelRow(state),
    sourceRow(state),
    ...body,
    `${DIM}${FOOTER}${RESET}`,
  ].map((line) => clip(line, state.columns));
}

/**
 * Truncate to the window width while leaving the escape codes alone.
 *
 * Escapes print nothing, so counting them as columns would cut a line well before its edge; passing
 * them through uncounted keeps the cut where the text actually runs out. The trailing reset is
 * re-added because the cut may have landed before the original one.
 */
export function clip(line: string, columns: number): string {
  let width = 0;
  let out = "";
  let index = 0;

  while (index < line.length) {
    if (line.startsWith(ESC, index)) {
      const end = line.indexOf("m", index);
      if (end !== -1) {
        out += line.slice(index, end + 1);
        index = end + 1;
        continue;
      }
    }
    const character = String.fromCodePoint(line.codePointAt(index) ?? 0);
    const next = width + displayWidth(character);
    if (next > columns) {
      return `${out}${RESET}`;
    }
    out += character;
    width = next;
    index += character.length;
  }

  return out;
}
