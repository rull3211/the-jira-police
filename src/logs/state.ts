/**
 * The viewer's state and every transition it makes, as a pure reducer.
 *
 * Terminal handling is the part a green suite says nothing about, so none of it lives here: the
 * shell in `cli/logs.ts` turns input into an `Action` and draws what `render.ts` returns, and
 * everything between those two points is this file.
 */

import type { LogLevel } from "../logger.ts";
import type { Filter } from "./filter.ts";
import { NO_FILTER, passes, toggle } from "./filter.ts";
import { LEVEL_ORDER, MARK_GLYPHS } from "./glyphs.ts";
import type { Entry } from "./line.ts";
import { parseLine } from "./line.ts";
import { assignKeys } from "./keys.ts";

/**
 * How many entries are kept. A daemon left running for a week would otherwise grow the buffer
 * without bound, and the viewer would be the process that exhausts memory first.
 */
export const MAX_ENTRIES = 10_000;

export interface ViewerState {
  readonly entries: readonly Entry[];
  /** Evicted by the cap. Shown, so a scrollback that begins mid-run says so. */
  readonly dropped: number;
  readonly filter: Filter;
  /** Sources seen so far, in first-seen order, which is what fixes their shortcuts. */
  readonly sources: readonly string[];
  readonly follow: boolean;
  /** Lines lifted off the bottom. `0` is the newest line; only meaningful when not following. */
  readonly scroll: number;
  readonly rows: number;
  readonly columns: number;
  readonly ended: boolean;
  readonly quit: boolean;
}

export type Action =
  | { readonly kind: "line"; readonly text: string }
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "resize"; readonly rows: number; readonly columns: number }
  | { readonly kind: "end" };

export function initialState(rows: number, columns: number): ViewerState {
  return {
    entries: [],
    dropped: 0,
    filter: NO_FILTER,
    sources: [],
    follow: true,
    scroll: 0,
    rows,
    columns,
    ended: false,
    quit: false,
  };
}

/** Rows the log body gets, once the filter rows and the footer have taken theirs. */
export const CHROME_ROWS = 4;

export function bodyRows(state: ViewerState): number {
  return Math.max(1, state.rows - CHROME_ROWS);
}

export function visibleEntries(state: ViewerState): readonly Entry[] {
  return state.entries.filter((entry) => passes(state.filter, entry));
}

/** How far up the buffer can go before its first line is on screen. */
function maxScroll(state: ViewerState): number {
  return Math.max(0, visibleEntries(state).length - bodyRows(state));
}

function clampScroll(state: ViewerState, scroll: number): number {
  return Math.max(0, Math.min(scroll, maxScroll(state)));
}

/**
 * The reader moved the view, so where they landed decides whether the tail is being tracked.
 *
 * Arriving at the bottom resumes following, which is what makes the common case one keystroke.
 */
function movedTo(state: ViewerState, scroll: number): ViewerState {
  const clamped = clampScroll(state, scroll);
  return { ...state, scroll: clamped, follow: clamped === 0 };
}

/**
 * The view moved without the reader asking — a line arrived, or the window changed shape.
 *
 * `follow` is left exactly as it was, because deriving it from the offset here silently releases a
 * hold: a buffer shorter than the window clamps to 0, and 0 would read as "back at the tail".
 */
function repositioned(state: ViewerState, scroll: number): ViewerState {
  return { ...state, scroll: clampScroll(state, scroll) };
}

function withLine(state: ViewerState, text: string): ViewerState {
  const entry = parseLine(text);
  const appended = [...state.entries, entry];
  const over = Math.max(0, appended.length - MAX_ENTRIES);
  const entries = over > 0 ? appended.slice(over) : appended;

  const sources =
    entry.kind === "log" && !state.sources.includes(entry.src)
      ? [...state.sources, entry.src]
      : state.sources;

  const grown: ViewerState = { ...state, entries, sources, dropped: state.dropped + over };

  // While following, the newest line stays on screen. While not, `scroll` rises with the buffer so
  // the line the reader stopped at stays under their eye instead of sliding upward.
  return state.follow ? { ...grown, scroll: 0 } : repositioned(grown, grown.scroll + 1);
}

function withKey(state: ViewerState, key: string): ViewerState {
  switch (key) {
    case "q":
    case "escape":
      return { ...state, quit: true };
    case "f":
      return state.follow ? { ...state, follow: false } : movedTo(state, 0);
    case "c":
      return { ...state, filter: NO_FILTER };
    case "j":
    case "down":
      return movedTo(state, state.scroll - 1);
    case "k":
    case "up":
      return movedTo(state, state.scroll + 1);
    case "pagedown":
      return movedTo(state, state.scroll - bodyRows(state));
    case "pageup":
      return movedTo(state, state.scroll + bodyRows(state));
    case "G":
      return movedTo(state, 0);
    case "g":
      return movedTo(state, maxScroll(state));
    default:
      break;
  }

  const level = LEVEL_ORDER[Number(key) - 1];
  if (/^[1-4]$/u.test(key) && level !== undefined) {
    return {
      ...state,
      filter: {
        ...state.filter,
        levels: toggle<LogLevel>(state.filter.levels, LEVEL_ORDER, level),
      },
    };
  }

  const mark = MARK_GLYPHS[Number(key) - 5];
  if (/^[56]$/u.test(key) && mark !== undefined) {
    return {
      ...state,
      filter: { ...state.filter, marks: toggle(state.filter.marks, MARK_GLYPHS, mark) },
    };
  }

  for (const [source, assigned] of assignKeys(state.sources)) {
    if (assigned === key) {
      return {
        ...state,
        filter: { ...state.filter, sources: toggle(state.filter.sources, state.sources, source) },
      };
    }
  }

  return state;
}

export function reduce(state: ViewerState, action: Action): ViewerState {
  switch (action.kind) {
    case "line":
      return withLine(state, action.text);
    case "key":
      return withKey(state, action.key);
    case "resize":
      // Clamped against the new height, or a shorter window leaves `scroll` past the first line.
      return repositioned({ ...state, rows: action.rows, columns: action.columns }, state.scroll);
    case "end":
      return { ...state, ended: true };
  }
}
