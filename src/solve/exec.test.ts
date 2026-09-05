import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { ALLOWED_EXECUTABLES, childEnv, createCommandRunner, isAllowedExecutable } from "./exec.ts";

/**
 * A stand-in for a `ChildProcess`, good enough for everything this module
 * touches: two output streams, a `kill` that records signals, and the two
 * events it listens for.
 */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];

  kill(signal: string): boolean {
    this.signals.push(signal);
    return true;
  }
}

interface SpawnCall {
  readonly program: string;
  readonly args: readonly string[];
  readonly options: Record<string, unknown>;
}

function fakeSpawn(): {
  spawnFn: typeof import("node:child_process").spawn;
  calls: SpawnCall[];
  child: FakeChild;
} {
  const child = new FakeChild();
  const calls: SpawnCall[] = [];
  const spawnFn = ((program: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ program, args, options });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawnFn, calls, child };
}

const opts = { cwd: "/tmp/solve", timeoutMs: 5_000 };

describe("isAllowedExecutable", () => {
  it.each([...ALLOWED_EXECUTABLES])("allows %s", (program) => {
    expect(isAllowedExecutable(program)).toBe(true);
  });

  it.each(["sh", "bash", "zsh", "env", "xargs", "make", "node", "npx", "curl", "/bin/sh", ""])(
    "refuses %s",
    (program) => {
      // Every one of these is a way to run something that is not on the list,
      // which is the whole point of having one.
      expect(isAllowedExecutable(program)).toBe(false);
    },
  );

  it.each(["./mvnw", "mvnw", "mvnw.cmd", ".mvn/wrapper/mvnw"])("refuses %s", (program) => {
    // Separate from the list above because the reason is different. These are
    // not ways to run something else in general — they are the one program the
    // *repository under verification* gets to choose, and a solve run can write
    // to it. `mvn` is allowed; the wrapper that the repo ships is not.
    expect(isAllowedExecutable(program)).toBe(false);
  });
});

