/**
 * The scoreboard for the repair round, whose verdict the pipeline otherwise throws away, and what
 * `PLAN.md` §45 reads before it may start phase three.
 *
 * A sibling of `dev-lens.md`, not a column on it: one table answering both would fuse two
 * questions. Writer and reader live here together so a test can prove they agree.
 *
 * **The harness writes every column but the last.** `Read` is a person's, and nothing here may
 * change it after the row is written.
 */

import { resolve } from "node:path";

import { appendLedgerRow, safeText } from "./ledger.ts";
import type { SolveOutcome } from "./orchestrator.ts";

/** Append-only, and named so no issue key can collide with it. */
export const REPAIR_LEDGER_FILE = "repair-rounds.md";

/** What the harness writes into `Read` on a round whose verdict only a person can audit. */
export const UNREAD = "unread";

/** What it writes there on every other kind, and in any cell with nothing to say. */
const NOTHING = "—";

/**
 * Written once, when the page does not exist yet. Lives here rather than only in the artifact:
 * `groomed/` is gitignored, so a convention recorded solely in the file dies with it.
 */
export const HEADER = [
  "# Repair rounds",
  "",
  "One row per repair round, appended, never rewritten. A failed verification buys one repair",
  "pass (`REPAIR_ROUND`) and `runPipeline` discards its verdict, so this page is the only place",
  "those verdicts accumulate. Read the `Round` column down the page before letting anything act",
  "on one.",
  "",
  "**The `Read` column is yours, not the harness's.** A `verified` round is written `unread` and",
  "stays that way until a person opens the worktree, reads the diff, and replaces the cell by",
  "hand. Write what the diff *did* — `honest` where it corrected the code, `cheap` where it",
  "weakened the assertion that failed — and the date. A passing re-verification is reachable both",
  "ways and no exit code tells them apart, which is the whole reason the verdict is discarded:",
  '"a `verified` happened" and "a `verified` was read and found honest" are the two claims this',
  "column exists to keep apart.",
  "",
  "Rounds that ended any other way are written `—`, because the bar in `PLAN.md` §45 turns on",
  "`verified` alone. Annotate one anyway if you read it; nothing here will overwrite you.",
  "",
  "The worktree path is the one the round ran in, recorded as it was at the time. A later solve",
  "for the same ticket moves that directory to a `-salvaged-<timestamp>` sibling, so an old path",
  "is where to start looking rather than a promise.",
  "",
  "**Two things this page cannot show you.** A round whose run then tripped the write-escape guard",
  "leaves no row — the outcome becomes `escaped`, which does not carry the round's verdict. And a",
  "bare `|` typed into a cell by hand ends the row early; escape it as `\\|`. `pnpm repair:ledger`",
  "counts a line it cannot read and calls its totals a floor, so neither loss is silent.",
  "",
  "| When | Ticket | Round | Files | Worktree | Read |",
  "| --- | --- | --- | --- | --- | --- |",
  "",
].join("\n");

/**
 * One table row, or `null` when the outcome bought no repair round.
 *
 * A run that escaped after its round is the case this cannot see: `escapeVerdict` replaces the
 * outcome with `escaped`, which carries `would` and not `repairOutcome`.
 */
export function repairRow(issueKey: string, outcome: SolveOutcome, now: Date): string | null {
  if (outcome.kind !== "failed" || outcome.repairOutcome === undefined) {
    return null;
  }
  const touched = outcome.repair?.filesTouched ?? [];
  const files = touched.length === 0 ? NOTHING : touched.map((file) => safeText(file)).join(", ");
  // Only `verified` owes a reading: a column nobody can clear stops being read at all.
  const read = outcome.repairOutcome === "verified" ? UNREAD : NOTHING;
  return `| ${now.toISOString()} | ${issueKey} | ${outcome.repairOutcome} | ${files} | ${safeText(outcome.worktree.path)} | ${read} |\n`;
}

/**
 * Appends the row, if there is one. Returns where it landed, or `null` when no round ran.
 *
 * Writing a row for every failed solve would make `REPAIR_ROUND=false` indistinguishable from a
 * round that reported nothing.
 */
export async function recordRepairRound(
  directory: string,
  issueKey: string,
  outcome: SolveOutcome,
  now: Date,
): Promise<string | null> {
  const row = repairRow(issueKey, outcome, now);
  if (row === null) {
    return null;
  }
  return await appendLedgerRow(directory, REPAIR_LEDGER_FILE, HEADER, row);
}

export interface RepairRecord {
  readonly when: string;
  readonly issueKey: string;
  readonly round: string;
  readonly files: string;
  readonly worktree: string;
  readonly read: string;
}

export interface LedgerReading {
  readonly records: readonly RepairRecord[];
  /** Counted rather than skipped: a page that silently drops rows understates what it scores. */
  readonly unreadable: number;
}

const COLUMNS = 6;

/**
 * Splits a table line on the pipes the writer did not escape.
 *
 * A plain split would tear a `safeText`-escaped filename in half and shift every column after it:
 * the row still parses, with the wrong answer in `Round`.
 */
