/**
 * One headless storecode run: spawn it, read its event stream, return its
 * structured output.
 *
 * Extracted because there are now two kinds of run — the analyst that decides
 * and the poster that writes — and they need identical handling of the parts
 * that are easy to get subtly wrong: the line-buffered NDJSON stream, the two
 * budgets and the watchdog that must kill the child rather than merely reject,
 * the MCP connectivity check, and the rule that a run which exits 0 without
 * structured output is a failure rather than an empty success.
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

/**
 * How often the watchdog looks at the clock.
 *
 * Short next to any real budget, because it is not only a poll: the gap
 * between two consecutive ticks is the entire evidence that the machine
 * stopped existing for a while. A long interval cannot tell a twenty-minute
 * suspend from a twenty-minute interval, so this has to be much smaller than
 * the shortest sleep worth detecting.
 */
const WATCHDOG_INTERVAL_MS = 15_000;

/**
 * The floor under the adaptive interval, so a tiny budget cannot turn the
 * watchdog into a busy loop.
 */
const MIN_WATCHDOG_INTERVAL_MS = 25;

/**
 * How often to look, given the budgets this run was handed.
 *
 * A fixed fifteen seconds is right for the shipped budgets and wrong for any
 * budget near it: enforcement can only be as fine as the tick, so a
 * ten-second limit checked every fifteen seconds is a fifteen-second limit
 * wearing the wrong number. Halving the smaller budget keeps at least two
 * looks inside it, which is the weakest claim worth making.
 *
 * Exported for the tests, which need budgets in the hundreds of milliseconds
 * and would otherwise have to wait a quarter of a minute per assertion or mock
 * the clock the watchdog is the only thing reading.
 */
export function watchdogIntervalFor(idleMs: number, maxRunMs: number): number {
  const half = Math.floor(Math.min(idleMs, maxRunMs) / 2);
  return Math.max(MIN_WATCHDOG_INTERVAL_MS, Math.min(WATCHDOG_INTERVAL_MS, half));
}

/**
 * Drift on a single tick above which the machine is taken to have slept.
 *
 * Ten seconds of overshoot in a process that does nothing but parse NDJSON
 * lines is not scheduling noise. It is deliberately far below the shortest
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
 * Which budget ran out, because they mean opposite things about the run.
 *
 * `idle` is a child that stopped talking: hung, wedged, or holding a socket
 * that died under it. `total` is a child that talked the whole way and simply
 * took too long. Collapsing them loses the only distinction that tells an
 * operator whether to raise a limit or go looking for a bug.
 */
export type SessionTimeoutKind = "idle" | "total";

export class SessionTimeoutError extends SessionError {
  readonly kind: SessionTimeoutKind;
  readonly elapsedMs: number;
  /**
   * The killed run's storecode session, when the init event got far enough to
   * name one.
   *
   * Carried because a killed pass is not necessarily lost work. Probed
   * 2026-09-06: the transcript is written as the run goes, survives `SIGKILL`,
   * and `storecode --resume <id> -p "..."` reads it back with the completed
   * turns and their tool results intact. Nothing in this service resumes
   * automatically — that would be state on disk, which the queue design
   * refuses — but an operator holding this id can pick the pass back up by
   * hand, and a null here means they cannot.
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
   * How long the child may go without producing a byte on either stream.
   *
   * This is the budget that does the work, and it replaced a wall-clock
   * deadline set once at spawn. That deadline could not tell a pass working
   * hard for thirty minutes from one wedged for thirty seconds, so it was
   * sized for the former and therefore caught neither.
   *
   * Silence is the signal because a healthy headless run is never silent: it
   * emits an NDJSON event per turn and per tool call. Time spent asleep is
   * excluded — see the watchdog in `runSession`.
   */
  readonly idleMs: number;
  /**
   * The absolute ceiling on a single pass, counting only time the machine was
   * awake.
   *
   * Deliberately a second knob rather than a longer `idleMs`, and for the same
   * reason `MAX_PR_ROUNDS_TOTAL` is not `MAX_REVIEW_ITERATIONS`: one is a
   * policy about how long this kind of work is worth, the other is a brake on
   * the machinery, and relaxing the first must not be able to disable the
   * second. A pass that streams an event every minute forever is alive by
   * every test `idleMs` can apply, and this is what stops it.
   */
  readonly maxRunMs: number;
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
     * The watchdog, which is also the sleep detector, because on this machine
     * they are the same measurement.
     *
     * A suspended laptop was the failure that motivated this: the old deadline
     * was a single `setTimeout` armed at spawn, so a machine that slept for
     * twenty-five of a thirty-minute budget spent it without the pass running,
     * and killed a recon on SSX-3831 that had done nothing wrong.
     *
     * Sleep is inferred from drift rather than from any clock API, and that is
     * on purpose: it does not matter whether the platform's monotonic clock
     * ticks through a suspend. If it pauses, this fires one interval after
     * wake with a large wall gap; if it counts, it fires immediately on wake
     * with the same large wall gap. Both are the same observation, so the
     * detector is correct either way and does not have to be right about which
     * platform it is on.
     *
     * The threshold's failure directions are asymmetric and chosen for it. A
     * false positive — an event loop genuinely blocked for that long, in a
     * process whose only job is parsing NDJSON lines — credits a pass some
     * extra time. A false negative kills a pass that was frozen rather than
     * stuck. Only the second one costs money.
     */
    const tickMs = watchdogIntervalFor(options.idleMs, options.maxRunMs);
    const watchdog = setInterval(() => {
      const now = Date.now();
      const drift = now - lastTickAt - tickMs;
      lastTickAt = now;

      if (drift >= SLEEP_DRIFT_MS) {
        sleptMs += drift;
        // The child was frozen, not quiet. Charging this gap to the silence
        // budget is exactly the bug being fixed, one layer down.
        lastActivityAt += drift;
        logger.warn("session.slept", {
          label: options.label,
          sleptMs: drift,
          totalSleptMs: sleptMs,
          sessionId,
        });
        // No kill check on the tick that found the sleep, deliberately. The
        // child has just been handed back a socket that died while the machine
        // was away, and it needs a moment to notice and reconnect. Judging it
        // in the same breath as waking it would kill the healthy case for
        // being slow to recover from something that was not its fault.
        //
        // This is a grace period rather than a guard, and it has no mutation
        // test, which is a statement about it rather than a gap. Deleting the
        // `return` changes nothing in any reachable case: the credit above has
        // already moved both budgets, so a pass that was inside them before the
        // sleep is still inside them on this tick. What it buys is one interval
        // for the pathological case — a pass that was a hair from its silence
        // budget at the moment the lid closed — and one interval is not a
        // difference a test can assert without pinning the scheduler.
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
          // Logged rather than stored. It is the only handle by which a killed
          // pass can be resumed by hand, and it exists nowhere else once the
          // child is gone.
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
      // Before the parse, not after. A line this module cannot read is still
      // proof the child is alive, and the silence budget is asking about the
      // child rather than about the schema.
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
