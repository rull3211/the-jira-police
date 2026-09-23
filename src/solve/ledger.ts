/**
 * Append-only markdown scoreboard mechanics, shared by `dev-lens.md` and `repair-rounds.md`.
 *
 * `safeText` lives here rather than with either: `feedback.ts` needs it too, and a second copy of
 * an escaping rule is a second copy of the bug it prevents.
 */

import { mkdir, appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import { oneLine } from "../text.ts";
import { FOOTER_SENTINEL } from "../triage/gate.ts";

/**
 * Escapes pipes so untrusted text cannot forge a table column, and strips triage's footer sentinel
 * so a correction cannot make triage's next run adopt this comment as its own.
 */
export function safeText(text: string): string {
  return oneLine(text.replaceAll(FOOTER_SENTINEL, "[sentinel removed]")).replaceAll("|", "\\|");
}

/**
 * Appends one row, writing `header` first if the file does not already start with it.
 *
 * Checked by content, not existence: an empty file from an interrupted first write would otherwise
 * collect rows under no table. The sentinel is the header's own first line so no caller can pass
 * the two disagreeing.
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
