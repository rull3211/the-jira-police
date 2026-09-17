/**
 * One headless storecode run: spawn it, read its event stream, return its structured output.
 *
 * Shared by the analyst and the poster so the parts easy to get subtly wrong — the line-buffered
 * NDJSON stream, the two budgets and watchdog, the MCP connectivity check, tool denials a run
 * reports while still calling itself a success, and a success exit with no structured output being
 * a failure — have one implementation, not two chances to get it wrong.
 */

import { spawn } from "node:child_process";

import { logger } from "../logger.ts";

/**
 * Tools withheld from every run this service starts, by name.
 *
 * `--allowedTools` is an auto-approve list, not an allowlist: naming a tool pre-approves it, and
 * omitting one restricts nothing — under `dontAsk`, everything is pre-approved regardless.
 * `--disallowedTools` is what actually restricts: the tool never appears in the model's tool list.
 * Keep both flags — the allowlist still suppresses prompts and documents intent, but must never be
 * described as the guard.
 */
export const DENIED_BUILTIN_TOOLS: readonly string[] = ["Bash", "Write", "Edit", "NotebookEdit"];

/**
 * How often the watchdog looks at the clock. Short next to any real budget: the gap between two
 * consecutive ticks is the only evidence the machine stopped existing for a while, and a long
 * interval cannot tell a twenty-minute suspend from a twenty-minute interval.
 */
const WATCHDOG_INTERVAL_MS = 15_000;

/**
 * The floor under the adaptive interval, so a tiny budget cannot turn the
 * watchdog into a busy loop.
 */
const MIN_WATCHDOG_INTERVAL_MS = 25;

/**
 * How often to look, given the budgets this run was handed. A fixed fifteen seconds is wrong for
 * any budget near it — enforcement can only be as fine as the tick — so this halves the smaller
 * budget to keep at least two looks inside it. Exported so tests with sub-second budgets don't
 * have to wait a quarter of a minute or mock the clock.
 */
export function watchdogIntervalFor(idleMs: number, maxRunMs: number): number {
  const half = Math.floor(Math.min(idleMs, maxRunMs) / 2);
  return Math.max(MIN_WATCHDOG_INTERVAL_MS, Math.min(WATCHDOG_INTERVAL_MS, half));
}

/**
 * Drift on a single tick above which the machine is taken to have slept. Far below the shortest
 * interesting suspend and far above anything the event loop does under load.
 */
const SLEEP_DRIFT_MS = 10_000;

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

/**
 * Which budget ran out. `idle` is a child that stopped talking: hung, wedged, or holding a dead
 * socket. `total` is a child that talked the whole way and simply took too long — the distinction
 * an operator needs to know whether to raise a limit or go looking for a bug.
 */
export type SessionTimeoutKind = "idle" | "total";

export class SessionTimeoutError extends SessionError {
  readonly kind: SessionTimeoutKind;
  readonly elapsedMs: number;
  /**
   * The killed run's storecode session, when the init event got far enough to name one. Carried
   * because a killed pass is not necessarily lost work: the transcript survives `SIGKILL`, and
   * `storecode --resume <id> -p "..."` reads it back intact. Nothing here resumes automatically —
   * that would be state on disk — but an operator holding this id can pick it up by hand.
   */
  readonly sessionId: string | null;

