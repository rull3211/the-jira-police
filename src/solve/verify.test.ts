import { describe, expect, it } from "vitest";

import { ALLOWED_EXECUTABLES } from "./exec.ts";
import {
  type FailFirstRequest,
  type VerifyRequest,
  checkFailFirst,
  discoverPlan,
  isTestPath,
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

/** Replies by matching on the command, not by position, so removing a step can't silently shift a reply onto the wrong one. */
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
    // `null`, not a guessed version — `versionNote` reports the absence, which is what makes an install refusal diagnosable.
    expect(packageManagerOf(`{"scripts":{}}`)).toEqual({ name: "pnpm", version: null });
  });

  it("refuses a manager it was never given", () => {
    // Valid semver throughout, so the name allowlist is the only thing that can reject these.
    expect(packageManagerOf(`{"packageManager":"bun@1.0.0"}`)).toBeNull();
    expect(packageManagerOf(`{"packageManager":"../../evil@1.0.0"}`)).toBeNull();
    expect(packageManagerOf(`{"packageManager":42}`)).toBeNull();
  });

  it("does not accept an inherited property as an allowlisted name", () => {
    // `"constructor" in PACKAGE_MANAGERS` is true, so an `in` check would admit every name on Object.prototype.
    for (const inherited of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(packageManagerOf(`{"packageManager":"${inherited}@1.0.0"}`)).toBeNull();
    }
  });

  it("refuses anything corepack would treat as a location rather than a version", () => {
    // The one that matters: corepack accepts a URL here and will download and execute it.
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
    // Doesn't prove the first-`@` split is load-bearing (the name allowlist refuses these too), only that neither reading lets one through.
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
    // Coupled only by this assertion: `exec.ts` refuses argv[0] outside its allowlist, so a mismatch here would refuse at execution instead of discovery.
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

    // A run that edited the lockfile fails install rather than resolving to whatever it asked for.
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
    // Both manifests absent has two causes this can't tell apart, so the refusal names the ref rather than asserting one reading.
    const result = await discoverPlan(fakeRunner({ "package.json": bad(128) }), request());

    expect(reason(result)).toContain("could not read");
    expect(reason(result)).toContain("origin/main");
  });

  it("keeps a read that timed out apart from a manifest that is not there", async () => {
    // Same outcome, deliberately different reason: a timed-out `git show` is this machine failing, not a missing manifest.
    const result = await discoverPlan(fakeRunner({ "package.json": TIMEOUT }), request());

    expect(reason(result)).toContain("timed out");
    expect(reason(result)).not.toContain("does not recognise");
  });

  it("refuses a base manifest declaring a manager it will not execute", async () => {
    // Distinct from the `packageManagerOf` test above: this proves the caller acts on the null, not just that the parser returns it.
    const runner = fakeRunner({
      "package.json": out(`{"packageManager":"bun@1","scripts":{"test":"vitest"}}`),
    });

    const result = await discoverPlan(runner, request());

    expect(result.outcome).toBe("refused");
    expect(reason(result)).toContain("will not execute");
  });

  it("never takes a script name out of the manifest", async () => {
    // The keys of `scripts` are attacker-adjacent; the arguments must come from this module's own table.
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
    // Split on newlines instead and this one path becomes two, the second named by whoever wrote the file.
    const runner = fakeRunner({ diff: out(`src/we\nird.ts${NUL}package.json${NUL}`) });

    expect(await unverifiableChanges(runner, request())).toEqual(["package.json"]);
    expect(runner.calls[0]).toContain("-z");
  });

  it("reports inability to tell, rather than an empty list", async () => {
    // An empty list means "nothing was tainted"; a failed diff means "unknown" and must not be read as the former.
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
    // Discovery from the base isn't enough alone: the package manager reads the manifest on disk, so an edited one would grade the run by rules it wrote.
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
    // Nothing was verified, so there is nothing to have failed; calling this `failed` would blame the solver for the network.
    const runner = fakeRunner({ diff: out(""), install: bad() });

    const result = await verify(runner, request());

    expect(result.outcome).toBe("refused");
    expect(reason(result)).toContain("no step ran");
  });

  it("quotes what the install actually said", async () => {
    // The install's own output is quoted here rather than left only in `results`, which this
    // branch's early return would otherwise discard.
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

    // diff, two manifest reads, install, then three warm steps.
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

/** A base whose only manifest is a POM; `package.json` is answered absent explicitly since the default world is Node. */
const mavenRunner = (replies: Record<string, CommandResult> = {}): ReturnType<typeof fakeRunner> =>
  fakeRunner({ "package.json": ABSENT, "pom.xml": out(POM), ...replies });

describe("the Maven toolchain", () => {
  it("plans one cold test step and no install", async () => {
    const result = await discoverPlan(mavenRunner(), request());

    expect(result.outcome === "planned" ? result.plan : null).toEqual({
      // No install phase at all: `mvn test` resolves its own dependencies.
      install: null,
      steps: [
        { name: "test", argv: ["mvn", "-B", "-Dmaven.gitcommitid.skip=true", "test"], cold: true },
      ],
      toolchain: "maven",
      note: expect.stringContaining("-Dmaven.gitcommitid.skip=true") as unknown as string,
    });
  });

  it("skips git stamping, which cannot read a worktree", async () => {
    // `git-commit-id-plugin` binds to `initialize`, so without this the build dies before compiling anything.
    const result = await discoverPlan(mavenRunner(), request());
    const argv = result.outcome === "planned" ? (result.plan.steps[0]?.argv ?? []) : [];

    expect(argv).toContain("-Dmaven.gitcommitid.skip=true");
  });

  it("passes it as a property, never as a flag", async () => {
    // Maven ignores a user property no plugin claims; an unrecognised flag would instead exit non-zero and be reported as `failed`.
    const result = await discoverPlan(mavenRunner(), request());
    const argv = result.outcome === "planned" ? (result.plan.steps[0]?.argv ?? []) : [];

    for (const arg of argv.slice(1, -1)) {
      expect(arg === "-B" || arg.startsWith("-D")).toBe(true);
    }
  });

  it("says in the reason that it did not run the repository's own build", async () => {
    // The accepted cost, made visible where it's acted on — a reviewer trusting a red Maven run needs to know it wasn't the real build.
    const result = await verify(mavenRunner({ diff: out(""), "-B": bad(1) }), request());

    expect(reason(result)).toContain("-Dmaven.gitcommitid.skip=true");
  });

  it("does not claim a wrapper was skipped as though one existed", async () => {
    // A repository with no `mvnw` must not be told one "is deliberately not executed" — that sends an operator looking for a file that isn't there.
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
    // Mirrors the test above; catches a toolchain dispatch that fell through to Maven on an unrecognised manifest.
    const runner = fakeRunner({ diff: out("") });

    await verify(runner, request());

    expect(runner.calls.map((argv) => argv[0])).not.toContain("mvn");
  });

  it("charges the cold step the install budget, not the step budget", async () => {
    // A first Java build downloads the world; on the step budget it would time out and print the machine's cold cache as a verdict on the change.
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
    // Without this probe, a missing tool makes `mvn -B test` exit non-zero and a harness with no Java installed reports every Java fix as broken.
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
    // Two build systems disagree about what passing means; resolving that into a choice would make the verdict a property of read order.
    const runner = fakeRunner({ "pom.xml": out(POM) });

    const result = await discoverPlan(runner, request());

    expect(result.outcome).toBe("refused");
    expect(reason(result)).toContain("choosing one would be a guess");
    expect(runner.calls.map((argv) => argv[0])).not.toContain("mvn");
  });

  it("carries the wrapper note into a failed Maven run", async () => {
    // The cold step is also the install, so there's no install refusal to hang the "mvnw was not executed" hint on otherwise.
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
    // `verify`'s `failed` means "the change is bad", true only if these same steps pass without the change.
    const check = await verifyBase(fakeRunner({ diff: out(""), "run test": bad(1) }), request());

    expect(check.outcome).toBe("unusable");
  });

  it("blames the repository, not the fix, in the reason it gives", async () => {
    // The wording is the point: this reason is posted to a Jira ticket, and a reader taking it as a verdict on their bug goes looking for nothing.
    const check = await verifyBase(fakeRunner({ diff: out(""), "run test": bad(1) }), request());
    const said = check.outcome === "unusable" ? check.reason : "";

    expect(said).toContain("the repository's own build");
    expect(said).toContain("before anything was changed");
    expect(said).toContain("not about any fix");
    // The subject has to be the repository — swapping in "the change" leaves every phrase above intact but reverses what the sentence says.
    expect(said).not.toContain("the change");
  });

  it("keeps a refusal apart from a red base", async () => {
    // Both are unusable but different repairs: one is a build to fix, the other a harness that couldn't run one.
    const check = await verifyBase(fakeRunner({ show: ABSENT }), request());
    const said = check.outcome === "unusable" ? check.reason : "";

    expect(said).toContain("could not be run here at all");
    expect(said).not.toContain("does not pass");
  });

  it("hands the whole verification back, not just a sentence", async () => {
    // A human needs the step that died; reducing this to a string here would discard it at the only point it exists.
    const check = await verifyBase(fakeRunner({ diff: out(""), "run lint": bad(1) }), request());

    expect(check.outcome === "unusable" ? check.verification.outcome : "").toBe("failed");
  });

  it("runs the same steps the real check will", async () => {
    // If the base were verified with a cheaper plan, its green wouldn't license anything.
    const baseRunner = fakeRunner({ diff: out("") });
    const laterRunner = fakeRunner({ diff: out("") });

    await verifyBase(baseRunner, request());
    await verify(laterRunner, request());

    expect(baseRunner.calls).toEqual(laterRunner.calls);
  });
});

/** The fail-first experiment: the solve worktree is read and never written to, and the probe checkout is always removed. */
const TREE = "b".repeat(40);

const ff = (overrides: Partial<FailFirstRequest> = {}): FailFirstRequest => ({
  repoPath: "/repos/advisor",
  worktreePath: "/tmp/solve/SSX-3833",
  probePath: "/tmp/solve/SSX-3833-failfirst",
  baseRef: "origin/main",
  changedPaths: ["src/utils/DateUtils.ts", "src/utils/tests/DateUtils.test.ts"],
  stepTimeoutMs: 120_000,
  installTimeoutMs: 300_000,
  ...overrides,
});

describe("checkFailFirst", () => {
  /** A world where every command works and the probe's suite goes red. */
  const world = (replies: Record<string, CommandResult> = {}) =>
    fakeRunner({ "write-tree": out(`${TREE}\n`), "run test": bad(1), ...replies });

  describe("what counts as a test", () => {
    it("recognises the shapes the pilot repositories actually use", () => {
      expect(isTestPath("src/utils/tests/DateUtils.test.ts")).toBe(true);
      expect(isTestPath("src/x.spec.tsx")).toBe(true);
      expect(isTestPath("src/__tests__/x.ts")).toBe(true);
      expect(isTestPath("src/test/java/com/x/XTest.java")).toBe(true);
      expect(isTestPath("src/utils/DateUtils.ts")).toBe(false);
      // Not a test despite the word: the extension rule is anchored on a dot.
      expect(isTestPath("src/latest.ts")).toBe(false);
    });
  });

  it("says nothing when the run wrote no test", async () => {
    const runner = world();
    const result = await checkFailFirst(runner, ff({ changedPaths: ["src/utils/DateUtils.ts"] }));

    expect(result.outcome).toBe("skipped");
    // And it gave up before spending anything — a skipped experiment that still cuts a checkout is the cost without the finding.
    expect(runner.calls).toEqual([]);
  });

  it("says nothing when the run wrote only tests", async () => {
    const runner = world();
    const result = await checkFailFirst(
      runner,
      ff({ changedPaths: ["src/utils/tests/DateUtils.test.ts"] }),
    );

    expect(result.outcome).toBe("skipped");
    expect(runner.calls).toEqual([]);
  });

  it("reports the tests as vacuous when they pass without the fix", async () => {
    const result = await checkFailFirst(world({ "run test": OK }), ff());

    expect(result).toEqual({
      outcome: "vacuous",
      tests: ["src/utils/tests/DateUtils.test.ts"],
    });
  });

  it("reports them as guarded when they go red without it", async () => {
    const result = await checkFailFirst(world(), ff());

    expect(result.outcome).toBe("guarded");
  });

  it("reads a timed-out suite as red rather than as green", async () => {
    // The same reading `verify` gives the same event; treating a timeout as a pass would print "vacuous" off the back of no result at all.
    const result = await checkFailFirst(world({ "run test": TIMEOUT }), ff());

    expect(result.outcome).toBe("guarded");
  });

  it("lays only the tests onto the base, never the fix", async () => {
    // The experiment is the fix being absent; checking the source files out too would make every run report `vacuous`.
    const runner = world();
    await checkFailFirst(runner, ff());

    const laid = runner.calls.find((argv) => argv.includes("checkout")) ?? [];
    expect(laid).toContain("src/utils/tests/DateUtils.test.ts");
    expect(laid).not.toContain("src/utils/DateUtils.ts");
  });

  it("never writes to the solve worktree", async () => {
    // At this point the solve worktree holds a verified, uncommitted change, so only the two reads that take a save point may touch it.
    const runner = world();
    await checkFailFirst(runner, ff());

    const touched = runner.calls.filter((argv) => argv.includes("/tmp/solve/SSX-3833"));
    expect(touched).toEqual([
      [
        "git",
        "-C",
        "/tmp/solve/SSX-3833",
        "add",
        "--",
        "src/utils/DateUtils.ts",
        "src/utils/tests/DateUtils.test.ts",
      ],
      ["git", "-C", "/tmp/solve/SSX-3833", "write-tree"],
    ]);
  });

  it("refuses a tree that is not an object id", async () => {
    // `write-tree`'s output becomes an argument to `git checkout`, so it's checked as a whole object id rather than merely found inside the output.
    const result = await checkFailFirst(world({ "write-tree": out("HEAD\n") }), ff());

    expect(result.outcome).toBe("inconclusive");
  });

  it("gives up without cutting anything when the save point fails", async () => {
    const runner = world({ "write-tree": bad(128) });
    const result = await checkFailFirst(runner, ff());

    expect(result.outcome).toBe("inconclusive");
    expect(runner.calls.some((argv) => argv.includes("add") && argv.includes("--detach"))).toBe(
      false,
    );
  });

  it("reports the checkout it could not cut, and does not go on to test", async () => {
    const runner = world({ "--detach": bad(128) });
    const result = await checkFailFirst(runner, ff());

    expect(result.outcome).toBe("inconclusive");
    expect(runner.calls.some((argv) => argv.join(" ").includes("run test"))).toBe(false);
  });

  it("is inconclusive rather than vacuous when the tests will not lay down", async () => {
    // A deleted test file lands here: it's not in the tree, so the checkout refuses; running the base suite anyway would print `vacuous` falsely.
    const runner = world({ checkout: bad(1) });
    const result = await checkFailFirst(runner, ff());

    expect(result.outcome).toBe("inconclusive");
    expect(runner.calls.some((argv) => argv.join(" ").includes("run test"))).toBe(false);
  });

  it("is inconclusive when the probe cannot install", async () => {
    const result = await checkFailFirst(world({ "install --frozen-lockfile": bad(1) }), ff());

    expect(result.outcome).toBe("inconclusive");
  });

  it("removes the probe checkout on every path that created one", async () => {
    // Including the ones that gave up: a leaked worktree collides with the next run of the same ticket.
    for (const replies of [
      {},
      { "run test": OK },
      { checkout: bad(1) },
      { "install --frozen-lockfile": bad(1) },
    ]) {
      const runner = world(replies);
      await checkFailFirst(runner, ff());

      expect(
        runner.calls.filter((argv) => argv.join(" ").includes("worktree remove --force")),
      ).toHaveLength(1);
    }
  });

  it("does not let a failed cleanup swallow the finding", async () => {
    // The finding is about the change, a leftover directory is about this machine — a `finally` that returns would trade one for the other by accident.
    const result = await checkFailFirst(world({ "run test": OK, "worktree remove": bad(1) }), ff());

    expect(result.outcome).toBe("vacuous");
  });
});
