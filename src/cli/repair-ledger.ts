/**
 * Reads `repair-rounds.md` back as a distribution, which is the question `PLAN.md` §45 decides on.
 *
 *   pnpm repair:ledger
 *
 * Reads only, writes nothing, and costs nothing. The page is appended to by every solve whose
 * verification failed while `REPAIR_ROUND` was on; this counts the records rather than leaving
 * someone to eyeball a growing markdown table, which is the counting mistake this repository keeps
 * making. The parsing and the rendering are in `solve/repair-ledger.ts`, beside the writer, so the
 * two cannot drift.
 *
 * **`OUTPUT_DIR` is relative, so this reads the page belonging to the directory you ran it in.**
 * That is the trap this command has to avoid rather than fall into: a solve writes its row under
 * the checkout it ran in, and `solve:once` needs credentials, so in practice the rows accumulate
 * wherever the operator's settings file is — the primary checkout. Run from a worktree, this looks
 * at a different and probably empty `groomed/`. So the absolute path is printed on both paths and
 * an absent page concludes nothing: an empty directory is not evidence that no round has run, and
 * this command cannot see the environment the solves ran in.
 *
 * Exit 1 when there is no page to read, because no evidence is a machine-readable answer and it is
 * not the same answer as a distribution.
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
  // Absolute, always: the whole failure this command has to avoid is a reader taking an answer
  // about one checkout's `groomed/` as an answer about another's.
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
