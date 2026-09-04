import { describe, expect, it } from "vitest";

import {
  type VerifyRequest,
  discoverPlan,
  packageManagerOf,
  unverifiableChanges,
  verify,
} from "./verify.ts";
import type { CommandResult, CommandRunner } from "./worktree.ts";

const NUL = "\u0000";

const OK: CommandResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
const out = (stdout: string): CommandResult => ({ ...OK, stdout });
const bad = (exitCode = 1): CommandResult => ({ ...OK, exitCode, stderr: "boom" });
const TIMEOUT: CommandResult = { ...OK, timedOut: true };

const MANIFEST = JSON.stringify({
  name: "buy-insurance-advisor-web",
  packageManager: "pnpm@11.20.0",
  scripts: { test: "vitest run", "check-types": "tsc --noEmit", lint: "oxlint", dev: "vite" },
});

/**
 * Replies by matching on the command, not by position.
 *
 * Position-keyed fakes were tried first and made the tests lie: a mutation that
 * removed a step shifted every later reply onto the wrong command, so tests
 * failed for the wrong reason and the mutation looked caught when it was not.
 */
function fakeRunner(replies: Record<string, CommandResult> = {}): CommandRunner & {
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    run: (argv) => {
      calls.push([...argv]);
      for (const [needle, reply] of Object.entries(replies)) {
        if (argv.join(" ").includes(needle)) {
          return Promise.resolve(reply);
        }
      }
      return Promise.resolve(argv.includes("show") ? out(MANIFEST) : OK);
    },
  };
}

const request = (overrides: Partial<VerifyRequest> = {}): VerifyRequest => ({
  repoPath: "/repos/advisor",
  worktreePath: "/tmp/solve/SSX-3822",
  baseRef: "origin/main",
  stepTimeoutMs: 120_000,
  installTimeoutMs: 300_000,
  ...overrides,
});

/** The reason of any non-passing result, or "" if it passed. */
function reason(result: { outcome: string; reason?: string }): string {
  return result.reason ?? "";
}

describe("packageManagerOf", () => {
  it("reads the declared manager and drops the version", () => {
    expect(packageManagerOf(MANIFEST)).toBe("pnpm");
    expect(packageManagerOf(`{"packageManager":"yarn@4.1.0"}`)).toBe("yarn");
  });

  it("defaults when nothing is declared", () => {
    expect(packageManagerOf(`{"scripts":{}}`)).toBe("pnpm");
  });

  it("refuses a manager it was never given", () => {
    expect(packageManagerOf(`{"packageManager":"bun@1"}`)).toBeNull();
    expect(packageManagerOf(`{"packageManager":"../../evil@1"}`)).toBeNull();
    expect(packageManagerOf(`{"packageManager":42}`)).toBeNull();
  });

  it("does not accept an inherited property as an allowlisted name", () => {
    // `"constructor" in PACKAGE_MANAGERS` is true, so an allowlist checked with
    // `in` silently admits every name on Object.prototype — and this value
    // decides which binary gets executed.
    for (const inherited of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(packageManagerOf(`{"packageManager":"${inherited}@1"}`)).toBeNull();
    }
  });
});

