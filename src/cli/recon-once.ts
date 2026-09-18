/**
 * Runs recon alone against one real ticket: no fix, no diff, no pull request.
 *
 *   node src/cli/recon-once.ts SSX-1234
 *
 * The only way to run recon without also granting `solve-once.ts`'s
 * write-capable rungs: any other path to exercising recon means starting a
 * run that happens to bail early. This fetches one real ticket, cuts a real
 * worktree from `SOLVE_REPO_ROOT`, runs recon in it, and always discards the
 * worktree afterwards — recon holds no `Write` and no `Edit`, so there is
 * nothing in there to keep, the same reasoning `orchestrator.ts`'s own
 * recon-bail cleanup gives.
 *
 * `--claim`, `--pr` and every other write rung `solve-once.ts` has are absent
 * on purpose: this command's whole job is to be safe to run against a ticket
 * nobody has decided is solvable yet.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { logger } from "../logger.ts";
import { readSettings, withConfigErrors, type Settings } from "../settings.ts";
import { runReconOnly, type ReconOnlyOutcome, type SolveRequest } from "../solve/orchestrator.ts";
import {
  NotSolvableError,
  attachReconImages,
  buildSolveRequest,
  createJiraClient,
  createSolveRunDeps,
  createTicketReader,
} from "../wiring.ts";
import type { IssueDetail } from "../jira/client.ts";
import { exitCodeFor, formatReport } from "./recon-once-report.ts";

/**
 * The solve request, or `null` after saying why there is not one.
 *
 * Split out so the refusal path is testable without a real Jira client.
 * Mirrors `requestOrRefusal` in `solve-run.ts`, which this command does not
 * import — that one is private, and carries a `rung` parameter this command
 * has only one value for.
 */
export function requestOrRefusal(
  settings: Settings,
  detail: IssueDetail,
  ticket: string,
): SolveRequest | null {
  try {
    return buildSolveRequest(settings, detail, ticket);
  } catch (error) {
    if (error instanceof NotSolvableError) {
      process.stderr.write(`refusing recon:once: ${error.message}\n`);
      process.exitCode = 3;
      return null;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const issueKey = process.argv[2];
  if (issueKey === undefined || issueKey.startsWith("-")) {
    process.stderr.write("usage: recon-once <ISSUE-KEY>\n");
    process.exitCode = 2;
    return;
  }

  const settings = readSettings();
  const client = createJiraClient(settings);
  const read = createTicketReader(client);
  const { text, detail } = await read(issueKey);

  const request = requestOrRefusal(settings, detail, text);
  if (request === null) {
    return;
  }

  process.stdout.write(`Repository: ${request.repoPath} @ ${request.baseRef}\n\n`);

  const staged = await attachReconImages(settings, client, request);
  let outcome: ReconOnlyOutcome;
  try {
    outcome = await runReconOnly(createSolveRunDeps(settings), staged.request);
  } finally {
    await staged.cleanup();
  }
  process.stdout.write(`outcome: ${outcome.kind}\n`);

  await mkdir(settings.OUTPUT_DIR, { recursive: true });
  const reportPath = join(settings.OUTPUT_DIR, `${detail.key}.recon.md`);
  await writeFile(reportPath, formatReport(detail.key, outcome, new Date()), "utf8");
  process.stdout.write(`report: ${reportPath}\n`);

  logger.info("recon-once.done", { issueKey, outcome: outcome.kind });
  process.exitCode = exitCodeFor(outcome);
}

await withConfigErrors(main);
