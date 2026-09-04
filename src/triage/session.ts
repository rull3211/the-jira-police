/**
 * One headless storecode run: spawn it, read its event stream, return its
 * structured output.
 *
 * Extracted because there are now two kinds of run — the analyst that decides
 * and the poster that writes — and they need identical handling of the parts
 * that are easy to get subtly wrong: the line-buffered NDJSON stream, the
 * timeout that must kill the child rather than merely reject, the MCP
 * connectivity check, and the rule that a run which exits 0 without structured
 * output is a failure rather than an empty success.
 *
 * Duplicating that between two files would mean two chances to fix a bug in
 * one place only. Everything specific to *what* is being run lives in the
 * caller; this module only knows how to run it.
 */

import { spawn } from "node:child_process";

import { logger } from "../logger.ts";

/**
 * Tools withheld from every run this service starts, by name.
 *
 * This exists because `--allowedTools` does not do what three comments in
 * `runner.ts` and one in `poster.ts` said it did. Probed against the local arg
 * parser 2026-09-04, four ways:
 *
 *   --permission-mode dontAsk --allowedTools "Bash(git status:*)"  → both a
 *       scoped and an unscoped git command ran
 *   --permission-mode dontAsk --allowedTools "Read"                → Bash ran
 *   --allowedTools "Read" (no permission-mode at all)              → Bash ran
 *   the same, from /tmp rather than this repo                      → Bash ran
 *
 * So `--allowedTools` is an auto-approve list, not an allowlist: naming a tool
 * pre-approves it, and omitting a tool restricts nothing. Under `dontAsk`
 * everything is pre-approved regardless, which is the mode this service uses.
 * Every triage run it has ever made had `Bash`, `Write` and `Edit` available.
 *
 * `--disallowedTools` is the mechanism that actually restricts, and it does it
 * in the strongest available form — the tool never appears in the model's tool
 * list, so there is no call to permit or deny. A run given
 * `--disallowedTools "Bash,Write,Edit"` reported `bash=NO write=NO read=YES`,
 * which also confirms the comma-separated form parses.
 *
 * Keep both flags. The allowlist still suppresses prompts and still documents
 * intent; it simply is not the guard, and must never again be described as one.
 */
export const DENIED_BUILTIN_TOOLS: readonly string[] = ["Bash", "Write", "Edit", "NotebookEdit"];

export class SessionError extends Error {}

/** An MCP server the run depends on was not connected. */
export class McpUnavailableError extends SessionError {
  readonly server: string;
  readonly status: string;

  constructor(server: string, status: string) {
    super(
      `MCP server "${server}" reported status "${status}" — the run would have produced a verdict without reading the issue.`,
    );
    this.name = "McpUnavailableError";
    this.server = server;
    this.status = status;
  }
}

export class SessionTimeoutError extends SessionError {
  constructor(label: string, timeoutMs: number) {
    super(`${label} exceeded ${timeoutMs}ms`);
    this.name = "SessionTimeoutError";
  }
}

export interface McpServerStatus {
  readonly name: string;
  readonly status: string;
}

export interface SessionOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly workingDirectory: string;
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
  readonly requiredMcpServers: readonly string[];
  /** Used in log lines and error messages, e.g. `Triage of SSX-1234`. */
  readonly label: string;
}

/**
 * Inspects an init event and throws if a required server is not connected.
 *
 * Exported so this can be unit-tested against recorded events without spawning
 * a real run. Worth checking explicitly because the failure is otherwise
 * silent: with the Atlassian session expired the run still exits 0, having
 * simply reported that it could not read the issue.
 */
export function assertMcpReady(
  servers: readonly McpServerStatus[],
  requiredServers: readonly string[],
): void {
  for (const required of requiredServers) {
    const found = servers.find((server) => server.name === required);
    const status = found?.status ?? "absent";
    if (status !== "connected") {
      throw new McpUnavailableError(required, status);
    }
  }
}

/**
 * What one run cost, as far as the result event is willing to say.
 *
 * Every field is `number | null`, and the null is load-bearing: **absent is not
 * zero.** A run that did not report a cost and a run that was free are
 * different facts, and collapsing them to `0` would quietly understate a total
 * that someone is going to sum over a day of solves.
 *
 * Extraction is total — it cannot throw. This is telemetry attached to a run
 * whose verdict has already been decided, and a malformed usage block must not
 * be able to turn a successful solve into a failed one. Anything that is not a
 * finite number reads as "not reported".
 */