describe("discoverPlan", () => {
  it("reads the commands from the base, never from the worktree", async () => {
    const runner = fakeRunner();

    const result = await discoverPlan(runner, request());

    expect(runner.calls[0]).toEqual([
      "git",
      "-C",
      "/repos/advisor",
      "show",
      "origin/main:package.json",
    ]);
    expect(result.outcome === "planned" ? result.plan.steps : []).toEqual([
      { name: "typecheck", argv: ["pnpm", "run", "check-types"] },
      { name: "lint", argv: ["pnpm", "run", "lint"] },
      { name: "test", argv: ["pnpm", "run", "test"] },
    ]);
  });

  it("installs with the lockfile pinned", async () => {
    const result = await discoverPlan(fakeRunner(), request());

    // A run that edited the lockfile fails install rather than resolving to
    // whatever it asked for.
    expect(result.outcome === "planned" ? result.plan.install : []).toEqual([
      "pnpm",
      "install",
      "--frozen-lockfile",
    ]);
  });

  it("orders the steps cheapest first", async () => {
    const result = await discoverPlan(fakeRunner(), request());
    const names = result.outcome === "planned" ? result.plan.steps.map((step) => step.name) : [];

    expect(names).toEqual(["typecheck", "lint", "test"]);
  });

  it("accepts either spelling of the typecheck script", async () => {
    const runner = fakeRunner({
      show: out(`{"scripts":{"test":"vitest","typecheck":"tsc --noEmit"}}`),
    });

    const result = await discoverPlan(runner, request());

    expect(result.outcome === "planned" ? result.plan.steps[0] : null).toEqual({
      name: "typecheck",
      argv: ["pnpm", "run", "typecheck"],
    });
  });

  it("runs only what the repository has", async () => {
    const runner = fakeRunner({ show: out(`{"scripts":{"test":"vitest"}}`) });

    const result = await discoverPlan(runner, request());

    expect(result.outcome === "planned" ? result.plan.steps.map((s) => s.name) : []).toEqual([
      "test",
    ]);
  });

  it("refuses a repository with no test script", async () => {
    const runner = fakeRunner({ show: out(`{"scripts":{"lint":"oxlint"}}`) });

    expect(reason(await discoverPlan(runner, request()))).toContain("no test script");
  });

  it("refuses a manifest it cannot parse, distinctly from one without tests", async () => {
    for (const raw of ["not json", "[]", `{"scripts":"nope"}`, "null"]) {
      const result = await discoverPlan(fakeRunner({ show: out(raw) }), request());
      expect(reason(result)).toContain("could not be parsed");
    }
  });

  it("refuses when the base manifest cannot be read at all", async () => {
    expect(reason(await discoverPlan(fakeRunner({ show: bad(128) }), request()))).toContain(
      "could not read",
    );
    expect(reason(await discoverPlan(fakeRunner({ show: TIMEOUT }), request()))).toContain(
      "could not read",
    );
  });

  it("refuses a base manifest declaring a manager it will not execute", async () => {
    // Distinct from the `packageManagerOf` test above, which only proves the
    // parser says null. This proves the caller acts on it — without which the
    // plan is built with `null` as the command and the refusal is decorative.
    const runner = fakeRunner({
      show: out(`{"packageManager":"bun@1","scripts":{"test":"vitest"}}`),
    });

    const result = await discoverPlan(runner, request());

    expect(result.outcome).toBe("refused");
    expect(reason(result)).toContain("will not execute");
  });

  it("never takes a script name out of the manifest", async () => {
    // The keys of `scripts` are attacker-adjacent; the arguments must come from
    // this module's own table. A manifest full of hostile keys yields nothing.
    const runner = fakeRunner({
      show: out(
        JSON.stringify({ scripts: { test: "vitest", "--version": "x", "; rm -rf /": "x" } }),
      ),
    });

    const result = await discoverPlan(runner, request());
    const args = result.outcome === "planned" ? result.plan.steps.flatMap((s) => s.argv) : [];

    expect(args).toEqual(["pnpm", "run", "test"]);
  });
});

describe("unverifiableChanges", () => {
  it("names the changed files that define what passing means", async () => {
    const runner = fakeRunner({ diff: out(`src/a.ts${NUL}package.json${NUL}`) });

    expect(await unverifiableChanges(runner, request())).toEqual(["package.json"]);
  });

  it("says nothing about an ordinary diff", async () => {
    const runner = fakeRunner({ diff: out(`src/a.ts${NUL}src/a.test.ts${NUL}`) });

    expect(await unverifiableChanges(runner, request())).toEqual([]);
  });

  it("splits on NUL, so a filename containing a newline stays one entry", async () => {
    // Split on newlines instead and this one path becomes two, the second of
    // which is named by whoever wrote the file — which is how a run smuggles a
    // second entry past a check that only looks at whole paths.
    const runner = fakeRunner({ diff: out(`src/we\nird.ts${NUL}package.json${NUL}`) });

    expect(await unverifiableChanges(runner, request())).toEqual(["package.json"]);
    expect(runner.calls[0]).toContain("-z");
  });

  it("reports inability to tell, rather than an empty list", async () => {
    // An empty list means "nothing was tainted". A failed diff means "unknown",
    // and the caller must not read the second as the first.
    expect(await unverifiableChanges(fakeRunner({ diff: bad() }), request())).toBeNull();
    expect(await unverifiableChanges(fakeRunner({ diff: TIMEOUT }), request())).toBeNull();
  });
});

