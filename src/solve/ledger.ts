/**
 * The two mechanics every human-readable record this pipeline writes needs: appending a row to an
 * append-only markdown scoreboard, and making model-authored text safe to sit in one.
 *
 * There are two such scoreboards now — `dev-lens.md` scores triage's blind `agent:solvable` call,
 * `repair-rounds.md` scores the repair pass — and they are separate pages on purpose, sharing only
 * what is here. `safeText` lives here rather than with either because the ticket comment in
 * `feedback.ts` needs it too, and because a second copy of an escaping rule is a second copy of
 * the bug it prevents.
 */

import { mkdir, appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import { oneLine } from "../text.ts";
import { FOOTER_SENTINEL } from "../triage/gate.ts";

/**
 * Makes untrusted text safe to place inside a structured document: collapses whitespace runs
 * (shared with `oneLine`), escapes pipes so it cannot forge a table column, and strips triage's
 * footer sentinel so a correction can't make triage's next run adopt this comment as its own.
 */
export function safeText(text: string): string {
  return oneLine(text.replaceAll(FOOTER_SENTINEL, "[sentinel removed]")).replaceAll("|", "\\|");
}

/**
 * Appends one row, writing `header` first if the file does not already start with it.
 *
 * Checked by content, not by file existence: an empty file left by an interrupted first write
 * would otherwise collect rows under no table at all.
 *
 * The sentinel is the header's own first line rather than a parameter beside it — a caller that
 * could pass the two separately could pass them disagreeing, and then every run re-appends a
 * header nobody notices until the page is unreadable.
 */
export async function appendLedgerRow(
  directory: string,
  file: string,
  header: string,
  row: string,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, file);
  const existing = await readFile(path, "utf8").catch(() => "");
  const [firstLine = ""] = header.split("\n");
  await appendFile(path, (existing.startsWith(firstLine) ? "" : header) + row, "utf8");
  return path;
}
