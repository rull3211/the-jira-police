/**
 * Which key toggles which source.
 *
 * Sources are discovered from the stream rather than declared here, so their keys are handed out at
 * runtime and must not land on a key that already means something. The exclusion is a set rather
 * than a convention because the collision would be silent: a new command key that happened to be
 * assigned to a source would make that source's toggle stop working, on a screen that still draws
 * the letter beside it.
 */

/** Keys the viewer reserves. Digits are levels and marks and are never handed to a source. */
export const COMMAND_KEYS: ReadonlySet<string> = new Set([
  "q", // quit
  "f", // hold / follow
  "c", // clear every filter
  "j", // down
  "k", // up
  "g", // top
  "G", // bottom
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
]);

const LOWER = "abcdefghijklmnopqrstuvwxyz";

/**
 * Lowercase first, then uppercase, minus the reserved keys.
 *
 * A letter is excluded in both cases even though only one is reserved: `G` and `g` differing in
 * meaning is already enough to mistype, and a source on the other case of a command key would make
 * a slipped shift do something unrelated instead of nothing.
 */
export const SOURCE_KEY_POOL: readonly string[] = [...LOWER, ...LOWER.toUpperCase()].filter(
  (key) => !COMMAND_KEYS.has(key) && !COMMAND_KEYS.has(key.toLowerCase()),
);

/**
 * One key per source, in the order they were first seen.
 *
 * A source past the end of the pool gets no key. It still shows in the list and is still filtered
 * on; what it loses is the shortcut, which is why the pool is asserted against `LOG_SOURCES` in the
 * test rather than left to be discovered on the screen.
 */
export function assignKeys(sources: readonly string[]): ReadonlyMap<string, string> {
  const keys = new Map<string, string>();
  sources.forEach((source, index) => {
    const key = SOURCE_KEY_POOL[index];
    if (key !== undefined) {
      keys.set(source, key);
    }
  });
  return keys;
}
