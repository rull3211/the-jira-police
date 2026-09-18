/**
 * Which entries the viewer shows. Three independent axes, ANDed.
 *
 * An empty set means "no opinion", not "nothing" — a filter nobody has touched shows everything,
 * and the last glyph on an axis cannot be switched off into a blank screen.
 */

import type { LogLevel } from "../logger.ts";
import type { Entry } from "./line.ts";

export interface Filter {
  /** `q` marks kept. Empty means every mark. */
  readonly marks: ReadonlySet<string>;
  readonly levels: ReadonlySet<LogLevel>;
  readonly sources: ReadonlySet<string>;
}

export const NO_FILTER: Filter = {
  marks: new Set(),
  levels: new Set(),
  sources: new Set(),
};

/**
 * A line the parser could not classify is always shown.
 *
 * It has no level and no source, so every filter would exclude it by default and a stack trace
 * would vanish the moment an operator narrowed to one subsystem — the silent loss this viewer
 * exists to avoid, arriving through the filter instead of through the parser.
 */
export function passes(filter: Filter, entry: Entry): boolean {
  if (entry.kind === "raw") {
    return true;
  }
  if (filter.marks.size > 0 && !filter.marks.has(entry.mark)) {
    return false;
  }
  if (filter.levels.size > 0 && !filter.levels.has(entry.level)) {
    return false;
  }
  if (filter.sources.size > 0 && !filter.sources.has(entry.src)) {
    return false;
  }
  return true;
}

/** Present in the set, or the set is empty and has no opinion — both render as "on". */
export function isActive(chosen: ReadonlySet<string>, value: string): boolean {
  return chosen.size === 0 || chosen.has(value);
}

/**
 * Toggling the last remaining member clears the axis rather than emptying it.
 *
 * Without this, switching off every glyph in a row leaves a screen that is blank for a reason
 * nothing on it explains. Clearing reads the same way — everything shows — and is recoverable.
 */
export function toggle<T extends string>(
  chosen: ReadonlySet<T>,
  all: readonly T[],
  value: T,
): ReadonlySet<T> {
  // An untouched axis means every member; the first toggle narrows to the one that was not clicked.
  const explicit: ReadonlySet<T> = chosen.size === 0 ? new Set(all) : chosen;
  const next = new Set(explicit);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next.size === 0 || next.size === all.length ? new Set<T>() : next;
}
