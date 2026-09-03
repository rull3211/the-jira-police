/**
 * Durable poll state: how far we have read, and which issues we already handled.
 *
 * Both halves are needed. The cursor bounds the JQL window, but Jira's date
 * filters are minute-precision, so the key set is what actually prevents
 * duplicate triage runs.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface PollState {
  /** ISO-8601 timestamp of the newest issue processed, or null on first run. */
  readonly cursor: string | null;
  /** Recently processed issue keys, newest last. */
  readonly seenKeys: readonly string[];
}

export const EMPTY_STATE: PollState = { cursor: null, seenKeys: [] };

/**
 * Cap on retained keys. The window is minutes wide and the board sees ~5 issues
 * a day, so this is orders of magnitude more history than dedupe needs.
 */
export const MAX_SEEN_KEYS = 1_000;

function isPollState(value: unknown): value is PollState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const cursorOk = candidate["cursor"] === null || typeof candidate["cursor"] === "string";
  const keysOk =
    Array.isArray(candidate["seenKeys"]) &&
    candidate["seenKeys"].every((key) => typeof key === "string");
  return cursorOk && keysOk;
}

export async function loadState(path: string): Promise<PollState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return EMPTY_STATE;
    }
    throw error;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!isPollState(parsed)) {
    throw new Error(`Malformed state file at ${path}`);
  }
  return parsed;
}

/**
 * Write via a temp file plus rename so a crash mid-write cannot leave truncated
 * state behind — that would re-trigger triage on issues already handled.
 */
export async function saveState(path: string, state: PollState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

export function recordSeen(
  state: PollState,
  keys: readonly string[],
  newestCreated: string | null,
): PollState {
  if (keys.length === 0) {
    return state;
  }

  const merged = [...state.seenKeys];
  const existing = new Set(state.seenKeys);
  for (const key of keys) {
    if (!existing.has(key)) {
      merged.push(key);
      existing.add(key);
    }
  }

  return {
    cursor: newestCreated ?? state.cursor,
    seenKeys: merged.slice(-MAX_SEEN_KEYS),
  };
}

export function isUnseen(state: PollState, key: string): boolean {
  return !state.seenKeys.includes(key);
}