describe("childEnv", () => {
  it("passes through what git and a package manager need", () => {
    const env = childEnv({ PATH: "/usr/bin", HOME: "/Users/x", LANG: "en_GB.UTF-8" });

    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/Users/x");
    expect(env["LANG"]).toBe("en_GB.UTF-8");
  });

  it("does not hand this service's credentials to somebody else's test suite", () => {
    const env = childEnv({
      PATH: "/usr/bin",
      JIRA_API_TOKEN: "secret",
      JIRA_EMAIL: "a@b.c",
      ANTHROPIC_VERTEX_PROJECT_ID: "proj",
      GOOGLE_APPLICATION_CREDENTIALS: "/key.json",
      AWS_SECRET_ACCESS_KEY: "nope",
    });

    expect(env["JIRA_API_TOKEN"]).toBeUndefined();
    expect(env["JIRA_EMAIL"]).toBeUndefined();
    expect(env["ANTHROPIC_VERTEX_PROJECT_ID"]).toBeUndefined();
    expect(env["GOOGLE_APPLICATION_CREDENTIALS"]).toBeUndefined();
    expect(env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
  });

  it("withholds NODE_OPTIONS, which is an arbitrary-code channel", () => {
    const env = childEnv({ PATH: "/usr/bin", NODE_OPTIONS: "--require /tmp/evil.js" });

    expect(env["NODE_OPTIONS"]).toBeUndefined();
  });

  it("is an allowlist, so an unknown variable is not inherited", () => {
    // The distinction that matters: a credential added to `.env` next month is
    // absent by default rather than absent because someone remembered it.
    const env = childEnv({ PATH: "/usr/bin", SOME_TOKEN_INVENTED_LATER: "x" });

    expect(env["SOME_TOKEN_INVENTED_LATER"]).toBeUndefined();
  });

  it("declares itself non-interactive so nothing waits for a prompt", () => {
    const env = childEnv({ PATH: "/usr/bin" });

    expect(env["CI"]).toBe("1");
    expect(env["NO_COLOR"]).toBe("1");
  });
});

describe("createCommandRunner", () => {
  it("refuses a program that is not on the allowlist, without spawning", async () => {
    const { spawnFn, calls } = fakeSpawn();
    const runner = createCommandRunner({ spawnFn, parentEnv: {} });

    await expect(runner.run(["sh", "-c", "rm -rf /"], opts)).rejects.toThrow(
      /refusing to run "sh"/u,
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses an empty argv rather than spawning something undefined", async () => {
    const { spawnFn, calls } = fakeSpawn();
    const runner = createCommandRunner({ spawnFn, parentEnv: {} });

    await expect(runner.run([], opts)).rejects.toThrow(/refusing to run/u);
    expect(calls).toHaveLength(0);
  });

  it("never asks for a shell", async () => {
    // The single most important assertion in this file. With `shell: true`,
    // every argv array carefully built elsewhere in `src/solve/` becomes a
    // string a shell re-parses, and a ticket summary becomes a command.
    const { spawnFn, calls, child } = fakeSpawn();
    const runner = createCommandRunner({ spawnFn, parentEnv: {} });

    const running = runner.run(["git", "status"], opts);
    child.emit("close", 0, null);
    await running;

    expect(calls[0]?.options["shell"]).toBeUndefined();
  });

  it("passes arguments through untouched, including ones a shell would eat", async () => {
    const { spawnFn, calls, child } = fakeSpawn();
    const runner = createCommandRunner({ spawnFn, parentEnv: {} });

    const nasty = "a b; rm -rf / && echo $(whoami) `id` | tee /tmp/x";
    const running = runner.run(["git", "commit", "-m", nasty], opts);
    child.emit("close", 0, null);
    await running;

    expect(calls[0]?.args).toEqual(["commit", "-m", nasty]);
  });

  it("gives the child the scrubbed environment, not this process's", async () => {
    const { spawnFn, calls, child } = fakeSpawn();
    const runner = createCommandRunner({
      spawnFn,
      parentEnv: { PATH: "/usr/bin", JIRA_API_TOKEN: "secret" },
    });

    const running = runner.run(["git", "status"], opts);
    child.emit("close", 0, null);
    await running;

    const env = calls[0]?.options["env"] as NodeJS.ProcessEnv;
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["JIRA_API_TOKEN"]).toBeUndefined();
  });

  it("gives the child no stdin, so nothing can block on a prompt", async () => {
    const { spawnFn, calls, child } = fakeSpawn();
    const runner = createCommandRunner({ spawnFn, parentEnv: {} });

    const running = runner.run(["git", "status"], opts);
    child.emit("close", 0, null);
    await running;

    expect(calls[0]?.options["stdio"]).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("reports a non-zero exit as a result rather than a rejection", async () => {
    // Callers branch on exit codes. Rejecting here would route an ordinary
    // test failure into the path meant for infrastructure problems.
    const { spawnFn, child } = fakeSpawn();
    const runner = createCommandRunner({ spawnFn, parentEnv: {} });

    const running = runner.run(["pnpm", "test"], opts);
    child.stdout.write("2 failed\n");
    child.emit("close", 1, null);

    await expect(running).resolves.toMatchObject({ exitCode: 1, timedOut: false });
  });

  it("rejects when the process could not be started at all", async () => {
    const { spawnFn, child } = fakeSpawn();
    const runner = createCommandRunner({ spawnFn, parentEnv: {} });

    const running = runner.run(["git", "status"], opts);
    child.emit("error", new Error("ENOENT"));

    await expect(running).rejects.toThrow(/ENOENT/u);
  });

  it("captures both streams", async () => {
    const { spawnFn, child } = fakeSpawn();
    const runner = createCommandRunner({ spawnFn, parentEnv: {} });

    const running = runner.run(["git", "status"], opts);
    child.stdout.write("out");
    child.stderr.write("err");
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("close", 0, null);

    await expect(running).resolves.toMatchObject({ stdout: "out", stderr: "err" });
  });

  it("does not report a signalled death as success", async () => {
    // `code` is null when a process is killed. Passing that through as 0 would
    // read as a clean run to every caller that checks the exit code.
    const { spawnFn, child } = fakeSpawn();
    const runner = createCommandRunner({ spawnFn, parentEnv: {} });

    const running = runner.run(["pnpm", "test"], opts);
    child.emit("close", null, "SIGKILL");

    const result = await running;
    expect(result.exitCode).not.toBe(0);
  });

  describe("timeout", () => {
    it("asks the child to stop, then makes it", async () => {
      vi.useFakeTimers();
      try {
        const { spawnFn, child } = fakeSpawn();
        const runner = createCommandRunner({ spawnFn, parentEnv: {} });

        const running = runner.run(["pnpm", "install"], { cwd: "/tmp", timeoutMs: 1_000 });

        await vi.advanceTimersByTimeAsync(1_000);
        expect(child.signals).toEqual(["SIGTERM"]);

        // A package manager mid-install frequently ignores SIGTERM. Without the
        // escalation the process outlives the run that owns the worktree, and
        // the next step removes a directory from under a live process.
        await vi.advanceTimersByTimeAsync(2_000);
        expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);

        child.emit("close", null, "SIGKILL");
        await expect(running).resolves.toMatchObject({ timedOut: true });
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not escalate when the child stops when asked", async () => {
      vi.useFakeTimers();
      try {
        const { spawnFn, child } = fakeSpawn();
        const runner = createCommandRunner({ spawnFn, parentEnv: {} });

        const running = runner.run(["pnpm", "install"], { cwd: "/tmp", timeoutMs: 1_000 });
        await vi.advanceTimersByTimeAsync(1_000);
        child.emit("close", null, "SIGTERM");
        await running;

        await vi.advanceTimersByTimeAsync(5_000);
        expect(child.signals).toEqual(["SIGTERM"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not fire for a command that finishes in time", async () => {
      vi.useFakeTimers();
      try {
        const { spawnFn, child } = fakeSpawn();
        const runner = createCommandRunner({ spawnFn, parentEnv: {} });

        const running = runner.run(["git", "status"], { cwd: "/tmp", timeoutMs: 10_000 });
        child.emit("close", 0, null);
        await expect(running).resolves.toMatchObject({ timedOut: false });

        await vi.advanceTimersByTimeAsync(30_000);
        expect(child.signals).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

/**
 * A handful of real processes, because everything above is a fake and a fake
 * agreeing with itself proves nothing about `spawn`. Kept to `git --version`
 * and friends: no network, no writes, present wherever this service runs.
 */
describe("against a real process", () => {
  const runner = createCommandRunner();

  it("runs a real command and captures its output", async () => {
    const result = await runner.run(["git", "--version"], { cwd: "/tmp", timeoutMs: 30_000 });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^git version/u);
    expect(result.timedOut).toBe(false);
  });

  it("reports a real failure without rejecting", async () => {
    const result = await runner.run(["git", "rev-parse", "--verify", "definitely-not-a-ref"], {
      cwd: "/tmp",
      timeoutMs: 30_000,
    });

    expect(result.exitCode).not.toBe(0);
  });

  it("does not let a real argument reach a shell", async () => {
    // If a shell were involved this creates the file. `git` receives it as one
    // argument, fails to parse it as a ref, and exits non-zero.
    //
    // The witness path is unique per run, and the earlier version of this test
    // — which used a fixed `/tmp/jira-police-pwned` — taught the lesson the
    // hard way: mutating `exec.ts` to `shell: true` really did create the
    // file, and it then sat there failing this test on every subsequent run
    // for a reason that had nothing to do with the code under test. A test
    // that a previous test run can poison is a test that will one day be
    // deleted for flapping.
    const { existsSync, rmSync } = await import("node:fs");
    const witness = `/tmp/jira-police-shell-witness-${String(process.pid)}-${String(Date.now())}`;
    rmSync(witness, { force: true });

    try {
      const result = await runner.run(["git", "rev-parse", "--verify", `x; touch ${witness}`], {
        cwd: "/tmp",
        timeoutMs: 30_000,
      });

      expect(result.exitCode).not.toBe(0);
      expect(existsSync(witness)).toBe(false);
    } finally {
      rmSync(witness, { force: true });
    }
  });
});
