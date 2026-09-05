/**
 * The first test in this file, and it exists because of what is *not* here.
 *
 * `solve-run.ts` has no test harness — nothing in this tree constructs its
 * dependencies, which is why D4e could measure that its own call-site mutation
 * survives. That gap is recorded at the call site and is not closed here. This
 * file covers one function, for one reason: `sleep` is the only line in the
 * review chain that has to hold the process open, it did the opposite for a
 * day, and the failure is invisible to every kind of test this repository
 * currently writes.
 *
 * It has to be a child process. A unit test cannot observe "the event loop
 * stayed alive" from inside a runner that is itself holding the loop open —
 * Vitest's own timers, workers and file handles keep the process up no matter
 * what `sleep` does, so an in-process assertion would pass against both the
 * broken version and the fixed one. The thing being tested is a property of a
 * program, so the test runs a program.
 */

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

const SOLVE_RUN = fileURLToPath(new URL("./solve-run.ts", import.meta.url));

/**
 * How long the child is asked to sleep.
 *
 * Long enough that an unref'd timer loses the race by a wide margin — the
 * broken version exits in the time it takes to load the module, which is
 * milliseconds — and short enough that this test is not the reason anyone stops
 * running the suite.
 */
const SLEEP_MS = 400;

/**
 * The margin below which we call it "did not wait".
 *
 * Deliberately well under `SLEEP_MS` rather than equal to it. A loaded machine
 * can overshoot a timer but cannot undershoot one, so the only way to land
 * below this is not to have waited at all, and a tight bound would fail on
 * timer granularity instead of on the defect.
 */
const WAITED_AT_LEAST_MS = 200;

function runChild(source: string): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, status: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; status?: number };
    return { stdout: failure.stdout ?? "", status: failure.status ?? -1 };
  }
}

describe("sleep", () => {
  it("holds the process open, which is the whole of its job", () => {
    const { stdout, status } = runChild(
      [
        `import { sleep } from ${JSON.stringify(SOLVE_RUN)};`,
        "const started = Date.now();",
        `await sleep(${SLEEP_MS});`,
        'process.stdout.write("waited:" + (Date.now() - started));',
      ].join("\n"),
    );

    // Restore the `.unref()` and this is where it fails: the child prints
    // nothing at all, because it exits before the timer fires. The elapsed
    // assertion below is the readable one; this is the one that actually
    // catches the mutation.
    expect(stdout).toMatch(/^waited:\d+$/);

    const waited = Number(stdout.slice("waited:".length));
    expect(waited).toBeGreaterThanOrEqual(WAITED_AT_LEAST_MS);
    expect(status).toBe(0);
  });

  it("exits zero rather than 13, which is how the defect actually presented", () => {
    // `solve-once.ts` awaits the chain at the top level. An unref'd sleep makes
    // Node drain the loop with that await unsettled, and it exits 13 with a
    // warning rather than an error — so the run looked like a crash with no
    // stack, on a ticket that had already been claimed, solved and published.
    // Asserting the code pins the symptom a future reader will search for.
    const { status } = runChild(
      [`import { sleep } from ${JSON.stringify(SOLVE_RUN)};`, `await sleep(${SLEEP_MS});`].join(
        "\n",
      ),
    );

    expect(status).toBe(0);
  });
});