export interface SessionCost {
  readonly costUsd: number | null;
  readonly durationMs: number | null;
  readonly turns: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Cache reads are the cheap ones; cache *writes* are where the money goes. */
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
}

/**
 * A finite number, or nothing.
 *
 * `Number.isFinite` rather than `typeof === "number"` because `NaN` is a
 * number and would propagate through any sum it touched, turning one
 * malformed run into a whole day's total reading `NaN`. Strings are not
 * coerced: a cost arriving as `"0.12"` means the shape changed, and guessing
 * would hide that.
 */
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Pulls the cost fields out of a `result` event.
 *
 * Exported for testing against recorded events, in the same spirit as
 * `assertMcpReady` — the alternative is spending real money per assertion.
 *
 * Confirmed present under Vertex 2026-09-04: a `storecode -p "say ok"` run
 * reported `total_cost_usd: 0.127` on 20,351 cache-creation tokens. Worth
 * writing down, because it means the per-run floor is roughly a tenth of a
 * dollar before the model does anything at all, and a solve is four sessions.
 */
export function sessionCost(event: Record<string, unknown>): SessionCost {
  const usage = event["usage"];
  const tokens: Record<string, unknown> =
    typeof usage === "object" && usage !== null ? (usage as Record<string, unknown>) : {};

  return {
    costUsd: finiteNumber(event["total_cost_usd"]),
    durationMs: finiteNumber(event["duration_ms"]),
    turns: finiteNumber(event["num_turns"]),
    inputTokens: finiteNumber(tokens["input_tokens"]),
    outputTokens: finiteNumber(tokens["output_tokens"]),
    cacheReadTokens: finiteNumber(tokens["cache_read_input_tokens"]),
    cacheWriteTokens: finiteNumber(tokens["cache_creation_input_tokens"]),
  };
}

/**
 * Runs the child and hands its `structured_output` to `parse`.
 *
 * `parse` may throw to reject the run — that is how the analyst refuses an
 * incoherent verdict. A throw from there is preserved as the run's failure
 * rather than being wrapped, so the caller sees the specific error it raised.
 */
export async function runSession<T>(
  options: SessionOptions,
  parse: (structuredOutput: unknown) => T,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const child = spawn(options.executable, [...options.args], {
      cwd: options.workingDirectory,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env,
    });

    let settled = false;
    let buffered = "";
    let stderr = "";
    let parsed: { readonly value: T } | null = null;
    let failure: Error | null = null;

    const finish = (error: Error | null, value?: { readonly value: T }): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error !== null) {
        reject(error);
      } else if (value !== undefined) {
        resolve(value.value);
      }
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new SessionTimeoutError(options.label, options.timeoutMs));
    }, options.timeoutMs);

    const handleEvent = (event: Record<string, unknown>): void => {
      if (event["type"] === "system" && event["subtype"] === "init") {
        const servers = Array.isArray(event["mcp_servers"])
          ? (event["mcp_servers"] as McpServerStatus[])
          : [];
        try {
          assertMcpReady(servers, options.requiredMcpServers);
        } catch (error) {
          failure = error as Error;
          // No point letting the run continue; it cannot reach Jira.
          child.kill("SIGTERM");
        }
        return;
      }

      if (event["type"] === "result") {
        // Before the success check, deliberately. A run that failed, refused or
        // timed out has already been paid for, and those are exactly the runs
        // whose cost would otherwise never be counted — which would make the
        // per-ticket total look best on the days it went worst.
        logger.info("session.cost", { label: options.label, ...sessionCost(event) });

        if (event["subtype"] !== "success" || event["is_error"] === true) {
          failure ??= new SessionError(`${options.label} failed: ${String(event["subtype"])}`);
          return;
        }
        try {
          parsed = { value: parse(event["structured_output"]) };
        } catch (error) {
          failure ??= error as Error;
        }
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") {
          continue;
        }
        try {
          handleEvent(JSON.parse(trimmed) as Record<string, unknown>);
        } catch {
          logger.debug("session.unparsed_line", { line: trimmed.slice(0, 200) });
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      finish(error);
    });

    child.on("close", (code) => {
      if (failure !== null) {
        finish(failure);
        return;
      }
      if (parsed === null) {
        finish(
          new SessionError(
            `${options.label} exited ${String(code)} without structured output. stderr: ${stderr.slice(0, 500)}`,
          ),
        );
        return;
      }
      finish(null, parsed);
    });
  });
}
