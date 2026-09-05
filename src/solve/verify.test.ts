import { describe, expect, it } from "vitest";

import { ALLOWED_EXECUTABLES } from "./exec.ts";
import {
  type VerifyRequest,
  discoverPlan,
  invocationOf,
  packageManagerOf,
  unverifiableChanges,
  verify,
  verifyBase,
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

const POM = `<?xml version="1.0"?><project><artifactId>insurance-commerce-rest-api</artifactId></project>`;

/** `git show` of a path that is not in the tree. */
const ABSENT: CommandResult = { ...OK, exitCode: 128, stderr: "fatal: path does not exist" };

/**
 * Replies by matching on the command, not by position.
 *
 * Position-keyed fakes were tried first and made the tests lie: a mutation that
 * removed a step shifted every later reply onto the wrong command, so tests
 * failed for the wrong reason and the mutation looked caught when it was not.
 *
 * The default world is a Node repository: `package.json` is in the base tree
 * and `pom.xml` is not. That default is what makes the Maven tests below mean
 * something — a fake that answered every `git show` identically would put both
 * manifests in every base, so every test would take the both-toolchains
 * refusal and no Node assertion would ever be reached. Keys match a substring
 * of the joined argv, so a test picks a toolchain by keying on the manifest it
 * wants: `"package.json"` or `"pom.xml"`.
 */
function fakeRunner(replies: Record<string, CommandResult> = {}): CommandRunner & {
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    run: (argv) => {
      calls.push([...argv]);
      const line = argv.join(" ");
      for (const [needle, reply] of Object.entries(replies)) {
        if (line.includes(needle)) {
          return Promise.resolve(reply);
        }
      }
      if (line.includes(" show ")) {
        return Promise.resolve(line.endsWith(":package.json") ? out(MANIFEST) : ABSENT);
      }
      return Promise.resolve(OK);
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
      { name: "typecheck", argv: ["corepack", "pnpm@11.20.0", "run", "check-types"], cold: false },
      { name: "lint", argv: ["corepack", "pnpm@11.20.0", "run", "lint"], cold: false },
      { name: "test", argv: ["corepack", "pnpm@11.20.0", "run", "test"], cold: false },
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
      "package.json": out(`{"scripts":{"test":"vitest","typecheck":"tsc --noEmit"}}`),
    });

    const result = await discoverPlan(runner, request());

    // Bare `pnpm`, not corepack: this fixture pins no `packageManager`.
    expect(result.outcome === "planned" ? result.plan.steps[0] : null).toEqual({
      name: "typecheck",
      argv: ["pnpm", "run", "typecheck"],
      cold: false,
    });
  });

  it("runs only what the repository has", async () => {
    const runner = fakeRunner({ "package.json": out(`{"scripts":{"test":"vitest"}}`) });

    const result = await discoverPlan(runner, request());

    expect(result.outcome === "planned" ? result.plan.steps.map((s) => s.name) : []).toEqual([
      "test",
    ]);
  });

  it("refuses a repository with no test script", async () => {
    const runner = fakeRunner({ "package.json": out(`{"scripts":{"lint":"oxlint"}}`) });

    expect(reason(await discoverPlan(runner, request()))).toContain("no test script");
  });

  it("refuses a manifest it cannot parse, distinctly from one without tests", async () => {
    for (const raw of ["not json", "[]", `{"scripts":"nope"}`, "null"]) {
      const result = await discoverPlan(fakeRunner({ "package.json": out(raw) }), request());
      expect(reason(result)).toContain("could not be parsed");
    }
  });

  it("refuses when neither manifest is in the base, and names the ref", async () => {
    // Both manifests absent has two causes this cannot tell apart — an
    // unrecognised build system, or a base ref that does not exist — so the
    // refusal has to name the ref rather than assert the first reading.
    const result = await discoverPlan(fakeRunner({ "package.json": bad(128) }), request());

    expect(reason(result)).toContain("could not read");
    expect(reason(result)).toContain("origin/main");
  });

  it("keeps a read that timed out apart from a manifest that is not there", async () => {
    // Same outcome, deliberately different reason. A timed-out `git show` is
    // this machine failing, and reporting it as "no manifest here" would send
    // the reader to the repository to look for a build system it already has.
    const result = await discoverPlan(fakeRunner({ "package.json": TIMEOUT }), request());

    expect(reason(result)).toContain("timed out");
    expect(reason(result)).not.toContain("does not recognise");
  });

  it("refuses a base manifest declaring a manager it will not execute", async () => {
    // Distinct from the `packageManagerOf` test above, which only proves the
    // parser says null. This proves the caller acts on it — without which the
    // plan is built with `null` as the command and the refusal is decorative.
    const runner = fakeRunner({
      "package.json": out(`{"packageManager":"bun@1","scripts":{"test":"vitest"}}`),
    });

    const result = await discoverPlan(runner, request());

    expect(result.outcome).toBe("refused");
    expect(reason(result)).toContain("will not execute");
  });

  it("never takes a script name out of the manifest", async () => {
    // The keys of `scripts` are attacker-adjacent; the arguments must come from
    // this module's own table. A manifest full of hostile keys yields nothing.
    const runner = fakeRunner({
      "package.json": out(
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
      "git -C /repos/advisor show origin/main:pom.xml",
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
    const runner = fakeRunner({
      diff: out(""),
      "package.json": out(`{"scripts":{"lint":"oxlint"}}`),
    });

    const result = await verify(runner, request());

    expect(result.outcome).toBe("refused");
    expect(runner.calls.map((argv) => argv.join(" "))).not.toContain(
      "corepack pnpm@11.20.0 install --frozen-lockfile",
    );
  });

  it("gives install a longer timeout than the steps it precedes", async () => {
    const seen: number[] = [];
    const inner = fakeRunner({ diff: out("") });
    const runner: CommandRunner = {
      run: (argv, options) => {
        seen.push(options.timeoutMs);
        return inner.run(argv, options);
      },
    };

    await verify(runner, request({ installTimeoutMs: 999, stepTimeoutMs: 111 }));

    // diff, two manifest reads, install, then the three warm steps.
    expect(seen.slice(0, 4)).toEqual([111, 111, 111, 999]);
    expect(seen.slice(4)).toEqual([111, 111, 111]);
  });

  it("keeps a bounded tail of output for the report", async () => {
    const noisy = { ...OK, stdout: "x".repeat(10_000) };
    const runner = fakeRunner({ diff: out(""), "run test": { ...noisy, exitCode: 1 } });

    const result = await verify(runner, request());
    const last = result.outcome === "failed" ? result.steps.at(-1) : undefined;

    expect(last?.output.length).toBeLessThanOrEqual(4000);
  });
});

/**
 * A base whose only manifest is a POM.
 *
 * `package.json` is answered as absent explicitly rather than left to the
 * default, because the default is the Node world and a Maven test that quietly
 * inherited it would take the both-toolchains refusal instead of the branch it
 * is about.
 */
const mavenRunner = (replies: Record<string, CommandResult> = {}): ReturnType<typeof fakeRunner> =>
  fakeRunner({ "package.json": ABSENT, "pom.xml": out(POM), ...replies });

describe("the Maven toolchain", () => {
  it("plans one cold test step and no install", async () => {
    const result = await discoverPlan(mavenRunner(), request());

    expect(result.outcome === "planned" ? result.plan : null).toEqual({
      // No install phase at all, rather than an install that does nothing:
      // `mvn test` resolves its own dependencies, so a separate step would
      // either be a no-op line in the report or a second full download.
      install: null,
      steps: [
        { name: "test", argv: ["mvn", "-B", "-Dmaven.gitcommitid.skip=true", "test"], cold: true },
      ],
      toolchain: "maven",
      note: expect.stringContaining("-Dmaven.gitcommitid.skip=true") as unknown as string,
    });
  });

  it("skips git stamping, which cannot read a worktree", async () => {
    // THE GUARD. `git-commit-id-plugin` binds to `initialize`, so without this
    // the build dies before compiling anything and the run is booked as a
    // failed fix of code that was never built. Measured on
    // insurance-commerce-rest-api: `Could not get HEAD Ref` in a worktree,
    // green in an ordinary checkout of the same commit.
    const result = await discoverPlan(mavenRunner(), request());
    const argv = result.outcome === "planned" ? (result.plan.steps[0]?.argv ?? []) : [];

    expect(argv).toContain("-Dmaven.gitcommitid.skip=true");
  });

  it("passes it as a property, never as a flag", async () => {
    // The distinction the whole workaround rests on. Maven ignores a user
    // property no plugin claims, so this is inert on a repository without the
    // plugin; an unrecognised *flag* would exit non-zero on the test step and
    // be reported as `failed` — a harness mistake printed as a verdict about
    // the model's code. Anything here not starting `-D` is that mistake.
    const result = await discoverPlan(mavenRunner(), request());
    const argv = result.outcome === "planned" ? (result.plan.steps[0]?.argv ?? []) : [];

    for (const arg of argv.slice(1, -1)) {
      expect(arg === "-B" || arg.startsWith("-D")).toBe(true);
    }
  });

  it("says in the reason that it did not run the repository's own build", async () => {
    // The accepted cost, made visible where it is acted on. A reviewer decides
    // whether to trust a red Maven run partly on whether it was the real build,
    // and this is the only place that question gets answered.
    const result = await verify(mavenRunner({ diff: out(""), "-B": bad(1) }), request());

    expect(reason(result)).toContain("-Dmaven.gitcommitid.skip=true");
  });

  it("does not claim a wrapper was skipped as though one existed", async () => {
    // The repository this was built for has no `mvnw` and no `.mvn/wrapper`.
    // The note used to assert the wrapper "is deliberately not executed",
    // sending an operator to look for a file that is not there — the
    // prose/behaviour divergence this project exists to catch, in our own text.
    const result = await discoverPlan(mavenRunner(), request());
    const note = result.outcome === "planned" ? result.plan.note : "";

    expect(note).toContain("if the repository has a wrapper");
  });

  it("never runs a Node command against a Maven base", async () => {
    const runner = mavenRunner({ diff: out("") });

    await verify(runner, request());

    const line = runner.calls.map((argv) => argv.join(" ")).join("\n");
    for (const nodeism of ["pnpm", "npm", "yarn", "corepack", "run test", "--frozen-lockfile"]) {
      expect(line).not.toContain(nodeism);
    }
  });

  it("never runs a Maven command against a Node base", async () => {
    // The mirror of the test above, and the one that would catch a toolchain
    // dispatch that fell through to Maven on an unrecognised manifest.
    const runner = fakeRunner({ diff: out("") });

    await verify(runner, request());

    expect(runner.calls.map((argv) => argv[0])).not.toContain("mvn");
  });

  it("charges the cold step the install budget, not the step budget", async () => {
    // A first Java build downloads the world. On the step budget it times out
    // and is reported as `failed` — the machine's cold cache printed as a
    // verdict about the change.
    const seen: number[] = [];
    const inner = mavenRunner({ diff: out("") });
    const runner: CommandRunner = {
      run: (argv, options) => {
        seen.push(options.timeoutMs);
        return inner.run(argv, options);
      },
    };

    await verify(runner, request({ installTimeoutMs: 999, stepTimeoutMs: 111 }));

    expect(seen.at(-1)).toBe(999);
  });

  it("refuses when there is no working mvn, rather than failing the change", async () => {
    // The distinction this probe exists for. Without it the missing tool makes
    // `mvn -B test` exit non-zero, and a harness with no Java installed reports
    // every Java fix as broken.
    const result = await discoverPlan(mavenRunner({ "mvn -v": bad(127) }), request());

    expect(result.outcome).toBe("refused");
    expect(reason(result)).toContain("not the change being wrong");
  });

  it("probes for mvn before planning, not after the plan is handed out", async () => {
    const runner = mavenRunner({ "mvn -v": TIMEOUT });

    expect((await discoverPlan(runner, request())).outcome).toBe("refused");
    expect(runner.calls.map((argv) => argv.join(" "))).toContain("mvn -v");
  });

  it("refuses a pom.xml that is not a POM", async () => {
    const result = await discoverPlan(mavenRunner({ "pom.xml": out("not xml") }), request());

    expect(result.outcome).toBe("refused");
    expect(reason(result)).toContain("does not look like a POM");
  });

  it("refuses a base carrying both manifests instead of picking one", async () => {
    // Two build systems disagree about what passing means here. Resolving that
    // into a choice would make the verdict a property of which file this
    // function happens to read first.
    const runner = fakeRunner({ "pom.xml": out(POM) });

    const result = await discoverPlan(runner, request());

    expect(result.outcome).toBe("refused");
    expect(reason(result)).toContain("choosing one would be a guess");
    expect(runner.calls.map((argv) => argv[0])).not.toContain("mvn");
  });

  it("carries the wrapper note into a failed Maven run", async () => {
    // The cold step is also the install, so there is no install refusal to hang
    // the note on. Without this the "mvnw was not executed" hint — the first
    // thing to check on a version mismatch — could never be printed.
    const result = await verify(
      mavenRunner({ diff: out(""), "skip=true test": bad(1) }),
      request(),
    );

    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("not byte-for-byte the build CI runs");
  });

  it("names an executable the runner allows", async () => {
    const result = await discoverPlan(mavenRunner(), request());
    const argv0 = result.outcome === "planned" ? (result.plan.steps[0]?.argv[0] ?? "") : "";

    expect(ALLOWED_EXECUTABLES).toContain(argv0);
  });
});

describe("verifyBase", () => {
  it("calls a green base usable and says nothing else", async () => {
    const check = await verifyBase(fakeRunner({ diff: out("") }), request());

    expect(check).toEqual({ outcome: "usable" });
  });

  it("calls a red base unusable rather than letting it become a failed fix", async () => {
    // THE GUARD. `verify`'s `failed` means "the change is bad", and that is only
    // true if these same steps pass without the change. Measured on SSX-3801:
    // a Maven plugin could not read a linked worktree's `.git`, the build died
    // before compiling anything, and the run was booked as a failed fix of a
    // fix that was never built.
    const check = await verifyBase(fakeRunner({ diff: out(""), "run test": bad(1) }), request());

    expect(check.outcome).toBe("unusable");
  });

  it("blames the repository, not the fix, in the reason it gives", async () => {
    // The wording is the point. This reason is posted to a Jira ticket, and a
    // reader who takes it as a verdict on their bug goes looking for a defect
    // that was never reported.
    const check = await verifyBase(fakeRunner({ diff: out(""), "run test": bad(1) }), request());
    const said = check.outcome === "unusable" ? check.reason : "";

    expect(said).toContain("the repository's own build");
    expect(said).toContain("before anything was changed");
    expect(said).toContain("not about any fix");
    // The subject has to be the repository. Swapping in "the change" leaves
    // every phrase above intact and reverses what the sentence says, which is
    // the one mutation this test exists to catch.
    expect(said).not.toContain("the change");
  });

  it("keeps a refusal apart from a red base", async () => {
    // Both are unusable, but they are different repairs: one is a build to fix,
    // the other is a harness that could not run one. Collapsing them sends the
    // operator to the wrong place.
    const check = await verifyBase(fakeRunner({ show: ABSENT }), request());
    const said = check.outcome === "unusable" ? check.reason : "";

    expect(said).toContain("could not be run here at all");
    expect(said).not.toContain("does not pass");
  });

  it("hands the whole verification back, not just a sentence", async () => {
    // The caller logs which outcome it was and a human needs the step that
    // died. Reducing this to a string here would discard it at the only point
    // it exists.
    const check = await verifyBase(fakeRunner({ diff: out(""), "run lint": bad(1) }), request());

    expect(check.outcome === "unusable" ? check.verification.outcome : "").toBe("failed");
  });

  it("runs the same steps the real check will", async () => {
    // If the base were verified with a cheaper plan, its green would not
    // license anything. Pinned by comparing the two command lists directly.
    const baseRunner = fakeRunner({ diff: out("") });
    const laterRunner = fakeRunner({ diff: out("") });

    await verifyBase(baseRunner, request());
    await verify(laterRunner, request());

    expect(baseRunner.calls).toEqual(laterRunner.calls);
  });
});
