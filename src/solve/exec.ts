/**
 * The real `CommandRunner`: the one place in this service that starts a process other than a
 * model session. Four properties: no shell (`spawn` without `shell`, so argv is argv and
 * nothing splits on whitespace or a `;`); an executable allowlist bounding which binary an
 * argument-injection bug could reach; a timeout that escalates `SIGTERM` to `SIGKILL` rather
 * than rejecting while the child still holds the worktree; and a constructed env built from
 * an allowlist, not `process.env`, so a credential added to `.env` next month is not
 * automatically inherited.
 * No retries: `verify.ts` distinguishes "the tests failed" from "we could not find out", and a
 * retry here would quietly turn the second into the first.
 */

import { spawn } from "node:child_process";

import { createLogger } from "../logger.ts";
import type { CommandOptions, CommandResult, CommandRunner } from "./worktree.ts";

const log = createLogger("exec");

/**
 * Programs this service may start. This list and `PACKAGE_MANAGERS` in `verify.ts` must not
 * drift apart, or a discovered manager this list refuses produces a confusing `refused`
 * verdict at execution instead of discovery.
 * Deliberately excluded: `sh`, `bash`, `env`, `xargs`, `make`, `node`, `npx`, `pnpx`, `dlx` —
 * each a way to run something else.
 * `corepack` is on the list despite also being a way to run something else: it shims only the
 * three managers already here, and `verify.ts`'s `PACKAGE_MANAGER_VERSION` admits plain semver
 * only, which stops a manifest turning it into a download-and-execute — that guard and this
 * entry must not drift apart either.
 * `mvn`, deliberately not `./mvnw`: the wrapper is a file inside the repository being
 * verified, so running it would let a solve run answer "which program verifies this change"
 * with the change itself.
 */
export const ALLOWED_EXECUTABLES: readonly string[] = [
  "git",
  "gh",
  "pnpm",
  "npm",
  "yarn",
  "corepack",
  "mvn",
];

/**
 * Environment variables passed through to children. `HOME` matters because git and gh read
 * their config from it; dropping it leaves `gh` unauthenticated and git with no user identity.
 * Deliberately absent: Jira/Vertex/Google credentials and `NODE_OPTIONS` (an arbitrary-code
 * channel into any node process the package manager starts).
 */
const ENV_PASSTHROUGH: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TERM",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "SSH_AUTH_SOCK",
  "GH_TOKEN",
  "GITHUB_TOKEN",
];

/** Cap on captured output, per stream — bounded here rather than at display, since buffering it all first means the bad case already happened. */
const MAX_CAPTURE = 200_000;

/** Grace between asking a child to stop and making it. */
const KILL_GRACE_MS = 2_000;

export function isAllowedExecutable(program: string): boolean {
  return ALLOWED_EXECUTABLES.includes(program);
}

/** Builds the child environment from the allowlist. Exported so "the child does not see the Jira token" can be asserted directly. */
export function childEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_PASSTHROUGH) {
    const value = parent[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  // Explicit, rather than relying on TTY-absence detection: some tools otherwise prompt interactively and hang forever with no stdin.
  env["CI"] = "1";
  env["NO_COLOR"] = "1";
  return env;
}

function truncate(text: string): string {
  return text.length <= MAX_CAPTURE
    ? text
    : `${text.slice(0, MAX_CAPTURE)}\n… truncated at ${String(MAX_CAPTURE)} characters`;
}

export interface RunnerOptions {
  readonly parentEnv?: NodeJS.ProcessEnv;
  /** Injected only by tests: lets a test observe that `shell` is never set and that the timeout escalates `SIGTERM` to `SIGKILL`, neither visible from outside a real process. */
  readonly spawnFn?: typeof spawn;
}

/**
 * Builds a runner. Never rejects for a non-zero exit — that is reported in `exitCode` — only
 * when the process could not start, or argv names a program this module refuses to run.
 */
export function createCommandRunner(options: RunnerOptions = {}): CommandRunner {
  const env = childEnv(options.parentEnv ?? process.env);
  const spawnFn = options.spawnFn ?? spawn;

  return {
    run: async (argv: readonly string[], runOptions: CommandOptions): Promise<CommandResult> => {
      const program = argv[0];
      if (program === undefined || !isAllowedExecutable(program)) {
        throw new Error(
          `refusing to run ${JSON.stringify(program ?? "")} — this service starts only ${ALLOWED_EXECUTABLES.join(", ")}`,
        );
      }

      return await new Promise<CommandResult>((resolve, reject) => {
        const child = spawnFn(program, argv.slice(1), {
          cwd: runOptions.cwd,
          // No `shell`. See the header. Do not add one.
          stdio: ["ignore", "pipe", "pipe"],
          env,
        });

        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;
        let hardKill: NodeJS.Timeout | null = null;

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          // A package manager mid-install often ignores SIGTERM; without this the next step would delete a directory out from under a live process.
          hardKill = setTimeout(() => {
            child.kill("SIGKILL");
          }, KILL_GRACE_MS);
          hardKill.unref();
        }, runOptions.timeoutMs);

        const settle = (fn: () => void): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          if (hardKill !== null) {
            clearTimeout(hardKill);
          }
          fn();
        };

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          if (stdout.length < MAX_CAPTURE) {
            stdout += chunk;
          }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          if (stderr.length < MAX_CAPTURE) {
            stderr += chunk;
          }
        });

        child.on("error", (error) => {
          settle(() => {
            reject(error);
          });
        });

        child.on("close", (code, signal) => {
          settle(() => {
            // A signalled death has no exit code; reporting 0 would read as success, so it maps to a non-zero value and `timedOut` carries the reason.
            const exitCode = code ?? (signal === null ? 1 : 128);
            log.debug("exec.finished", {
              program,
              exitCode,
              timedOut,
              cwd: runOptions.cwd,
            });
            resolve({
              exitCode,
              stdout: truncate(stdout),
              stderr: truncate(stderr),
              timedOut,
            });
          });
        });
      });
    },
  };
}
