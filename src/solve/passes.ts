/**
 * The real `PassRunner`: turns a solve pass into a process, scoped to the worktree
 * (never the repo) with no MCP servers and no Jira credential.
 *
 * A pass that dies is not retried — it may have left the worktree mid-write.
 */

import { childEnv } from "../triage/runner.ts";
import { runSession } from "../triage/session.ts";
import type { PassRunner } from "./orchestrator.ts";
import { buildSolveArgs, type Pass, type SolveRunOptions } from "./runner.ts";

export interface PassRunnerConfig {
  /** The Claude Code executable. Configuration, never a model-supplied value. */
  readonly executable: string;
  /** Silence budget for one pass; see `SessionOptions.idleMs`. */
  readonly idleMs: number;
  /** Awake-time ceiling on one pass; see `SessionOptions.maxRunMs`. */
  readonly maxRunMs: number;
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
          // Never repoPath: that would hand the pass the operator's checkout and sibling repos.
          workingDirectory: options.worktreePath,
          idleMs: config.idleMs,
          maxRunMs: config.maxRunMs,
          env: childEnv(parentEnv, options.vaultPath),
          // A solve pass reads the ticket as text, not from Jira, so it needs no MCP server.
          requiredMcpServers: [],
          label: labelFor(pass, options.issueKey),
        },
        parse,
      ),
  };
}
