/**
 * Reports, and with `--write` removes, stale skill roots and staged-image
 * directories a hard kill left behind.
 *
 *   pnpm sweep:once
 *   pnpm sweep:once --write
 *
 * Dry by default, matching `triage:once`'s shape. This walks both parent
 * directories `worktreeRoot` and `attachStagingRoot` create (`wiring.ts`),
 * reports every entry `staging-sweep.ts` recognises and its age, and removes
 * only the ones at least `STAGING_SWEEP_MAX_AGE_MS` old — and only with
 * `--write`. The walk and the removal live in `sweep.ts`; this file is argv
 * parsing, settings, and the report.
 *
 * **What this never touches.** A live git worktree sits in the same parent
 * directory `worktreeRoot` returns, at the bare path `<root>/<issueKey>`, and
 * `staging-sweep.ts`'s classifier cannot match it — see that module's own
 * comment for the argument from `ISSUE_KEY`. Anything this command does not
 * recognise, including a bare worktree, a salvaged one, or a directory
 * nobody here created, is left alone and left unreported: it is not this
 * sweep's to explain, and reporting it would invite deleting it by hand on
 * the strength of an age this command printed.
 *
 * Not wired into the daemon. `index.ts` and `review-loop.ts` never call
 * this — the sweep this closes is deliberately a command a person runs, the
 * same phasing choice that has kept `attach:stage` off every automatic path.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { logger } from "../logger.ts";
import { numeric, readSettings, withConfigErrors } from "../settings.ts";
import { runSweep } from "../sweep.ts";
import { attachStagingRoot, worktreeRoot } from "../wiring.ts";
import { formatReport } from "./sweep-once-report.ts";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.some((arg) => arg !== "--write")) {
    process.stderr.write("usage: sweep-once [--write]\n");
    process.exitCode = 2;
    return;
  }
  const write = argv.includes("--write");

  const settings = readSettings();
  const maxAgeMs = numeric(settings, "STAGING_SWEEP_MAX_AGE_MS", 1);
  const now = Date.now();

  const { groups, removed } = await runSweep(
    [worktreeRoot(settings), attachStagingRoot()],
    now,
    maxAgeMs,
    write,
  );

  const reportText = formatReport(groups, write, new Date(now));
  process.stdout.write(reportText);

  await mkdir(settings.OUTPUT_DIR, { recursive: true });
  const reportPath = join(settings.OUTPUT_DIR, "sweep.md");
  await writeFile(reportPath, reportText, "utf8");
  process.stdout.write(`\nreport: ${reportPath}\n`);

  logger.info("sweep-once.done", { write, removed, maxAgeMs });
}

await withConfigErrors(main);
