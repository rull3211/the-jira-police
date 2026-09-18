/**
 * Every glyph the viewer prints, and the check that each one occupies two terminal columns.
 *
 * `ℹ️` and `⚠️` are the obvious choices for info and warn, and both are wrong here: each is a base
 * character plus U+FE0F, which some terminals render one column wide and some two. A single warning
 * would then shear every column to its right for the rest of the screen. The glyphs below are all
 * single code points with `Emoji_Presentation=Yes`, which is the property that makes a terminal
 * reserve two columns without being asked.
 */

import type { LogLevel } from "../logger.ts";
import { NEWS_MARK, QUIET_MARK } from "../logger.ts";

/**
 * Verified `Emoji_Presentation=Yes`, one entry per glyph rather than a block range.
 *
 * Ranges would be wrong: `U+1F321` 🌡 sits inside the same block as `U+1F527` 🔧 and is *not*
 * emoji-presentation, so it needs U+FE0F and renders narrow. Adding a glyph means adding its code
 * point here, which is the point — the addition is where somebody checks.
 */
const WIDE_CODE_POINTS: ReadonlySet<number> = new Set([
  0x23f3, // ⏳ hourglass with flowing sand
  0x1f50d, // 🔍 magnifying glass tilted left
  0x1f527, // 🔧 wrench
  0x1f534, // 🔴 red circle
  0x1f535, // 🔵 blue circle
  0x1f7e0, // 🟠 orange circle
]);

/** True only for a lone code point this module has verified renders two columns wide. */
export function isWideGlyph(glyph: string): boolean {
  const points = [...glyph];
  if (points.length !== 1) {
    return false;
  }
  const point = glyph.codePointAt(0);
  return point !== undefined && WIDE_CODE_POINTS.has(point);
}

/** The level, as a glyph. Severity reads as colour; `debug` is the odd one out because it is not severity. */
export const LEVEL_GLYPHS: Readonly<Record<LogLevel, string>> = {
  debug: "🔍",
  info: "🔵",
  warn: "🟠",
  error: "🔴",
};

/** The two `q` marks, taken from the logger rather than restated, so they cannot drift apart. */
export const MARK_GLYPHS: readonly string[] = [QUIET_MARK, NEWS_MARK];

/** Order the level filters are offered in, which is severity and not the record's key order. */
export const LEVEL_ORDER: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/**
 * Printable width in terminal columns.
 *
 * Everything outside the wide table counts as one column, and a variation selector as none. That is
 * exact for the glyphs above and for the ASCII the rest of a line is made of; it would be wrong for
 * CJK text in a ticket summary, which is a shear in the body rather than in the columns the filter
 * rows depend on.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    if (point === 0xfe0f || point === 0xfe0e) {
      continue;
    }
    width += WIDE_CODE_POINTS.has(point) ? 2 : 1;
  }
  return width;
}

/** Cut to `columns` printable columns, never mid-glyph, so a narrow terminal cannot split an emoji. */
export function truncateToWidth(text: string, columns: number): string {
  if (columns <= 0) {
    return "";
  }
  let width = 0;
  let out = "";
  for (const character of text) {
    const next = width + displayWidth(character);
    if (next > columns) {
      return out;
    }
    out += character;
    width = next;
  }
  return out;
}
