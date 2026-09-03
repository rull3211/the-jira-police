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