  constructor(
    label: string,
    kind: SessionTimeoutKind,
    elapsedMs: number,
    sessionId: string | null,
  ) {
    super(
      kind === "idle"
        ? `${label} produced no output for ${elapsedMs}ms`
        : `${label} ran for ${elapsedMs}ms of waking time`,
    );
    this.name = "SessionTimeoutError";
    this.kind = kind;
    this.elapsedMs = elapsedMs;
    this.sessionId = sessionId;
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
  /**
   * How long the child may go without producing a byte on either stream. A healthy headless run is
   * never silent — it emits an NDJSON event per turn and per tool call. Time spent asleep is
   * excluded; see the watchdog in `runSession`.
   */
  readonly idleMs: number;
  /**
   * The absolute ceiling on a single pass, counting only time the machine was awake. A second knob
   * rather than a longer `idleMs`, since a pass that streams an event every minute forever is alive
   * by every `idleMs` test but must still be stopped.
   */
  readonly maxRunMs: number;
  readonly env: NodeJS.ProcessEnv;
  readonly requiredMcpServers: readonly string[];
  /** Used in log lines and error messages, e.g. `Triage of SSX-1234`. */
  readonly label: string;
}

/**
 * Inspects an init event and throws if a required server is not connected. Worth checking
 * explicitly because the failure is otherwise silent: with the Atlassian session expired the run
 * still exits 0, having simply reported that it could not read the issue.
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
 * What one run cost, as far as the result event is willing to say. Every field is `number | null`,
 * and the null is load-bearing: absent is not zero, since collapsing "not reported" to `0` would
 * quietly understate a summed total. Extraction is total — it cannot throw, since a malformed usage
 * block must not turn a successful solve into a failed one.
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
 * A finite number, or nothing. `Number.isFinite` rather than `typeof === "number"`, since `NaN` is
 * a number and would propagate through any sum, turning one malformed run into a whole day's total
 * reading `NaN`. Strings are not coerced — a cost arriving as `"0.12"` means the shape changed.
 */
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Pulls the cost fields out of a `result` event. Exported for testing against recorded events, in
 * the same spirit as `assertMcpReady` — the alternative is spending real money per assertion.
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
 * A tool call the environment refused: the name and nothing else. The result event's
 * `permission_denials` entries also carry the whole `tool_input`, and dropping it is deliberate —
 * carrying it could copy the exact bytes of a refused write into a log this service keeps.
 */
export interface SessionDenial {
  readonly tool: string;
}

/**
 * Every tool call the run reports as refused — a gate `DENIED_BUILTIN_TOOLS` cannot see, since a
 * `PreToolUse` hook fires ahead of permission resolution and vetoes per call regardless of
 * permission mode.
 *
 * Read from `permission_denials` on the `result` event, not the mid-stream message, since the
 * `result` event is the one place the whole set is complete with nothing to correlate across events.
 *
 * The run still says `subtype: "success"` and `is_error: false` even when a tool was vetoed, so
 * the existing success check alone sees nothing wrong.
 *
 * Deliberately does not attribute a denial to a hook versus a deny rule versus don't-ask mode, all
 * of which land in the same array tagged `"permission-rule"` — guessing from free text would
 * undercount.
 *
 * A hook that allows a call but alters its effect leaves no structural signal anywhere in the
 * stream, since both denial-bearing fields are gated on the call not executing at all.
 *
 * Nothing consumes this yet beyond the log line: a denial is material but not automatically
 * fatal, since a run can be denied a tool, work around it, and still complete correctly.
 * Extraction is total, like `sessionCost`, since a malformed array must not turn a working solve
 * into a failed one.
 */
export function sessionDenials(event: Record<string, unknown>): readonly SessionDenial[] {
  const denials = event["permission_denials"];
  if (!Array.isArray(denials)) {
    return [];
  }
  return denials.flatMap((entry: unknown) => {
    const tool = (entry as Record<string, unknown> | null | undefined)?.["tool_name"];
    return typeof tool === "string" && tool !== "" ? [{ tool }] : [];
  });
}

/**
 * Runs the child and hands its `structured_output` to `parse`. A throw from `parse` — how the
 * analyst refuses an incoherent verdict — is preserved as the run's failure rather than wrapped.
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
    let sessionId: string | null = null;

    const startedAt = Date.now();
    let lastActivityAt = startedAt;
    let lastTickAt = startedAt;
    let sleptMs = 0;

    const finish = (error: Error | null, value?: { readonly value: T }): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(watchdog);
      if (error !== null) {
        reject(error);
      } else if (value !== undefined) {
        resolve(value.value);
      }
    };

    const killTimedOut = (kind: SessionTimeoutKind, elapsedMs: number): void => {
      child.kill("SIGKILL");
      finish(new SessionTimeoutError(options.label, kind, elapsedMs, sessionId));
    };

    /**
     * The watchdog is also the sleep detector: a suspended machine and a genuinely idle one look
     * identical from inside the process, so drift is charged to the sleep budget rather than the
     * silence budget. Sleep is inferred from drift rather than a clock API, since it does not
     * matter whether the platform's monotonic clock ticks through a suspend — either way this
     * fires with the same large wall gap. The threshold's failure directions are asymmetric on
     * purpose: a false positive credits a pass extra time, a false negative kills a frozen pass;
     * only the second one costs money.
     */
    const tickMs = watchdogIntervalFor(options.idleMs, options.maxRunMs);
    const watchdog = setInterval(() => {
      const now = Date.now();
      const drift = now - lastTickAt - tickMs;
      lastTickAt = now;

      if (drift >= SLEEP_DRIFT_MS) {
        sleptMs += drift;
        // The child was frozen, not quiet; charging this gap to the silence budget would be wrong.
        lastActivityAt += drift;
        logger.warn("session.slept", {
          label: options.label,
          sleptMs: drift,
          totalSleptMs: sleptMs,
          sessionId,
        });
        // No kill check on the tick that found the sleep: the child has just regained a socket
        // that died while the machine was away and needs a moment to reconnect.
        return;
      }

      const idleFor = now - lastActivityAt;
      if (idleFor >= options.idleMs) {
        killTimedOut("idle", idleFor);
        return;
      }

      const ranFor = now - startedAt - sleptMs;
      if (ranFor >= options.maxRunMs) {
        killTimedOut("total", ranFor);
      }
    }, tickMs);

    const handleEvent = (event: Record<string, unknown>): void => {
      if (event["type"] === "system" && event["subtype"] === "init") {
        const id = event["session_id"];
        if (typeof id === "string" && id !== "") {
          sessionId = id;
          // Logged rather than stored: the only handle to resume a killed pass by hand, and it
          // exists nowhere else once the child is gone.
          logger.info("session.started", { label: options.label, sessionId });
        }
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
        // Before the success check, deliberately: a failed or timed-out run has already been
        // paid for and would otherwise never be counted.
        logger.info("session.cost", { label: options.label, ...sessionCost(event) });

        // Also before the success check: a run stopped by a hook still reports `success`, so
        // these denials are the ones most worth having. `warn` rather than `info` since this
        // means the harness's own model of the session's tool surface was wrong for this run.
        const denials = sessionDenials(event);
        if (denials.length > 0) {
          logger.warn("session.denied", {
            label: options.label,
            count: denials.length,
            // Deduplicated for reading, counted above for arithmetic.
            tools: [...new Set(denials.map((denial) => denial.tool))].toSorted(),
            sessionId,
          });
        }

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
      // Before the parse: an unreadable line still proves the child is alive, which is what the
      // silence budget tracks.
      lastActivityAt = Date.now();
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
      lastActivityAt = Date.now();
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
