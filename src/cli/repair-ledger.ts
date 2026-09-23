/**
 * Reads `repair-rounds.md` back as a distribution — what `architecture/solve.md` §15 says decides whether acting on a repair stays on.
 *
 *   pnpm repair:ledger
 *
 * Reads only. Parsing and rendering live in `solve/repair-ledger.ts` beside the writer, so the two
 * cannot drift.
 *
 * **`OUTPUT_DIR` is relative, so this reads the page belonging to the directory you ran it in** —
 * run from a worktree it looks at a different and probably empty `groomed/`, which is why the
 * absolute path is printed on both paths.
 *
 * Exit 1 when there is no page: no evidence is a machine-readable answer, and not the same one as
 * a distribution.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { readLocalSettings, repairRound } from "../settings.ts";
import {
  REPAIR_LEDGER_FILE,
  parseLedger,
  renderNoPage,
  renderSummary,
} from "../solve/repair-ledger.ts";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length > 0) {
    process.stderr.write("usage: repair-ledger\n");
    process.exitCode = 2;
    return;
  }

  const settings = readLocalSettings();
  // Absolute, always: a reader must not take an answer about one checkout's `groomed/` as an
  // answer about another's.
  const path = resolve(join(settings.OUTPUT_DIR, REPAIR_LEDGER_FILE));
  const text = await readFile(path, "utf8").catch(() => null);

  if (text === null) {
    process.stderr.write(renderNoPage(path, repairRound(settings), process.env["REPAIR_ROUND"]));
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`${path}\n\n`);
  process.stdout.write(renderSummary(parseLedger(text)));
}

await main();