function cells(line: string): readonly string[] {
  return line
    .split(/(?<!\\)\|/u)
    .slice(1, -1)
    .map((cell) => cell.trim().replaceAll("\\|", "|"));
}

/**
 * Reads the page back. Tested against {@link repairRow} rather than a fixture, which would stop
 * seeing the writer change.
 */
export function parseLedger(text: string): LedgerReading {
  const records: RepairRecord[] = [];
  let unreadable = 0;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      continue;
    }
    const parts = cells(trimmed);
    // Counted before anything is skipped: a heading test running first swallows a hand-written
    // row whose date cell is `-`, without it ever reaching `unreadable`.
    if (parts.length !== COLUMNS) {
      unreadable += 1;
      continue;
    }
    const [when = "", issueKey = "", round = "", files = "", worktree = "", read = ""] = parts;
    // The alignment row is every cell ASCII hyphens, not just the first — which is why `NOTHING`
    // is an em dash and must stay one.
    if (when === "When" || parts.every((cell) => /^:?-+:?$/u.test(cell))) {
      continue;
    }
    records.push({ when, issueKey, round, files, worktree, read });
  }

  return { records, unreadable };
}

/** How many rounds ended each way, commonest first, then alphabetically so the order is stable. */
export function distribution(
  records: readonly RepairRecord[],
): readonly (readonly [string, number])[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    counts.set(record.round, (counts.get(record.round) ?? 0) + 1);
  }
  return [...counts].toSorted(([leftRound, left], [rightRound, right]) =>
    left === right ? leftRound.localeCompare(rightRound) : right - left,
  );
}

/** A `verified` round still carrying what the harness wrote, so nobody has read its diff. */
export function isUnread(record: RepairRecord): boolean {
  return record.round === "verified" && record.read === UNREAD;
}

/**
 * What to say when there is no page — the answer most at risk of being over-read.
 *
 * An absent page says nothing about whether a round has run: a solve writes its row under the
 * checkout it ran in, which this process cannot see. `supplied` is the raw `REPAIR_ROUND` so an
 * unset variable reads as unset rather than as the default it resolves to.
 */
export function renderNoPage(
  path: string,
  repairRoundOn: boolean,
  supplied: string | undefined,
): string {
  const set = supplied !== undefined && supplied.trim() !== "";
  // Resolved here, not trusted from the caller: `OUTPUT_DIR` is relative, so a bare path reads as
  // an answer about whichever checkout you happen to be in.
  return (
    `No page at ${resolve(path)}\n\n` +
    `That is not evidence that no repair round has run. A solve writes its row under the\n` +
    `checkout it ran in, and solve:once needs credentials a worktree may not carry — so the\n` +
    `rows collect wherever those live. Look there before concluding.\n\n` +
    `${
      set
        ? `REPAIR_ROUND is "${supplied.trim()}" in this environment.`
        : `REPAIR_ROUND is unset in this environment, so it reads as the built-in default (on).`
    }\n` +
    `${repairRoundOn ? "" : "Nothing is buying a round while that is false.\n"}` +
    `A round is bought by a failed verification:\n` +
    `  REPAIR_ROUND=true pnpm solve:once <KEY> --solve\n`
  );
}

/**
 * The distribution, then every `verified` round with whatever its `Read` cell says.
 *
 * `Read` cells are reproduced verbatim, never classified: counting "honest" against "cheap" would
 * count the string describing the event, and this page exists because nothing mechanical can see
 * the event itself.
 */
export function renderSummary(reading: LedgerReading): string {
  const { records, unreadable } = reading;
  const verified = records.filter((record) => record.round === "verified");
  const unread = verified.filter((record) => isUnread(record));

  const lines = [
    `${String(records.length)} repair round(s) recorded.`,
    "",
    "How they ended",
    ...distribution(records).map(([round, count]) => `  ${String(count).padStart(4)}  ${round}`),
  ];

  if (unreadable > 0) {
    lines.push(
      "",
      `${String(unreadable)} table line(s) could not be read as a row, so the counts above are a floor.`,
    );
  }

  lines.push(
    "",
    `Green rounds: ${String(verified.length)}. That is the verdict no exit code can audit,`,
    "so PLAN.md §45 needs each one read as a diff before anything may act on it.",
    "Read one with:  git -C <worktree> diff HEAD",
    "",
  );

  if (verified.length === 0) {
    lines.push("  (none yet)");
  }
  for (const record of verified) {
    lines.push(`  ${record.when}  ${record.issueKey}  ${isUnread(record) ? "UNREAD" : "read"}`);
    lines.push(`    worktree: ${record.worktree}`);
    lines.push(`    files:    ${record.files}`);
    // Verbatim, and only when a person has written something: the evidence, not a summary of it.
    if (!isUnread(record)) {
      lines.push(`    read:     ${record.read}`);
    }
  }

  if (unread.length > 0) {
    lines.push(
      "",
      `Never read: ${String(unread.length)} of ${String(verified.length)}. Until that is none, this`,
      "page shows that rounds happened, not that any of them were honest.",
    );
  }

  return `${lines.join("\n")}\n`;
}
