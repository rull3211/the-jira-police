/**
 * The real `PassRunner`: the one place a solve pass becomes a process.
 *
 * `orchestrator.ts` decides *which* pass runs and *when*; this decides what it
 * runs *as*. Kept apart so the whole pipeline is testable without a model, and
 * so the privilege grant — working directory, environment, arguments — sits in
 * one short file a reviewer can read end to end.
 *
 * ## Three properties, all of them about containment
 *
 * 1. **The working directory is the worktree, never the repository.** The
 *    session's `Read`, `Grep` and `Glob` are rooted there, so "it can only see
 *    the copy" is a consequence of this line rather than of anything the model
 *    is asked to observe. Passing `repoPath` here would quietly hand every
 *    pass the operator's dirty checkout and the other five repositories beside
 *    it.
 *
 * 2. **The Jira credential does not travel.** `childEnv` is triage's, reused
 *    rather than reimplemented: the standing rule is that the REST credential
 *    is for discovering tickets and nothing else, and a rule enforced by two
 *    separate copies of the same filter is a rule with two chances to drift.
 *
 * 3. **No MCP server is required, and that is deliberate.** A solve pass reads
 *    the ticket as text handed to it, not from Jira, so it has no reason to
 *    hold a connection to anything it could also write through. `runTriage`
 *    passes `requiredMcpServers` because triage genuinely reads the issue;
 *    here the empty list is the point, not an omission.
 *
 * ## No retries, again
 *
 * A pass that dies is not re-run. Same argument as `exec.ts`: the pipeline
 * distinguishes "this did not work" from "we could not find out", and a silent
 * second attempt turns the second into the first. A `fix` pass in particular
 * may have written files before it died, so re-running it would not be a
 * retry — it would be a second pass over a worktree in an unknown state.
 */

import { childEnv } from "../triage/runner.ts";
import { runSession } from "../triage/session.ts";
import type { PassRunner } from "./orchestrator.ts";
import { buildSolveArgs, type Pass, type SolveRunOptions } from "./runner.ts";

export interface PassRunnerConfig {
  /** The Claude Code executable. Configuration, never a model-supplied value. */
  readonly executable: string;
  /** Wall-clock bound on one pass. */
  readonly timeoutMs: number;
  readonly parentEnv?: NodeJS.ProcessEnv;
}

/** Human-readable, and the only thing that distinguishes runs in the log. */
export function labelFor(pass: Pass, issueKey: string): string {
  return `${pass} pass of ${issueKey}`;
}

export function createPassRunner(config: PassRunnerConfig): PassRunner {
  const parentEnv = config.parentEnv ?? process.env;

  return {
    run: async <T>(
      pass: Pass,
      options: SolveRunOptions,
      parse: (structuredOutput: unknown) => T,
    ): Promise<T> =>
      runSession(
        {
          executable: config.executable,
          args: buildSolveArgs(pass, options),
          // The worktree. See property 1 above.
          workingDirectory: options.worktreePath,
          timeoutMs: config.timeoutMs,
          env: childEnv(parentEnv, options.vaultPath),
          // Empty on purpose. See property 3 above.
          requiredMcpServers: [],
          label: labelFor(pass, options.issueKey),
        },
        parse,
      ),
  };
}
