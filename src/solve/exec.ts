/**
 * The real `CommandRunner`: the one place in this service that starts a
 * process other than a model session.
 *
 * Everything in `src/solve/` up to now took a `CommandRunner` and was tested
 * against a fake, which is why those modules could be written and committed
 * without granting anything. This file is the grant. It is deliberately its own
 * commit and deliberately small — if a reviewer reads one file in Phase C, it
 * should be this one, and it should be short enough to read.
 *
 * ## Four properties, in the order they matter
 *
 * **1. No shell.** `spawn` is called without `shell`, so argv is argv. Node
 * passes the array to `execvp` and nothing between here and the kernel splits
 * on whitespace, expands a glob, or notices a `;`. Every caller already builds
 * argv arrays for this reason; this is the end of that chain, and setting
 * `shell: true` here would silently undo the care taken in all of them.
 *
 * **2. An executable allowlist.** `argv[0]` must be one of a handful of names.
 * This is not defence against the callers in this repository — they are all
 * literal — but against the shape of the system: a solve run takes
 * attacker-controlled text (a Jira ticket), passes it through a model, and the
 * result eventually influences arguments. Bounding *which binary runs* means
 * the worst case of an argument-injection bug is a malformed `git` command
 * rather than an arbitrary one. Notably the allowlist has no `sh`, no `env`,
 * no `xargs`, and no `node`.
 *
 * **3. A timeout that actually kills.** `SIGTERM`, then `SIGKILL` if the child
 * is still there. A promise that rejects while the child keeps running is
 * worse than no timeout, because the caller believes the step is over and the
 * process is still holding the worktree.
 *
 * **4. A scrubbed environment.** The child gets a constructed env, not
 * `process.env`. This service holds a Jira REST credential and Vertex
 * configuration; `pnpm test` in somebody else's repository has no business
 * being able to read either. Building the env up from an allowlist rather than
 * deleting known-bad keys means a credential added to `.env` next month is not
 * automatically inherited.
 *
 * ## What this does not do
 *
 * No retries. A failed command is a fact the caller must decide about, and
 * `verify.ts` in particular distinguishes "the tests failed" from "we could not
 * find out" — a retry here would quietly turn the second into the first.
 */

import { spawn } from "node:child_process";

import { logger } from "../logger.ts";
import type { CommandOptions, CommandResult, CommandRunner } from "./worktree.ts";

/**
 * Programs this service may start.
 *
 * `git` and `gh` are the delivery path. The three package managers are
 * whatever `verify.ts` discovered from the pristine manifest — and note that
 * this list and `PACKAGE_MANAGERS` there must not drift apart: discovering a
 * manager this list refuses would produce a `refused` verdict at the point of
 * execution rather than at discovery, which is a confusing place to learn it.
 *
 * Not on the list, and worth naming so nobody adds them absent-mindedly: `sh`,
 * `bash`, `env`, `xargs`, `make`, `node`, `npx`, `pnpx`, `dlx`. Each is a way
 * to run something else, which is precisely what an allowlist of programs is
 * for.
 *
 * **`corepack` is on the list and is also a way to run something else**, so it
 * is the one entry that contradicts the paragraph above and has to earn its
 * place. Two things distinguish it from `npx`. It shims exactly the three
 * managers already on this list and cannot be asked for a fourth, so the set of
 * programs reachable through it is the set reachable without it. And the
 * argument it takes is validated before it is built: `PACKAGE_MANAGER_VERSION`
 * in `verify.ts` admits plain semver only, which is what stops
 * `packageManager: "pnpm@https://…/x.tgz"` — a perfectly valid thing to say to
 * corepack — from turning a manifest into a download-and-execute. That guard is
 * load-bearing for this list entry, so the two must not drift apart either.
 */
export const ALLOWED_EXECUTABLES: readonly string[] = [
  "git",
  "gh",
  "pnpm",
  "npm",
  "yarn",
  "corepack",
];

/**
 * Environment variables passed through to children.
 *
 * `PATH` because the allowlist is names, not paths. `HOME` because git and gh
 * read their config from it — dropping it makes `gh` unauthenticated and every
 * `git` command run with no user identity, which fails in a way that looks
 * like a bug in this service. The rest are the minimum a package manager and a
 * test runner need not to misbehave.
 *
 * Deliberately absent: everything to do with Jira, Vertex, Google credentials,
 * and `NODE_OPTIONS` — the last because it is an arbitrary-code channel into
 * any node process the package manager starts.
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

/**
 * Cap on captured output, per stream.
 *
 * A failing test suite can print tens of megabytes. This is read into a string
 * to be put in a report, so it is bounded here rather than at the point it is
 * displayed — buffering it all first and truncating later means the bad case
 * has already happened.
 */
const MAX_CAPTURE = 200_000;

/** Grace between asking a child to stop and making it. */
const KILL_GRACE_MS = 2_000;

export function isAllowedExecutable(program: string): boolean {
  return ALLOWED_EXECUTABLES.includes(program);
}

/**
 * Builds the child environment from the allowlist.
 *
 * Exported for testing, because "the child does not see the Jira token" is the
 * kind of claim that should be asserted rather than asserted about.
 */
export function childEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_PASSTHROUGH) {
    const value = parent[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  // Package managers and test runners behave differently under a TTY: progress
  // spinners, colour codes, and in some cases an interactive prompt that would
  // hang forever with no stdin. Saying so explicitly is more reliable than
  // hoping the absence of a TTY is detected.
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
  /**
   * Injected only by tests.
   *
   * Two of the properties this module exists for cannot be observed from
   * outside a real process: that `shell` is never set, and that the timeout
   * escalates `SIGTERM` to `SIGKILL`. Both are visible here. A real-process
   * test can tell you a command ran; only this can tell you *how* it was
   * asked to run, which is the part that carries the risk.
   */
  readonly spawnFn?: typeof spawn;
}

/**
 * Builds a runner. Each `run` starts one command and resolves with its result.
 *
 * Note what it does *not* do: it never rejects for a non-zero exit. A command
 * failing is ordinary and is reported in `exitCode`; the promise rejects only
 * when the process could not be started at all, or when argv is not something
 * this module is willing to run. That split matters because callers branch on
 * exit codes, and a rejection would route a normal test failure into an error
 * path meant for infrastructure problems.
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
          // If SIGTERM is ignored — a package manager mid-install often is —
          // the process would otherwise outlive the run that owns the
          // worktree, and the next step would delete a directory out from
          // under a live process.
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
            // A signalled death has no exit code. Reporting 0 would read as
            // success, so it is mapped to a non-zero value; `timedOut` carries
            // the reason, and callers that care already check it first.
            const exitCode = code ?? (signal === null ? 1 : 128);
            logger.debug("exec.finished", {
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