describe("verify", () => {
  it("runs install then every step, in the worktree", async () => {
    const runner = fakeRunner({ diff: out("") });

    const result = await verify(runner, request());

    expect(result.outcome).toBe("passed");
    expect(runner.calls.map((argv) => argv.join(" "))).toEqual([
      "git -C /tmp/solve/SSX-3822 diff --name-only -z origin/main --",
      "git -C /repos/advisor show origin/main:package.json",
      "pnpm install --frozen-lockfile",
      "pnpm run check-types",
      "pnpm run lint",
      "pnpm run test",
    ]);
  });

  it("refuses before running anything if the run edited the definition of passing", async () => {
    // The heart of it. Discovery from the base is not enough on its own: the
    // package manager reads the manifest on disk, so a run that edited it would
    // otherwise be graded by rules it wrote.
    const runner = fakeRunner({ diff: out(`package.json${NUL}`) });

    const result = await verify(runner, request());

    expect(result.outcome).toBe("refused");
    expect(reason(result)).toContain("define what passing means");
    expect(runner.calls).toHaveLength(1);
  });

  it("refuses on an edited tsconfig, lint config or test config too", async () => {
    for (const path of ["tsconfig.json", ".oxlintrc.json", "vitest.config.ts"]) {
      const result = await verify(fakeRunner({ diff: out(`${path}${NUL}`) }), request());
      expect(result.outcome).toBe("refused");
    }
  });

  it("refuses when it cannot tell what the run changed", async () => {
    const result = await verify(fakeRunner({ diff: bad() }), request());

    expect(result.outcome).toBe("refused");
    expect(reason(result)).toContain("could not determine");
  });

  it("reports a failing step as a failure, with the steps that led there", async () => {
    const runner = fakeRunner({ diff: out(""), "run lint": bad(2) });

    const result = await verify(runner, request());

    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("lint did not pass");
    expect(result.outcome === "failed" ? result.steps.map((s) => s.name) : []).toEqual([
      "install",
      "typecheck",
      "lint",
    ]);
  });

  it("stops at the first failing step rather than running the rest", async () => {
    const runner = fakeRunner({ diff: out(""), "run check-types": bad() });

    await verify(runner, request());

    expect(runner.calls.map((argv) => argv.join(" "))).not.toContain("pnpm run test");
  });

  it("counts a timed-out step as failed, never as inconclusive", async () => {
    // Inconclusive is the reading that lets an infinite loop through.
    const runner = fakeRunner({ diff: out(""), "run test": TIMEOUT });

    const result = await verify(runner, request());

    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("timed out");
  });

  it("treats a broken install as no verdict rather than a failed one", async () => {
    // Nothing was verified, so there is nothing to have failed. Calling this
    // `failed` would blame the solver for the network.
    const runner = fakeRunner({ diff: out(""), install: bad() });

    const result = await verify(runner, request());

    expect(result.outcome).toBe("refused");
    expect(reason(result)).toContain("no step ran");
  });

  it("refuses rather than passing when the base has no test script", async () => {
    const runner = fakeRunner({ diff: out(""), show: out(`{"scripts":{"lint":"oxlint"}}`) });

    const result = await verify(runner, request());

    expect(result.outcome).toBe("refused");
    expect(runner.calls.map((argv) => argv.join(" "))).not.toContain(
      "pnpm install --frozen-lockfile",
    );
  });

  it("gives install a longer timeout than the steps it precedes", async () => {
    const seen: number[] = [];
    const runner: CommandRunner = {
      run: (argv, options) => {
        seen.push(options.timeoutMs);
        return Promise.resolve(argv.includes("show") ? out(MANIFEST) : OK);
      },
    };

    await verify(runner, request({ installTimeoutMs: 999, stepTimeoutMs: 111 }));

    expect(seen[2]).toBe(999);
    expect(seen.slice(3)).toEqual([111, 111, 111]);
  });

  it("keeps a bounded tail of output for the report", async () => {
    const noisy = { ...OK, stdout: "x".repeat(10_000) };
    const runner = fakeRunner({ diff: out(""), "run test": { ...noisy, exitCode: 1 } });

    const result = await verify(runner, request());
    const last = result.outcome === "failed" ? result.steps.at(-1) : undefined;

    expect(last?.output.length).toBeLessThanOrEqual(4000);
  });
});
