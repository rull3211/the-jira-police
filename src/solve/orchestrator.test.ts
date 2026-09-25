import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Pass, SolveRunOptions } from "./runner.ts";
import { parseFix, parseRecon, parseSimplify } from "./runner.ts";
import {
  type ConflictRoundRequest,
  PLAN_REFUSED_REASON,
  type PassRunner,
  type SolveDependencies,
  type SolveRequest,
  resolveConflict,
  resolveReview,
  runReconOnly,
  runRepairRound,
  solveTicket,
  solveWithRetry,
} from "./orchestrator.ts";
import { createLogger } from "../logger.ts";
import type { CommandResult, CommandRunner, Worktree } from "./worktree.ts";
import type { VerificationResult } from "./verify.ts";

/** The escape, not the byte, so this file stays greppable. See `verify.ts`. */
const NUL = "\u0000";

const MANIFEST = JSON.stringify({
  packageManager: "pnpm@11.20.0",
  scripts: { "check-types": "tsc --noEmit", lint: "oxlint", test: "vitest run" },
});

const FILES = ["src/app/head.tsx", "src/app/head.test.tsx"];
const NUMSTAT = [`12\t3\t${FILES[0] ?? ""}`, `9\t0\t${FILES[1] ?? ""}`, ""].join(NUL);

/** A real unified patch, kept visibly unlike `NUMSTAT` so a test can tell which read a call site made. */
const PATCH = [
  `diff --git a/${FILES[0] ?? ""} b/${FILES[0] ?? ""}`,
  "@@ -1,3 +1,4 @@",
  " export function Head() {",
  '+  return <link rel="icon" href="/favicon-nonprod.svg" />;',
  "}",
  "",
].join("\n");

/** A diff the gate refuses — a forbidden path (the lockfile), not a size cap, since these tests are about behavior around a refusal. */
const REFUSED_DIFF = ["1\t0\tsrc/app.ts", "8\t2\tpnpm-lock.yaml", ""].join(NUL);

/** A one-dependency POM; the rules below answer every command `judgeBumps` runs about it. */
const POM_LINES = [
  "<project>",
  "  <properties>",
  "    <x.version>1.0</x.version>",
  "  </properties>",
  "  <dependencies>",
  "    <dependency>",
  "      <groupId>g</groupId>",
  "      <artifactId>a</artifactId>",
  "      <version>${x.version}</version>",
  "    </dependency>",
  "  </dependencies>",
  "</project>",
];

/** The pom.xml and a source file changed, and git's whole-file diff of the pom with one line replaced. */
function pomRules(line: string, replacement: string): readonly Rule[] {
  const diff = [
    "diff --git a/pom.xml b/pom.xml",
    "index 1111111..2222222 100644",
    "--- a/pom.xml",
    "+++ b/pom.xml",
    `@@ -1,${String(POM_LINES.length)} +1,${String(POM_LINES.length)} @@`,
    ...POM_LINES.flatMap((each) =>
      each === line ? [`-${each}`, `+${replacement}`] : [` ${each}`],
    ),
    "",
  ].join("\n");
  return [
    { match: (argv) => argv.some((arg) => arg.startsWith("--unified=")), reply: { stdout: diff } },
    { match: saw("ls-tree"), reply: { stdout: `pom.xml${NUL}` } },
    {
      match: saw("--numstat"),
      reply: { stdout: ["1\t1\tpom.xml", "3\t0\tsrc/app/head.tsx", ""].join(NUL) },
    },
    // After the base check, which runs on a worktree nothing has touched yet.
    {
      match: afterBase(saw("--name-only")),
      reply: { stdout: `pom.xml${NUL}src/app/head.tsx${NUL}` },
    },
  ];
}

// Functions, not constants: `saw` is declared further down and is not initialised at this line.
const bumped = (): readonly Rule[] =>
  pomRules("    <x.version>1.0</x.version>", "    <x.version>1.1</x.version>");
const notABump = (): readonly Rule[] =>
  pomRules("      <artifactId>a</artifactId>", "      <artifactId>b</artifactId>");

const recon = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  proceed: true,
  confidence: "high",
  rootCause: "the favicon link element is absent from the document head",
  devLensAccurate: true,
  devLensCorrection: "",
  plannedFiles: ["src/app/head.tsx"],
  approach: "add the link element",
  testPlan: "assert the head contains the link",
  estimatedLines: 12,
  bailReason: "",
  bailBlockers: [],
  bailRemedy: "",
  injectionNoticed: "",
  ...overrides,
});

const fix = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  changed: true,
  filesTouched: FILES,
  summary: "add the favicon link element to the document head",
  commitSubject: "fix(advisor): add missing favicon link",
  commitBody: "The head component never rendered a link element.",
  testAdded: true,
  testOmittedReason: "",
  residualRisk: "",
  abandoned: "",
  abandonedCause: "none",
  ...overrides,
});

const simplify = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  changed: false,
  filesTouched: [],
  changes: [],
  declined: "the diff is two lines and already reads plainly",
  ...overrides,
});

const review = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  changed: true,
  filesTouched: FILES,
  responses: ["moved the link into the existing fragment, as suggested"],
  threadAnswers: [],
  summary: "address the reviewer's note about the fragment",
  commitSubject: "fix(advisor): move the favicon link into the head fragment",
  commitBody: "The reviewer pointed out the extra wrapper element.",
  unresolved: "",
  abandoned: "",
  injectionNoticed: "",
  widened: [],
  silent: [],
  ...overrides,
});

interface Rule {
  readonly match: (argv: readonly string[]) => boolean;
  /** Omitted when `throws` is set — the command never gets as far as answering. */
  readonly reply?: Partial<CommandResult>;
  /** The command rejects rather than exiting non-zero — the only kind of throw that escapes `runPipeline` and reaches `solveTicket`'s `finally`. */
  readonly throws?: string;
}

const OK: CommandResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };

/** Matches on the presence of a flag, so a rule survives an argv reordering. */
const saw =
  (...needles: readonly string[]) =>
  (argv: readonly string[]): boolean =>
    needles.every((needle) => argv.includes(needle));

/** `git show <ref>:pom.xml`, whatever the ref is. */
const SHOWS_POM = (argv: readonly string[]): boolean =>
  argv.includes("show") && argv.some((arg) => arg.endsWith(":pom.xml"));

/** The same match, ignored the first time it fires — lets a rule fail only the post-fix verification run, not the base check too. */
function afterBase(match: (argv: readonly string[]) => boolean) {
  let seenOnce = false;
  return (argv: readonly string[]): boolean => {
    if (!match(argv)) {
      return false;
    }
    if (seenOnce) {
      return true;
    }
    seenOnce = true;
    return false;
  };
}

interface Harness {
  readonly deps: SolveDependencies;
  /** Passes and commands interleaved, so ordering assertions are about order. */
  readonly timeline: readonly string[];
  readonly calls: readonly (readonly string[])[];
  /** How many passes had run when `calls[i]` was made; lets staging tests exclude the base check, since it runs at zero. */
  readonly passesBefore: readonly number[];
  readonly seen: readonly { readonly pass: Pass; readonly options: SolveRunOptions }[];
}

/**
 * A whole pipeline with no model and no shell.
 *
 * A pass with no scripted output throws — the assertion mechanism for every
 * "and then it stops" test, since proving a pass never ran is about privilege
 * in a way that proving the outcome says so is not.
 */
function harness(
  script: Partial<Record<Pass, unknown>>,
  rules: readonly Rule[] = [],
  /** Passes whose `run` rejects, i.e. a `SOLVE_TIMEOUT_MS` expiry — distinct from an unscripted pass, which means "must not have run" rather than "ran and died". */
  dies: Partial<Record<Pass, string>> = {},
): { readonly h: Harness } {
  const timeline: string[] = [];
  const calls: (readonly string[])[] = [];
  const passesBefore: number[] = [];
  const seen: { pass: Pass; options: SolveRunOptions }[] = [];

  const defaults: readonly Rule[] = [
    // The pilot repo is a Node one; answering every `git show` with the manifest would put both toolchains in the base.
    { match: SHOWS_POM, reply: { exitCode: 128 } },
    { match: saw("show"), reply: { stdout: MANIFEST } },
    { match: saw("--name-only"), reply: { stdout: "" } },
    { match: saw("--numstat"), reply: { stdout: NUMSTAT } },
    // The patch read; must answer differently from the numstat rule above or the two are indistinguishable here.
    {
      match: (argv) => argv.includes("diff") && !argv.includes("--numstat"),
      reply: { stdout: PATCH },
    },
  ];
  const all = [...rules, ...defaults];

  const commands: CommandRunner = {
    run: (argv) => {
      calls.push([...argv]);
      passesBefore.push(seen.length);
      timeline.push(
        `cmd:${argv.slice(0, 2).join(" ")}${argv.includes("--numstat") ? " numstat" : ""}`,
      );
      const rule = all.find((candidate) => candidate.match(argv));
      if (rule?.throws !== undefined) {
        return Promise.reject(new Error(rule.throws));
      }
      return Promise.resolve({ ...OK, ...rule?.reply });
    },
  };

  const passes: PassRunner = {
    run: (pass, options, parse) => {
      timeline.push(`pass:${pass}`);
      seen.push({ pass, options });
      const death = dies[pass];
      if (death !== undefined) {
        return Promise.reject(new Error(death));
      }
      const output = script[pass];
      if (output === undefined) {
        throw new Error(`the ${pass} pass ran, and this test says it must not have`);
      }
      return Promise.resolve(parse(output));
    },
  };

  return { h: { deps: { commands, passes }, timeline, calls, passesBefore, seen } };
}

const request: SolveRequest = {
  issueKey: "SSX-3822",
  ticket: "Favicon is missing on the advisor page",
  summary: "Favicon is missing on the advisor page",
  repoPath: "/repos/buy-insurance-advisor-web",
  parentDirectory: "/tmp/solve",
  baseRef: "origin/main",
  identity: { name: "jira-police", email: "jira-police@example.invalid" },
  gitTimeoutMs: 30_000,
  stepTimeoutMs: 300_000,
  installTimeoutMs: 600_000,
};

const worktree: Worktree = {
  issueKey: "SSX-3822",
  path: "/tmp/solve/SSX-3822",
  branch: "fix/ssx-3822-favicon-is-missing-on-the-advisor-page",
  repoPath: "/repos/buy-insurance-advisor-web",
};

const FULL = { recon: recon(), fix: fix(), simplify: simplify() };

describe("solveTicket, on the happy path", () => {
  it("runs the three passes in order and verifies after all of them", async () => {
    const { h } = harness(FULL);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome.kind).toBe("verified");
    expect(h.timeline.filter((entry) => entry.startsWith("pass:"))).toEqual([
      "pass:recon",
      "pass:fix",
      "pass:simplify",
    ]);
  });

  it("puts staged images on every pass's options, since they share one base", async () => {
    // Deliberate, not an oversight: `runner.ts`'s `buildSolvePrompt` and
    // `buildSolveArgs` are what withhold the block and the `--add-dir` from
    // `fix` and `simplify`, gated on the pass name — this only proves that
    // `runPipeline` builds one `base` and does not also filter it, which is
    // the wiring notes' own reason the gate could not live here instead.
    const { h } = harness(FULL);
    const images = { block: "This ticket has 1 image(s).", directory: "/tmp/img" };

    await solveTicket(h.deps, { ...request, images });

    expect(h.seen.map((entry) => entry.options.images)).toEqual([images, images, images]);
  });

  it("reads the diff for the gate after simplify has finished", async () => {
    // The bound is on what is on disk, not on what the last model said it did.
    // Reading it before simplify would leave that pass's edits unbounded.
    const { h } = harness(FULL);

    await solveTicket(h.deps, request);

    const lastNumstat = h.timeline.lastIndexOf("cmd:git -C numstat");
    expect(lastNumstat).toBeGreaterThan(h.timeline.indexOf("pass:simplify"));
  });

  it("reports the gate's own file and line counts, not the model's", async () => {
    // fix() claims two files; the numstat is the source of truth for both.
    const { h } = harness(FULL);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome).toMatchObject({ kind: "verified", files: 2, lines: 24 });
  });

  it("composes the commit message from the fix report, with the issue trailer", async () => {
    const { h } = harness(FULL);

    const outcome = await solveTicket(h.deps, request);

    if (outcome.kind !== "verified") {
      throw new Error(`expected verified, got ${outcome.kind}`);
    }
    expect(outcome.commit.subject).toBe("fix(advisor): add missing favicon link");
    expect(outcome.commit.body.split("\n").at(-1)).toBe("Refs: SSX-3822");
  });

  it("carries the dev-lens verdict out, so triage's blind call can be scored", async () => {
    const { h } = harness({
      ...FULL,
      recon: recon({ devLensAccurate: false, devLensCorrection: "the fault is in layout.tsx" }),
    });

    const outcome = await solveTicket(h.deps, request);

    expect(outcome).toMatchObject({
      kind: "verified",
      devLens: { accurate: false, correction: "the fault is in layout.tsx" },
    });
  });
});

describe("solveTicket, when recon declines", () => {
  const bailed = {
    recon: recon({
      proceed: false,
      confidence: "low",
      bailReason: "the component was deleted three commits ago; the ticket describes dead code",
      bailBlockers: ["`Widget.tsx` was removed in `a1b2c3d`; nothing imports it."],
      bailRemedy: "Confirm whether the behaviour moved, and point the ticket at where it went.",
      plannedFiles: [],
      estimatedLines: 0,
      approach: "",
      testPlan: "",
    }),
  };

  it("never starts the fix pass", async () => {
    // The scripted fix pass throws. Reaching it would fail this test loudly.
    const { h } = harness(bailed);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome.kind).toBe("bailed");
    expect(h.seen.map((entry) => entry.pass)).toEqual(["recon"]);
  });

  it("runs no verification, because there is nothing to verify", async () => {
    const { h } = harness(bailed);

    await solveTicket(h.deps, request);

    expect(h.calls.some((argv) => argv[0] === "pnpm")).toBe(false);
  });

  it("returns the bail reason rather than an error", async () => {
    const { h } = harness(bailed);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome).toMatchObject({ kind: "bailed", reason: expect.stringContaining("dead code") });
  });

  it("removes the worktree, because recon cannot have written to it", async () => {
    // The only outcome that cleans up: recon has no Write/Edit, so the checkout is pristine.
    const { h } = harness(bailed);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome.kind === "bailed" ? outcome.cleanup.outcome : null).toBe("removed");
    expect(
      h.calls.some(
        (argv) => argv[0] === "git" && argv.includes("worktree") && argv.includes("remove"),
      ),
    ).toBe(true);
  });

  it("never forces the removal", async () => {
    // `--force` would remove the backstop this path relies on: git refusing when the pristine-checkout assumption is wrong.
    const { h } = harness(bailed);

    await solveTicket(h.deps, request);

    const removal = h.calls.find((argv) => argv.includes("worktree") && argv.includes("remove"));
    expect(removal).toBeDefined();
    expect(removal).not.toContain("--force");
    expect(removal).not.toContain("-f");
  });

  it("keeps the worktree, and says why, when git refuses to remove it", async () => {
    const { h } = harness(bailed, [
      {
        match: (argv) => argv.includes("worktree") && argv.includes("remove"),
        reply: { exitCode: 1, stderr: "contains modified or untracked files" },
      },
    ]);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome.kind).toBe("bailed");
    expect(outcome.kind === "bailed" ? outcome.cleanup.outcome : null).toBe("kept");
    expect(
      outcome.kind === "bailed" && outcome.cleanup.outcome === "kept" ? outcome.cleanup.reason : "",
    ).toContain("uncommitted");
  });

  it("still carries the dev-lens correction, which is the point of bailing", async () => {
    const { h } = harness({
      recon: recon({
        proceed: false,
        confidence: "low",
        bailReason: "the described file does not exist on this branch",
        bailBlockers: ["`src/app/head.tsx` is not on this branch."],
        bailRemedy: "Name the file that owns the document head today.",
        devLensAccurate: false,
        devLensCorrection: "triage named src/app/head.tsx; there is no such file",
        plannedFiles: [],
        estimatedLines: 0,
        approach: "",
        testPlan: "",
      }),
    });

    const outcome = await solveTicket(h.deps, request);

    expect(outcome).toMatchObject({
      kind: "bailed",
      devLens: { accurate: false, correction: expect.stringContaining("no such file") },
    });
  });
});

describe("solveTicket, when recon's plan names a path the gate refuses", () => {
  // Recon said proceed, and one planned file is one the diff gate refuses by name alone.
  const planned = { recon: recon({ plannedFiles: ["src/app/head.tsx", "mvnw"] }) };

  it("never starts the fix pass", async () => {
    // The fix pass is unscripted, so reaching it throws.
    const { h } = harness(planned);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome.kind).toBe("bailed");
    expect(h.seen.map((entry) => entry.pass)).toEqual(["recon"]);
  });

  it("says the harness stopped it, and leaves recon's own verdict as recon gave it", async () => {
    const { h } = harness(planned);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome).toMatchObject({
      kind: "bailed",
      reason: PLAN_REFUSED_REASON,
      refusedPlan: [expect.stringMatching(/^mvnw: /u)],
      recon: { proceed: true, plannedFiles: ["src/app/head.tsx", "mvnw"] },
    });
  });

  it("removes the worktree, since no pass that can write has run", async () => {
    const { h } = harness(planned);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome.kind === "bailed" ? outcome.cleanup.outcome : null).toBe("removed");
  });

  it("stops a plan that names the refused file by its path in the worktree", async () => {
    const { h } = harness({ recon: recon({ plannedFiles: [`${worktree.path}/mvnw`] }) });

    const outcome = await solveTicket(h.deps, request);

    expect(outcome).toMatchObject({
      kind: "bailed",
      refusedPlan: [expect.stringMatching(/^mvnw: /u)],
    });
    expect(h.seen.map((entry) => entry.pass)).toEqual(["recon"]);
  });

  it("keeps recon's own bail when that bail names the refused path, as the instructions ask", async () => {
    // Checking the plan before `proceed` is read, or regardless of it, would replace recon's reason with the harness's.
    const { h } = harness({
      recon: recon({
        proceed: false,
        bailReason: "the build needs a newer Maven wrapper, and mvnw is refused",
        bailBlockers: ["The wrapper pins Maven 3.6."],
        bailRemedy: "Update the wrapper on main, then re-run.",
        plannedFiles: ["mvnw"],
      }),
    });

    const outcome = await solveTicket(h.deps, request);

    expect(outcome).toMatchObject({
      kind: "bailed",
      reason: expect.stringContaining("newer Maven wrapper"),
    });
    expect(outcome.kind === "bailed" ? outcome.refusedPlan : "not a bail").toBeUndefined();
  });

  it("leaves refusedPlan unset on a bail recon wrote itself", async () => {
    const { h } = harness({
      recon: recon({
        proceed: false,
        bailReason: "two readings",
        bailBlockers: ["AK1 has two readings."],
        bailRemedy: "Pick one.",
        plannedFiles: [],
      }),
    });

    const outcome = await solveTicket(h.deps, request);

    expect(outcome.kind === "bailed" ? outcome.refusedPlan : "not a bail").toBeUndefined();
  });
});

describe("solveTicket, when the fix pass abandons", () => {
  const given = {
    recon: recon(),
    fix: fix({
      changed: false,
      filesTouched: [],
      commitSubject: "",
      commitBody: "",
      testAdded: false,
      testOmittedReason: "nothing was changed",
      abandoned: "the fix needs a schema migration, which is outside what this may do",
      abandonedCause: "judgement",
    }),
  };

  it("never starts the simplify pass", async () => {
    const { h } = harness(given);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome.kind).toBe("abandoned");
    expect(h.seen.map((entry) => entry.pass)).toEqual(["recon", "fix"]);
  });

  it("runs no verification", async () => {
    const { h } = harness(given);

    await solveTicket(h.deps, request);

    expect(h.calls.some((argv) => argv[0] === "pnpm")).toBe(false);
  });
});

describe("solveTicket, and what each pass is given", () => {
  it("gives recon the ticket and no brief", async () => {
    const { h } = harness(FULL);

    await solveTicket(h.deps, request);

    const first = h.seen[0];
    expect(first?.pass).toBe("recon");
    expect(first?.options.ticket).toBe(request.ticket);
    expect(first?.options.brief).toBeUndefined();
  });

  it("gives fix the recon verdict as its brief", async () => {
    const { h } = harness(FULL);

    await solveTicket(h.deps, request);

    const brief = h.seen.find((entry) => entry.pass === "fix")?.options.brief ?? "";
    expect(JSON.parse(brief)).toMatchObject({ proceed: true, approach: "add the link element" });
  });

  it("gives simplify a real patch and withholds the brief", async () => {
    // Guards against sending simplify the gate's `--numstat -z` format instead of a real patch, which once crashed on a NUL in argv.
    const { h } = harness(FULL);

    await solveTicket(h.deps, request);

    const options = h.seen.find((entry) => entry.pass === "simplify")?.options;
    expect(options?.diff).toBe(PATCH);
    expect(options?.diff).toContain("@@");
    expect(options?.brief).toBeUndefined();
  });

  it("never puts a NUL in front of a pass", async () => {
    // Checked across every field every pass received, so a future field wired to a `-z` read is caught here rather than in production.
    const { h } = harness(FULL);

    await solveTicket(h.deps, request);

    expect(h.seen.length).toBeGreaterThan(0);
    for (const { pass, options } of h.seen) {
      for (const [field, value] of Object.entries(options)) {
        if (typeof value === "string") {
          expect(value, `${pass} pass, ${field}`).not.toContain("\0");
        }
      }
    }
  });

  it("makes files the pass created visible before reading any diff", async () => {
    // `git diff <base>` reports tracked files only, so a pass that creates a file was invisible to every categorical refusal the gate makes.
    const { h } = harness(FULL);

    await solveTicket(h.deps, request);

    // `passesBefore` excludes the base check's own diff, since it runs before any pass and has nothing to stage.
    const staged = h.calls.findIndex((argv) => argv.includes("--intent-to-add"));
    const firstDiff = h.calls.findIndex(
      (argv, index) => argv.includes("diff") && (h.passesBefore[index] ?? 0) > 0,
    );
    expect(staged).toBeGreaterThanOrEqual(0);
    expect(firstDiff).toBeGreaterThanOrEqual(0);
    expect(staged).toBeLessThan(firstDiff);
  });

  it("stages before every diff, not only the first", async () => {
    // A pass can create a file after an earlier read; staging once at the top would miss simplify's new files.
    const { h } = harness(FULL);

    await solveTicket(h.deps, request);

    for (const [index, argv] of h.calls.entries()) {
      if (!argv.includes("diff") || (h.passesBefore[index] ?? 0) === 0) {
        continue;
      }
      const preceding = h.calls.slice(0, index);
      expect(
        preceding.some((earlier) => earlier.includes("--intent-to-add")),
        `the diff at call ${String(index)} was not preceded by a staging call`,
      ).toBe(true);
    }
  });

  it("refuses when it cannot stage, rather than reading a partial diff", async () => {
    // Falling back would report "nothing else changed" about a change it could not see.
    const { h } = harness(FULL, [{ match: saw("--intent-to-add"), reply: { exitCode: 128 } }]);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.stage).toBe("diff-gate");
    }
  });

  it.each([
    [
      "recon",
      {
        recon: recon({
          proceed: false,
          bailReason: "the dev lens names a dead file",
          bailBlockers: ["The named file was deleted three commits ago."],
          bailRemedy: "Point the ticket at the module that replaced it.",
        }),
      },
    ],
    [
      "fix",
      {
        ...FULL,
        fix: fix({ abandoned: "the config contradicts the ticket", abandonedCause: "judgement" }),
      },
    ],
  ] as const)("logs why the %s pass gave up", async (pass, script) => {
    // THE ONE THAT MATTERS about a bail, and it was missing entirely. A bail is
    // the most informative thing a solve produces — triage cannot read source,
    // so this is the first time anything with the code in front of it has had
    // an opinion — and the reason was returned to a caller that prints a
    // one-word outcome. Both real bails so far were diagnosed by reading a
    // stack trace, because the sentence explaining them reached nobody.
    const info = vi.spyOn(createLogger("solve"), "info").mockImplementation(() => {});
    const { h } = harness(script);

    await solveTicket(h.deps, request);

    expect(info).toHaveBeenCalledWith(
      "solve.abandoned",
      expect.objectContaining({ pass, reason: expect.stringMatching(/\S/u) }),
    );
    info.mockRestore();
  });

  it("says whether an abandoned run left files behind", async () => {
    // Changes what a human does next: debris in the worktree needs looking at,
    // a clean bail does not. Only representable at all since the coherence rule
    // forbidding "abandoned and changed" was corrected — see `parseFix`.
    const info = vi.spyOn(createLogger("solve"), "info").mockImplementation(() => {});
    const { h } = harness({
      ...FULL,
      fix: fix({
        abandoned: "thought better of it",
        abandonedCause: "judgement",
        changed: true,
      }),
    });

    await solveTicket(h.deps, request);

    expect(info).toHaveBeenCalledWith(
      "solve.abandoned",
      expect.objectContaining({ leftFiles: true }),
    );
    info.mockRestore();
  });

  it("logs that the write pass ran, since it is the one that spends the privilege", async () => {
    const info = vi.spyOn(createLogger("solve"), "info").mockImplementation(() => {});
    const { h } = harness(FULL);

    await solveTicket(h.deps, request);

    expect(info).toHaveBeenCalledWith(
      "solve.fix",
      expect.objectContaining({ issueKey: "SSX-3822", changed: true, files: FILES.length }),
    );
    info.mockRestore();
  });

  it("keeps model-claimed file paths out of the fix log", async () => {
    // `filesTouched` is model-authored text from an editable ticket; the log carries only the count, and the gate keeps the paths.
    const info = vi.spyOn(createLogger("solve"), "info").mockImplementation(() => {});
    const { h } = harness(FULL);

    await solveTicket(h.deps, request);

    const logged = info.mock.calls.find(([event]) => event === "solve.fix")?.[1];
    expect(JSON.stringify(logged)).not.toContain(FILES[0] ?? "");
    info.mockRestore();
  });

  it("still reads the numstat for the gate, not the patch", async () => {
    // A unified patch would make `parseNumstat` return nothing, and an empty file list passes every cap.
    const { h } = harness(FULL);

    await solveTicket(h.deps, request);

    const gateReads = h.calls.filter((argv) => argv.includes("diff") && argv.includes("--numstat"));
    expect(gateReads.length).toBeGreaterThan(0);
    for (const argv of gateReads) {
      expect(argv).toContain("-z");
    }
  });

  it("points every pass at the worktree, never at the repository", async () => {
    const { h } = harness(FULL);

    await solveTicket(h.deps, request);

    for (const entry of h.seen) {
      expect(entry.options.worktreePath).toBe(worktree.path);
      expect(entry.options.worktreePath).not.toBe(request.repoPath);
    }
  });

  it("refuses a simplify pass that strayed outside the fix's files", async () => {
    // Becomes an outcome rather than a throw, since the caller holds a worktree and an uncaught throw would leak it.
    const { h } = harness({
      ...FULL,
      simplify: simplify({
        changed: true,
        filesTouched: ["src/unrelated.ts"],
        changes: ["renamed a variable"],
        declined: "",
      }),
    });

    const outcome = await solveTicket(h.deps, request);

    expect(outcome.kind).toBe("crashed");
    expect(outcome.kind === "crashed" ? outcome.pass : null).toBe("simplify");
    // The parser's complaint survives rather than being flattened to "a pass died".
    expect(outcome.kind === "crashed" ? outcome.reason : "").toContain("unrelated.ts");
  });

  it("turns a pass that times out into an outcome, not a throw", async () => {
    const { h } = harness({}, [], { recon: "pass timed out after 900000ms" });

    const outcome = await solveTicket(h.deps, request);

    expect(outcome.kind).toBe("crashed");
    expect(outcome.kind === "crashed" ? outcome.pass : null).toBe("recon");
    expect(outcome.kind === "crashed" ? outcome.reason : "").toContain("timed out");
  });

  it("does not run the fix pass after recon dies", async () => {
    // `crashed` means no verdict was reached; if fix ran anyway the worktree would be edited despite that claim.
    const { h } = harness({ fix: fix() }, [], { recon: "pass timed out after 900000ms" });

    await solveTicket(h.deps, request);

    expect(h.seen.map(({ pass }) => pass)).toEqual(["recon"]);
  });

  it("carries no dev lens off a crashed run", async () => {
    // Recon produces the lens, so a run that lost recon has no reading to report.
    const { h } = harness({}, [], { recon: "pass timed out" });

    const outcome = await solveTicket(h.deps, request);

    expect(outcome).not.toHaveProperty("devLens");
  });
});

describe("solveTicket, and a dependency version bump", () => {
  const bumpsOn: SolveRequest = { ...request, dependencyBumps: true };

  it("runs the fix pass for a plan naming pom.xml, and verifies a bump with the bump on the outcome", async () => {
    const { h } = harness(
      { ...FULL, recon: recon({ plannedFiles: ["pom.xml", "src/app/head.tsx"] }) },
      bumped(),
    );

    const outcome = await solveTicket(h.deps, bumpsOn);

    expect(outcome).toMatchObject({
      kind: "verified",
      bumps: [
        { path: "pom.xml", property: "x.version", dependencies: ["g:a"], from: "1.0", to: "1.1" },
      ],
    });
  });

  it("refuses at the gate a pom.xml change that is not a bump, and says why", async () => {
    const { h } = harness(FULL, notABump());

    const outcome = await solveTicket(h.deps, bumpsOn);

    expect(outcome).toMatchObject({
      kind: "refused",
      stage: "diff-gate",
      reasons: [expect.stringContaining("more than a dependency version or a comment")],
    });
  });

  it("with DEPENDENCY_BUMPS off, stops a plan naming pom.xml before the fix pass", async () => {
    const { h } = harness({ recon: recon({ plannedFiles: ["pom.xml"] }) }, bumped());

    const outcome = await solveTicket(h.deps, { ...request, dependencyBumps: false });

    expect(outcome).toMatchObject({
      kind: "bailed",
      refusedPlan: [expect.stringMatching(/^pom\.xml: /u)],
    });
    expect(h.seen.map((entry) => entry.pass)).toEqual(["recon"]);
  });

  it("with DEPENDENCY_BUMPS unset, refuses a real bump at the gate without asking the judge", async () => {
    // Unset in the request means off: only wiring.ts sets it, from a setting that defaults on.
    const { h } = harness(FULL, bumped());

    const outcome = await solveTicket(h.deps, request);

    expect(outcome).toMatchObject({ kind: "refused", stage: "diff-gate" });
    expect(h.calls.some((argv) => argv.some((arg) => arg.startsWith("--unified=")))).toBe(false);
  });
});

describe("solveTicket, at the diff gate", () => {
  it("refuses rather than guessing when the diff cannot be read", async () => {
    const { h } = harness(FULL, [{ match: saw("--numstat"), reply: { exitCode: 128 } }]);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome).toMatchObject({ kind: "refused", stage: "diff-gate" });
  });

  it("does not report an unreadable diff as an empty one", async () => {
    // Both refuse, so asserting only `kind` would pass either way; "the agent changed nothing" needs git to actually say so.
    const unreadable = harness(FULL, [{ match: saw("--numstat"), reply: { exitCode: 128 } }]).h;
    const empty = harness(FULL, [{ match: saw("--numstat"), reply: { stdout: "" } }]).h;

    const first = await solveTicket(unreadable.deps, request);
    const second = await solveTicket(empty.deps, request);

    if (first.kind !== "refused" || second.kind !== "refused") {
      throw new Error("expected both to refuse");
    }
    expect(first.reasons.join()).toContain("could not read the diff");
    expect(second.reasons.join()).toContain("nothing was changed");
    expect(first.reasons).not.toEqual(second.reasons);
  });

  it("refuses a forbidden path and never runs a verification step", async () => {
    const { h } = harness(FULL, [{ match: saw("--numstat"), reply: { stdout: REFUSED_DIFF } }]);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome).toMatchObject({ kind: "refused", stage: "diff-gate" });
    expect(h.calls.some((argv) => argv[0] === "pnpm")).toBe(false);
  });

  it("does not refuse a wide diff, which is the cap's absence seen from here", async () => {
    // `checkDiff` accepts this; this proves nothing between here and there reintroduced a bound of its own.
    const wide = [
      ...Array.from({ length: 30 }, (_unused, index) => `50\t50\tsrc/f${String(index)}.ts`),
      "",
    ].join(NUL);
    const { h } = harness(FULL, [{ match: saw("--numstat"), reply: { stdout: wide } }]);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome.kind).not.toBe("refused");
  });

  it("reports refusal reasons, since a human has to judge them", async () => {
    const { h } = harness(FULL, [{ match: saw("--numstat"), reply: { stdout: REFUSED_DIFF } }]);

    const outcome = await solveTicket(h.deps, request);

    if (outcome.kind !== "refused") {
      throw new Error(`expected refused, got ${outcome.kind}`);
    }
    expect(outcome.reasons.length).toBeGreaterThan(0);
  });
});

describe("solveTicket, at the base check", () => {
  it("stops before any pass when the repository's own build is red", async () => {
    // The harness throws on an unscripted pass, so passing `{}` asserts recon never ran.
    const { h } = harness({}, [{ match: saw("run", "test"), reply: { exitCode: 1 } }]);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome.kind).toBe("unusable-base");
    expect(h.seen).toHaveLength(0);
  });

  it("keeps the worktree, because the worktree is the difference", async () => {
    // Unlike a bail, not cleaned up: the failure only reproduces in the linked checkout a tidy-up would delete.
    const { h } = harness({}, [{ match: saw("run", "test"), reply: { exitCode: 1 } }]);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome).toMatchObject({ kind: "unusable-base", worktree: { path: worktree.path } });
    expect(h.calls.some((argv) => argv.includes("worktree") && argv.includes("remove"))).toBe(
      false,
    );
  });

  it("runs before the fix, not after it", async () => {
    const { h } = harness(FULL);

    await solveTicket(h.deps, request);

    const firstBuild = h.timeline.findIndex(
      (entry) => entry.startsWith("cmd:") && !entry.startsWith("cmd:git"),
    );
    const firstPass = h.timeline.findIndex((entry) => entry.startsWith("pass:"));
    expect(firstBuild).toBeGreaterThanOrEqual(0);
    expect(firstBuild).toBeLessThan(firstPass);
  });
});

describe("solveTicket, at verification", () => {
  it("returns failed — a fact about the code — when a step does not pass", async () => {
    // `afterBase`, so the base's own test run passes — otherwise this is not a fact about the code.
    const { h } = harness(FULL, [{ match: afterBase(saw("run", "test")), reply: { exitCode: 1 } }]);

    // `repairRound: false` keeps this about the verification verdict alone — and the pass list is
    // asserted because an unscripted `repair` cannot announce itself: `runPass` eats the throw.
    const outcome = await solveTicket(h.deps, { ...request, repairRound: false });

    expect(outcome.kind).toBe("failed");
    expect(h.seen.map((entry) => entry.pass)).toEqual(["recon", "fix", "simplify"]);
  });

  it("returns refused — not failed — when the harness could not form a verdict", async () => {
    // Install dying verifies nothing; `failed` would blame the change for evidence never gathered.
    const { h } = harness(FULL, [{ match: afterBase(saw("install")), reply: { exitCode: 1 } }]);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome).toMatchObject({ kind: "refused", stage: "verification" });
  });

  it("keeps a manifest edit a refusal, not a failure", async () => {
    const { h } = harness(FULL, [
      // Manifest only looks touched on the second read, matching what really happens.
      { match: afterBase(saw("--name-only")), reply: { stdout: `package.json${NUL}` } },
    ]);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome).toMatchObject({ kind: "refused", stage: "verification" });
  });

  it("carries the dev-lens verdict out of a refusal too", async () => {
    const { h } = harness(
      { ...FULL, recon: recon({ devLensAccurate: false, devLensCorrection: "wrong file" }) },
      [{ match: saw("--numstat"), reply: { stdout: REFUSED_DIFF } }],
    );

    const outcome = await solveTicket(h.deps, request);

    expect(outcome).toMatchObject({ devLens: { accurate: false, correction: "wrong file" } });
  });
});

describe("solveTicket, and the branch rule", () => {
  it("refuses a protected branch prefix before any session starts", async () => {
    const { h } = harness({});

    const outcome = await solveTicket(h.deps, { ...request, branchPrefix: "main" });

    expect(outcome.kind).toBe("no-worktree");
    expect(h.seen).toEqual([]);
  });

  it.each(["main", "master", "release", "develop", "hotfix"])(
    "refuses the %s prefix",
    async (prefix) => {
      const { h } = harness({});

      const outcome = await solveTicket(h.deps, { ...request, branchPrefix: prefix });

      expect(outcome.kind).toBe("no-worktree");
    },
  );

  it("accepts feat, so an Oppgave is not branched as a fix", async () => {
    const { h } = harness(FULL);

    const outcome = await solveTicket(h.deps, { ...request, branchPrefix: "feat" });

    expect(outcome.kind).toBe("verified");
    expect(h.calls.some((argv) => argv.some((arg) => arg.startsWith("feat/ssx-3822-")))).toBe(true);
  });
});

/** The commands only `checkFailFirst` issues, and nothing else in the run. */
const probeCalls = (calls: readonly (readonly string[])[]) =>
  calls.filter((argv) => argv.includes("write-tree") || argv.includes("--detach"));

describe("solveTicket, and the fail-first experiment", () => {
  it("runs it by default, because nobody has to remember to ask for it", async () => {
    // The opposite default from every other switch on a solve, since this grants no privilege and writes nothing.
    const { h } = harness(FULL);

    const outcome = await solveTicket(h.deps, request);

    expect(probeCalls(h.calls).length).toBeGreaterThan(0);
    expect(outcome).toMatchObject({ kind: "verified" });
  });

  it("spends nothing at all when it is switched off", async () => {
    const { h } = harness(FULL);

    const outcome = await solveTicket(h.deps, { ...request, failFirstCheck: false });

    expect(probeCalls(h.calls)).toEqual([]);
    expect(outcome).toMatchObject({
      kind: "verified",
      failFirst: { outcome: "skipped" },
    });
  });

  it("still publishes when the experiment cannot run", async () => {
    // A report, never a refusal: a fix does not become wrong because the harness could not take its tests apart.
    const { h } = harness(FULL);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome.kind).toBe("verified");
  });
});

/** The escape guard's own read, keyed on `-uall` rather than `status` since `worktree.ts` asks a different question with the same command prefix. */
const snapshots = (calls: readonly (readonly string[])[]) =>
  calls.filter((argv) => argv.includes("status") && argv.includes("-uall"));

/** Which checkout each snapshot was of, in the order they were taken. */
const snapshotted = (calls: readonly (readonly string[])[]) =>
  snapshots(calls).map((argv) => argv[argv.indexOf("-C") + 1] ?? "");

const READ_DIRS = ["/git/commerce-rest-api", "/git/insurance-knowledge-vault"];

/** A request that watches all three kinds of directory the guard knows about. */
const watchedRequest: SolveRequest = {
  ...request,
  vaultPath: "/git/insurance-knowledge-vault",
  readDirs: READ_DIRS,
};

describe("solveTicket, and the write-escape guard", () => {
  it("reads every watched checkout before the run and again after it", async () => {
    // The vault yields one entry even though it's implicitly `--add-dir`'d on every pass; counting it twice would double every comparison for no gain.
    const { h } = harness(FULL);

    await solveTicket(h.deps, watchedRequest);

    const dirs = [request.repoPath, "/git/insurance-knowledge-vault", "/git/commerce-rest-api"];
    expect(snapshotted(h.calls)).toEqual([...dirs, ...dirs]);
  });

  it("does not watch the worktree it is there to bound", async () => {
    // Snapshotting the worktree would report every solve as an escape.
    const { h } = harness(FULL);

    await solveTicket(h.deps, watchedRequest);

    expect(snapshotted(h.calls)).not.toContain(worktree.path);
  });

  it("withholds a verified change when a watched checkout moved under it", async () => {
    // `diff-gate` only reads inside the worktree, so a write to a sibling checkout is invisible to it without this guard.
    const { h } = harness(FULL, [
      {
        match: afterBase((argv) => argv.includes("-uall") && argv.includes(READ_DIRS[0] ?? "")),
        reply: { stdout: " M src/main/java/Cart.java\n" },
      },
    ]);

    const outcome = await solveTicket(h.deps, watchedRequest);

    expect(outcome).toMatchObject({
      kind: "escaped",
      paths: [READ_DIRS[0]],
      would: "verified",
    });
  });

  it("keeps the withheld verdict rather than replacing it with silence", async () => {
    // `would` stops the escape from erasing the run; without it a bare "something moved" sends an operator looking in the wrong place.
    const { h } = harness(
      {
        recon: recon({
          proceed: false,
          confidence: "low",
          bailReason: "the component was deleted three commits ago",
          bailBlockers: ["`Widget.tsx` was removed in `a1b2c3d`; nothing imports it."],
          bailRemedy: "Confirm whether the behaviour moved, and say where it went.",
          plannedFiles: [],
          estimatedLines: 0,
          approach: "",
          testPlan: "",
        }),
      },
      [
        {
          match: afterBase((argv) => argv.includes("-uall") && argv.includes(READ_DIRS[0] ?? "")),
          reply: { stdout: " M src/main/java/Cart.java\n" },
        },
      ],
    );

    const outcome = await solveTicket(h.deps, watchedRequest);

    expect(outcome).toMatchObject({ kind: "escaped", would: "bailed" });
  });

  it("does not override an outcome that has no worktree to report", async () => {
    // `escaped` carries a worktree; `no-worktree` is the one kind with none, so converting it would have to invent one.
    const { h } = harness({}, [
      {
        match: afterBase((argv) => argv.includes("-uall")),
        reply: { stdout: " M src/main/java/Cart.java\n" },
      },
    ]);

    const outcome = await solveTicket(h.deps, { ...watchedRequest, branchPrefix: "main" });

    expect(outcome.kind).toBe("no-worktree");
  });

  it("publishes as normal when nothing outside the worktree moved", async () => {
    const { h } = harness(FULL);

    const outcome = await solveTicket(h.deps, watchedRequest);

    expect(outcome.kind).toBe("verified");
  });

  it("reads a checkout it cannot read as changed, not as clean", async () => {
    // A failed `git status` is the guard going blind; reading that as "no change" would report success on exactly the failures an escape causes.
    const { h } = harness(FULL, [
      {
        match: afterBase((argv) => argv.includes("-uall") && argv.includes(READ_DIRS[0] ?? "")),
        reply: { exitCode: 128, stderr: "not a git repository" },
      },
    ]);

    const outcome = await solveTicket(h.deps, watchedRequest);

    expect(outcome).toMatchObject({ kind: "escaped", paths: [READ_DIRS[0]] });
  });
});

const reviewRequest = {
  ...request,
  worktree,
  reviewFeedback: "Copilot: the wrapper element looks unnecessary here.",
  memberToken: "a1b2c3d4e5f6",
  members: new Set<string>(),
  silenceable: [] as readonly string[],
};

/** The pre-round read `boundWidening` makes: the pull request's own commits, not the worktree. */
const PULL_REQUEST_DIFF = (argv: readonly string[]): boolean =>
  argv.includes("--numstat") && argv.some((arg) => arg.endsWith("...HEAD"));

const widening = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  path: FILES[0] ?? "",
  requestedBy: "comment 2",
  what: "dropped the five exports nothing imports",
  ...overrides,
});

describe("resolveReview", () => {
  it("passes the reviewer's comments in and withholds the brief", async () => {
    const { h } = harness({ review: review() });

    await resolveReview(h.deps, reviewRequest);

    const options = h.seen[0]?.options;
    expect(options?.reviewFeedback).toBe(reviewRequest.reviewFeedback);
    expect(options?.brief).toBeUndefined();
  });

  it("runs no simplify pass — the reviewer is the second opinion", async () => {
    // A simplify pass here would edit the diff between the comment and the re-read, so the reviewer would no longer be reviewing what they saw.
    const { h } = harness({ review: review() });

    await resolveReview(h.deps, reviewRequest);

    expect(h.seen.map((entry) => entry.pass)).toEqual(["review"]);
  });

  it("treats a questions-only round as no-change and re-verifies nothing", async () => {
    const { h } = harness({
      review: review({
        changed: false,
        filesTouched: [],
        commitSubject: "",
        commitBody: "",
        responses: ["the null check is unreachable because the caller guarantees a value"],
      }),
    });

    const outcome = await resolveReview(h.deps, reviewRequest);

    expect(outcome.kind).toBe("no-change");
    expect(h.calls.some((argv) => argv[0] === "pnpm")).toBe(false);
  });

  it("re-verifies when the round changed code", async () => {
    const { h } = harness({ review: review() });

    const outcome = await resolveReview(h.deps, reviewRequest);

    expect(outcome.kind).toBe("resolved");
    // Matched on the tail rather than fixed indices: a declared
    // `packageManager` puts `corepack <pm>@<version>` in front of `run`, so
    // position-keyed assertions here break for a reason unrelated to the claim.
    expect(h.calls.some((argv) => argv.slice(-2).join(" ") === "run test")).toBe(true);
  });

  it("abandons the round rather than crashing when the review pass dies", async () => {
    // The one place a dead pass is deliberately not `crashed`: a pull request already exists, so the reason must survive as a reply rather than a log line.
    const { h } = harness({}, [], { review: "pass timed out after 900000ms" });

    const outcome = await resolveReview(h.deps, reviewRequest);

    expect(outcome.kind).toBe("abandoned");
    expect(outcome.kind === "abandoned" ? outcome.reason : "").toContain("timed out");
  });

  it("gates the whole cumulative diff, not just the round's increment", async () => {
    // The reviewer is looking at the cumulative diff, so that is what must be clean: a lockfile anywhere in it is a problem whichever round put it there.
    const { h } = harness({ review: review() }, [
      { match: saw("--numstat"), reply: { stdout: REFUSED_DIFF } },
    ]);

    const outcome = await resolveReview(h.deps, reviewRequest);

    expect(outcome).toMatchObject({ kind: "refused", stage: "diff-gate" });
  });

  it("does not refuse a round on a pull request that already carries a dependency bump", async () => {
    // The gate reads the cumulative diff, so a bump from the first round is in every later one.
    const { h } = harness({ review: review() }, bumped());

    const outcome = await resolveReview(h.deps, { ...reviewRequest, dependencyBumps: true });

    expect(outcome.kind).not.toBe("refused");
  });

  it("refuses that same round when DEPENDENCY_BUMPS is off", async () => {
    const { h } = harness({ review: review() }, bumped());

    const outcome = await resolveReview(h.deps, reviewRequest);

    expect(outcome).toMatchObject({ kind: "refused", stage: "diff-gate" });
  });

  it("returns failed when the round breaks a test", async () => {
    const { h } = harness({ review: review() }, [
      { match: saw("run", "test"), reply: { exitCode: 1 } },
    ]);

    const outcome = await resolveReview(h.deps, reviewRequest);

    expect(outcome.kind).toBe("failed");
  });

  it("returns abandoned without touching the worktree further", async () => {
    const { h } = harness({
      review: review({
        changed: false,
        filesTouched: [],
        commitSubject: "",
        commitBody: "",
        responses: ["I cannot do this without changing the API"],
        abandoned: "the reviewer is asking for a breaking change",
      }),
    });

    const outcome = await resolveReview(h.deps, reviewRequest);

    expect(outcome).toMatchObject({ kind: "abandoned" });
    // Excludes the escape guard's own reads of other checkouts, never of the worktree, which is the property under test.
    expect(h.calls.filter((argv) => !argv.includes("-uall"))).toEqual([]);
  });

  it("builds the round's own commit message, with the trailer", async () => {
    const { h } = harness({ review: review() });

    const outcome = await resolveReview(h.deps, reviewRequest);

    if (outcome.kind !== "resolved") {
      throw new Error(`expected resolved, got ${outcome.kind}`);
    }
    expect(outcome.commit.subject).toBe(
      "fix(advisor): move the favicon link into the head fragment",
    );
    expect(outcome.commit.body.split("\n").at(-1)).toBe("Refs: SSX-3822");
  });

  it("carries the reviewer's unresolved note into the commit body", async () => {
    // `residualRisk` in the fix pass, `unresolved` here — both end up in `git log` as what was left open.
    const { h } = harness({
      review: review({ unresolved: "comment 3 needs a product decision" }),
    });

    const outcome = await resolveReview(h.deps, reviewRequest);

    expect(outcome.kind).toBe("resolved");
  });

  it("refuses the round when a watched checkout moved under it", async () => {
    // A review round's output goes straight onto a pull request a human is already reading, so an escape here is one step from a merge.
    const { h } = harness({ review: review() }, [
      {
        match: afterBase((argv) => argv.includes("-uall") && argv.includes(READ_DIRS[0] ?? "")),
        reply: { stdout: " M src/main/java/Cart.java\n" },
      },
    ]);

    const outcome = await resolveReview(h.deps, {
      ...reviewRequest,
      readDirs: READ_DIRS,
      vaultPath: "/git/insurance-knowledge-vault",
    });

    expect(outcome).toMatchObject({ kind: "refused", stage: "write-escape" });
    expect(outcome).toMatchObject({ reasons: [expect.stringContaining(READ_DIRS[0] ?? "")] });
  });

  it("resolves as normal when nothing outside the worktree moved", async () => {
    const { h } = harness({ review: review() });

    const outcome = await resolveReview(h.deps, { ...reviewRequest, readDirs: READ_DIRS });

    expect(outcome.kind).toBe("resolved");
  });

  it("names this round's member token to the pass", async () => {
    const { h } = harness({ review: review() });

    await resolveReview(h.deps, reviewRequest);

    expect(h.seen[0]?.options.memberToken).toBe(reviewRequest.memberToken);
  });

  describe("silent, bounded by the round's own list", () => {
    const quiet = { comment: "comment 2", reason: "a thank-you to a colleague" };

    it("hands the pass the comments it may leave unanswered, which its schema is built from", async () => {
      const { h } = harness({ review: review() });

      await resolveReview(h.deps, { ...reviewRequest, silenceable: ["comment 2"] });

      expect(h.seen[0]?.options.silenceable).toEqual(["comment 2"]);
    });

    it("keeps a silence on a comment the list allows", async () => {
      const { h } = harness({ review: review({ silent: [quiet] }) });

      const outcome = await resolveReview(h.deps, { ...reviewRequest, silenceable: ["comment 2"] });

      expect(outcome.kind).toBe("resolved");
    });

    it("discards a round that went silent on a comment the list leaves out — #1462's Copilot review", async () => {
      const { h } = harness({ review: review({ silent: [quiet] }) });

      const outcome = await resolveReview(h.deps, { ...reviewRequest, silenceable: ["comment 1"] });

      expect(outcome).toMatchObject({ kind: "abandoned" });
      expect(outcome.kind === "abandoned" ? outcome.reason : "").toContain("must be answered");
    });
  });

  it("keeps a widening a member asked for, in a file the pull request already changed", async () => {
    const { h } = harness({ review: review({ widened: [widening()] }) });

    const outcome = await resolveReview(h.deps, {
      ...reviewRequest,
      members: new Set(["comment 2"]),
    });

    expect(outcome.kind).toBe("resolved");
    expect(h.calls.some(PULL_REQUEST_DIFF)).toBe(true);
  });

  it("logs each widening it kept, with the file, who asked and what changed", async () => {
    const info = vi.spyOn(createLogger("solve"), "info").mockImplementation(() => {});
    const { h } = harness({ review: review({ widened: [widening()] }) });

    await resolveReview(h.deps, { ...reviewRequest, members: new Set(["comment 2"]) });

    expect(info).toHaveBeenCalledWith(
      "solve.review.widened",
      expect.objectContaining({ widened: [widening()] }),
    );
    info.mockRestore();
  });

  it("refuses a widening cited to a comment no member wrote, before verifying anything", async () => {
    const { h } = harness({ review: review({ widened: [widening()] }) });

    const outcome = await resolveReview(h.deps, reviewRequest);

    expect(outcome).toMatchObject({ kind: "refused", stage: "widening" });
    expect(outcome.kind === "refused" ? outcome.reasons.join(" ") : "").toContain('"comment 2"');
    expect(h.calls.some((argv) => argv.slice(-2).join(" ") === "run test")).toBe(false);
  });

  it("refuses a widening into a file the pull request had not changed, though the round's own diff now has it", async () => {
    // The worktree diff includes the round's edits, so bounding against it would let a member's request reach any file the pass chose to touch.
    const added = "src/api/commerce/unrelated.ts";
    const { h } = harness(
      {
        review: review({
          filesTouched: [...FILES, added],
          widened: [widening({ path: added })],
        }),
      },
      [
        { match: PULL_REQUEST_DIFF, reply: { stdout: NUMSTAT } },
        { match: saw("--numstat"), reply: { stdout: [NUMSTAT, `4\t0\t${added}`, ""].join(NUL) } },
      ],
    );

    const outcome = await resolveReview(h.deps, {
      ...reviewRequest,
      members: new Set(["comment 2"]),
    });

    expect(outcome).toMatchObject({ kind: "refused", stage: "widening" });
    expect(outcome.kind === "refused" ? outcome.reasons.join(" ") : "").toContain(added);
  });

  it("refuses a widening it cannot bound because the pull request's diff would not read", async () => {
    const { h } = harness({ review: review({ widened: [widening()] }) }, [
      { match: PULL_REQUEST_DIFF, reply: { exitCode: 128, stderr: "bad revision" } },
    ]);

    const outcome = await resolveReview(h.deps, {
      ...reviewRequest,
      members: new Set(["comment 2"]),
    });

    expect(outcome).toMatchObject({ kind: "refused", stage: "widening" });
  });

  it("reads nothing extra on a round that widened nothing", async () => {
    const { h } = harness({ review: review() });

    await resolveReview(h.deps, reviewRequest);

    expect(h.calls.some(PULL_REQUEST_DIFF)).toBe(false);
  });
});

/** A pull request whose round also edited `pom.xml`, which the gate refuses whatever the change. */
const POM_REFUSED = [`12\t3\t${FILES[0] ?? ""}`, "1\t1\tpom.xml", ""].join(NUL);

/** The four reads `dropRefusedEdits` makes, answered for a round that edited a file the pull request already had. */
const droppableEdit = (
  overrides: {
    readonly touched?: string;
    readonly existing?: string;
    readonly after?: string;
  } = {},
): readonly Rule[] => [
  { match: once(saw("--numstat")), reply: { stdout: POM_REFUSED } },
  {
    match: (argv) => argv.includes("diff") && argv.includes("--name-only") && argv.includes("HEAD"),
    reply: { stdout: overrides.touched ?? `pom.xml${NUL}${FILES[0] ?? ""}${NUL}` },
  },
  { match: saw("ls-tree"), reply: { stdout: overrides.existing ?? `pom.xml${NUL}` } },
  ...(overrides.after === undefined
    ? []
    : [{ match: saw("--numstat"), reply: { stdout: overrides.after } }]),
];

describe("resolveReview's refused edits, rolled back so the rest can land", () => {
  it("restores the refused file the round edited, and resolves the rest", async () => {
    const { h } = harness({ review: review() }, [...droppableEdit()]);

    const outcome = await resolveReview(h.deps, reviewRequest);

    if (outcome.kind !== "resolved") {
      throw new Error(`expected resolved, got ${outcome.kind}`);
    }
    expect(outcome.dropped).toEqual([
      { path: "pom.xml", reasons: [expect.stringContaining("pom.xml: ") as string] },
    ]);
    expect(h.calls.some((argv) => argv.join(" ").endsWith("checkout HEAD -- pom.xml"))).toBe(true);
    expect(h.calls.some((argv) => argv.slice(-2).join(" ") === "run test")).toBe(true);
    // SSX-3918 #1459 round 5: the pass's message said the pom.xml comment was fixed, and it was not.
    expect(outcome.commit.body).toMatch(/\n\nNot in this commit: pom\.xml\. [^]*\n\nRefs: /u);
  });

  it("names a dropped path that could forge a trailer as a quoted string", async () => {
    const forged = "x\nSigned-off-by: someone/pom.xml";
    const { h } = harness({ review: review() }, [
      {
        match: once(saw("--numstat")),
        reply: { stdout: [`12\t3\t${FILES[0] ?? ""}`, `1\t1\t${forged}`, ""].join(NUL) },
      },
      {
        match: (argv) =>
          argv.includes("diff") && argv.includes("--name-only") && argv.includes("HEAD"),
        reply: { stdout: `${forged}${NUL}${FILES[0] ?? ""}${NUL}` },
      },
      { match: saw("ls-tree"), reply: { stdout: `${forged}${NUL}` } },
    ]);

    const outcome = await resolveReview(h.deps, reviewRequest);

    if (outcome.kind !== "resolved") {
      throw new Error(`expected resolved, got ${outcome.kind}`);
    }
    expect(outcome.commit.body).toContain(`Not in this commit: ${JSON.stringify(forged)}.`);
    expect(outcome.commit.body).not.toMatch(/^Signed-off-by/mu);
  });

  it("refuses the whole round when the pull request already had the refused change", async () => {
    // Rolling back to where the round started would change nothing; the refusal is about the pull request.
    const { h } = harness({ review: review() }, [
      ...droppableEdit({ touched: `${FILES[0] ?? ""}${NUL}` }),
    ]);

    const outcome = await resolveReview(h.deps, reviewRequest);

    expect(outcome).toMatchObject({ kind: "refused", stage: "diff-gate" });
    expect(h.calls.some((argv) => argv.includes("checkout"))).toBe(false);
  });

  it("refuses the whole round when the round created the refused file", async () => {
    const { h } = harness({ review: review() }, [...droppableEdit({ existing: "" })]);

    const outcome = await resolveReview(h.deps, reviewRequest);

    expect(outcome).toMatchObject({ kind: "refused", stage: "diff-gate" });
    expect(h.calls.some((argv) => argv.includes("checkout"))).toBe(false);
  });

  it("refuses the whole round when what is left still fails the gate", async () => {
    const { h } = harness({ review: review() }, [...droppableEdit({ after: REFUSED_DIFF })]);

    const outcome = await resolveReview(h.deps, reviewRequest);

    expect(outcome).toMatchObject({ kind: "refused", stage: "diff-gate" });
  });

  it("drops nothing on a round the gate passed whole", async () => {
    const { h } = harness({ review: review() });

    const outcome = await resolveReview(h.deps, reviewRequest);

    if (outcome.kind !== "resolved") {
      throw new Error(`expected resolved, got ${outcome.kind}`);
    }
    expect(outcome.dropped).toEqual([]);
    expect(h.calls.some((argv) => argv.includes("ls-tree"))).toBe(false);
    expect(outcome.commit.body).not.toContain("Not in this commit");
  });
});

/** Review rounds run no base check, so the first `run test` is the round's own and the second the repair's. */
const reviewRedThenGreen = (): Rule => ({
  match: once(saw("run", "test")),
  reply: { exitCode: 1 },
});

const reviewWorktreeDelta: Rule = {
  match: (argv) =>
    argv.includes("status") && argv.includes(worktree.path) && !argv.includes("-uall"),
  reply: { stdout: " M src/app/head.test.tsx\n" },
};

const reviewRepair = (overrides: Record<string, unknown> = {}) => ({
  changed: true,
  filesTouched: ["src/api/commerce/types.ts"],
  summary: "deleted Address, which the round left declared and unused",
  commitSubject: "fix(commerce-types): delete the interface the cleanup left unused",
  commitBody: "Removing its export left Address unreferenced, which lint refuses.",
  testAdded: false,
  testOmittedReason: "a lint correction",
  residualRisk: "",
  abandoned: "",
  abandonedCause: "none",
  ...overrides,
});

describe("resolveReview's repair round, with a solve's authority", () => {
  it("runs one repair pass on the round's own committed change, and discards a green one unarmed", async () => {
    const { h } = harness({ review: review(), repair: reviewRepair() }, [
      committed(),
      reviewRedThenGreen(),
    ]);

    const outcome = await resolveReview(h.deps, reviewRequest);

    expect(h.seen.map((entry) => entry.pass)).toEqual(["review", "repair"]);
    expect(outcome).toMatchObject({ kind: "failed", repairOutcome: "verified" });
    // The round's own change is the commit under the repair, made before the repair pass ran.
    const commitIndex = h.calls.findIndex((argv) => argv.includes("commit"));
    expect(commitIndex).toBeGreaterThan(-1);
    expect(h.passesBefore[commitIndex]).toBe(1);
    expect(outcome.kind === "failed" ? outcome.verification.outcome : "").toBe("failed");
  });

  it("tells the repair pass what the round was for, in place of a recon brief", async () => {
    const { h } = harness({ review: review(), repair: reviewRepair() }, [
      committed(),
      reviewRedThenGreen(),
    ]);

    await resolveReview(h.deps, reviewRequest);

    const options = h.seen[1]?.options;
    expect(options?.brief).toBeUndefined();
    expect(options?.reviewRound).toContain("address the reviewer's note about the fragment");
    expect(options?.verificationFailure).toContain("test");
  });

  it("buys none with REPAIR_ROUND off", async () => {
    const { h } = harness({ review: review() }, [reviewRedThenGreen()]);

    const outcome = await resolveReview(h.deps, { ...reviewRequest, repairRound: false });

    expect(h.seen.map((entry) => entry.pass)).toEqual(["review"]);
    expect(outcome).toEqual({
      kind: "failed",
      reason: expect.any(String) as string,
      verification: expect.anything() as unknown,
      report: expect.anything() as unknown,
    });
    expect(h.calls.some((argv) => argv.includes("commit"))).toBe(false);
  });

  it("armed, returns a green repair as the resolved round, the repair as its second commit", async () => {
    const { h } = harness({ review: review(), repair: reviewRepair() }, [
      committed(),
      reviewWorktreeDelta,
      reviewRedThenGreen(),
    ]);

    const outcome = await resolveReview(h.deps, { ...reviewRequest, promoteRepair: true });

    if (outcome.kind !== "resolved") {
      throw new Error(`expected resolved, got ${outcome.kind}`);
    }
    expect(outcome.commit.subject).toBe(
      "fix(advisor): move the favicon link into the head fragment",
    );
    expect(outcome.repair?.commit.subject).toBe(
      "fix(commerce-types): delete the interface the cleanup left unused",
    );
    expect(outcome.repair?.failure).toContain("test");
    expect(outcome.verification.outcome).toBe("passed");
  });

  it("armed, keeps a red repair failed on the round's own failure", async () => {
    const { h } = harness({ review: review(), repair: reviewRepair() }, [
      committed(),
      reviewWorktreeDelta,
      { match: saw("run", "test"), reply: { exitCode: 1 } },
    ]);

    const outcome = await resolveReview(h.deps, { ...reviewRequest, promoteRepair: true });

    expect(outcome).toMatchObject({ kind: "failed", repairOutcome: "failed" });
  });

  it("armed, promotes nothing when the round's own change could not be committed underneath", async () => {
    // Promoted, the repair and the round would reach the pull request as one commit under the repair's message.
    const { h } = harness({ review: review(), repair: reviewRepair() }, [
      reviewWorktreeDelta,
      reviewRedThenGreen(),
    ]);

    const outcome = await resolveReview(h.deps, { ...reviewRequest, promoteRepair: true });

    expect(outcome).toMatchObject({ kind: "failed", repairOutcome: "verified" });
  });

  it("records a repair pass that died, rather than reading as no round", async () => {
    const { h } = harness({ review: review() }, [committed(), reviewRedThenGreen()]);

    const outcome = await resolveReview(h.deps, reviewRequest);

    expect(outcome).toMatchObject({ kind: "failed", repairOutcome: "crashed" });
  });
});

/**
 * `runRepairRound`'s own verdicts, reached directly rather than through `runPipeline`.
 *
 * Every one of these is discarded by the only caller there is — the block further down is what
 * pins that. Kept separate because the function has to be right about what it returns before it
 * matters that nobody believes it: phase three is the change that makes these verdicts reachable.
 */
const repair = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  changed: true,
  filesTouched: ["src/app/head.test.tsx"],
  summary: "stop asserting the href the corrected code no longer produces",
  commitSubject: "fix(advisor): correct the head link test for the merged fix",
  commitBody: "The existing test still asserted the pre-fix href.",
  testAdded: false,
  testOmittedReason: "corrected an existing test rather than adding a new one",
  residualRisk: "",
  abandoned: "",
  abandonedCause: "none",
  ...overrides,
});

const FAILED_VERIFICATION: Extract<VerificationResult, { outcome: "failed" }> = {
  outcome: "failed",
  reason: "test did not pass (exit 1)",
  steps: [
    { name: "install", passed: true, exitCode: 0, timedOut: false, output: "" },
    {
      name: "test",
      passed: false,
      exitCode: 1,
      timedOut: false,
      output: "AssertionError: expected favicon-nonprod.svg, got favicon.svg",
    },
  ],
};

const repairBase: SolveRunOptions = {
  issueKey: request.issueKey,
  worktreePath: worktree.path,
  ticket: request.ticket,
};

const devLensFixture = { accurate: true, correction: "" };

const runRepair = (
  h: Harness,
  overrides: {
    recon?: ReturnType<typeof parseRecon>;
    fix?: ReturnType<typeof parseFix>;
    simplify?: ReturnType<typeof parseSimplify>;
    request?: SolveRequest;
  } = {},
) =>
  runRepairRound(
    h.deps,
    overrides.request ?? request,
    worktree,
    repairBase,
    overrides.recon ?? parseRecon(recon(), request.issueKey),
    overrides.fix ?? parseFix(fix(), request.issueKey),
    overrides.simplify ?? parseSimplify(simplify(), request.issueKey, FILES),
    devLensFixture,
    FAILED_VERIFICATION,
  );

describe("runRepairRound", () => {
  it("sends the recon brief and the verification failure, and does not hand it a rendered diff", async () => {
    // No `diff` field: repair re-reads the worktree directly, the same discipline SOLVE_INSTRUCTIONS.md §2 asks of the fix pass.
    const { h } = harness({ repair: repair() });

    await runRepair(h);

    const options = h.seen[0]?.options;
    expect(options?.brief).toContain('"proceed": true');
    expect(options?.verificationFailure).toContain("AssertionError");
    expect(options?.diff).toBeUndefined();
  });

  it("runs exactly one pass: repair", async () => {
    const { h } = harness({ repair: repair() });

    await runRepair(h);

    expect(h.seen.map((entry) => entry.pass)).toEqual(["repair"]);
  });

  it("returns crashed when the repair pass dies", async () => {
    const { h } = harness({}, [], { repair: "pass timed out after 900000ms" });

    const outcome = await runRepair(h);

    expect(outcome).toMatchObject({ kind: "crashed", pass: "repair" });
  });

  it("returns abandoned when the repair pass gives up", async () => {
    const { h } = harness({
      repair: repair({
        changed: false,
        filesTouched: [],
        commitSubject: "",
        commitBody: "",
        abandoned: "the failure is in generated code outside the worktree's own source",
        abandonedCause: "environment",
      }),
    });

    const outcome = await runRepair(h);

    expect(outcome).toMatchObject({ kind: "abandoned", cause: "environment" });
  });

  it("gates the corrected diff before re-verifying", async () => {
    const { h } = harness({ repair: repair() }, [
      { match: saw("--numstat"), reply: { stdout: REFUSED_DIFF } },
    ]);

    const outcome = await runRepair(h);

    expect(outcome).toMatchObject({ kind: "refused", stage: "diff-gate" });
  });

  it("carries a dependency bump through to a green repair's outcome", async () => {
    const { h } = harness({ repair: repair() }, bumped());

    const outcome = await runRepair(h, { request: { ...request, dependencyBumps: true } });

    expect(outcome).toMatchObject({ kind: "verified", bumps: [{ to: "1.1" }] });
  });

  it("returns failed again when the repair still does not pass verification", async () => {
    const { h } = harness({ repair: repair() }, [
      { match: saw("run", "test"), reply: { exitCode: 1 } },
    ]);

    const outcome = await runRepair(h);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") {
      throw new Error(`expected failed, got ${outcome.kind}`);
    }
    // Without this the outcome cannot say a round ran, so a pass that never helps and one that never runs read alike.
    expect(outcome.repair).toEqual(parseFix(repair(), request.issueKey));
  });

  it("crashes rather than proceeding when the round reports no change and no abandonment", async () => {
    // The contradiction is unrepresentable by construction; this pins that, so nobody adds a dead `changed: false` branch downstream.
    const { h } = harness({ repair: repair({ changed: false, filesTouched: [] }) });

    const outcome = await runRepair(h);

    expect(outcome).toMatchObject({ kind: "crashed", pass: "repair" });
    expect(h.calls.some((argv) => argv.includes("--numstat"))).toBe(false);
  });

  it("returns verified, keeping the original fix and simplify reports and carrying the repair", async () => {
    const { h } = harness({ repair: repair() });
    const originalFix = parseFix(fix(), request.issueKey);
    const originalSimplify = parseSimplify(simplify(), request.issueKey, FILES);

    const outcome = await runRepair(h, { fix: originalFix, simplify: originalSimplify });

    expect(outcome.kind).toBe("verified");
    if (outcome.kind !== "verified") {
      throw new Error(`expected verified, got ${outcome.kind}`);
    }
    expect(outcome.fix).toEqual(originalFix);
    expect(outcome.simplify).toEqual(originalSimplify);
    expect(outcome.repair).toEqual(parseFix(repair(), request.issueKey));
  });

  it("builds the repair round's own commit message, with the trailer", async () => {
    const { h } = harness({ repair: repair() });

    const outcome = await runRepair(h);

    if (outcome.kind !== "verified") {
      throw new Error(`expected verified, got ${outcome.kind}`);
    }
    expect(outcome.commit.subject).toBe(
      "fix(advisor): correct the head link test for the merged fix",
    );
    expect(outcome.commit.body.split("\n").at(-1)).toBe("Refs: SSX-3822");
  });
});

/**
 * The round as `runPipeline` actually calls it: run, then disbelieved.
 *
 * Separate from the block above, which exercises `runRepairRound`'s own verdicts. What is under
 * test here is that, on a run not armed with `promoteRepair`, none of those verdicts reaches the
 * caller — the pipeline keeps the report and throws the answer away, so `verified` from the round
 * still leaves the ticket failed.
 */

/** Fails the second `run test` only: the base check passes, the post-fix verification is red, and the repair's re-run is green again. */
const redThenGreen = (): Rule => ({
  match: once(afterBase(saw("run", "test"))),
  reply: { exitCode: 1 },
});

/** Every `run test` after the base check stays red, so the repair does not rescue it either. */
const stayRed = (): Rule => ({
  match: afterBase(saw("run", "test")),
  reply: { exitCode: 1 },
});

/**
 * Red twice, at a different step each time: the post-fix verification stops at `lint`, the
 * repair's re-run gets past it and stops at `test`.
 *
 * Two failures with the same reason cannot tell which one an outcome is quoting, and that is the
 * only thing separating the pre-repair verdict from the round's own. The two rules key on
 * different argv on purpose — `all.find` stops at the first match, so two counters watching one
 * command would starve each other.
 */
const redAtDifferentSteps = (): readonly Rule[] => [
  { match: once(afterBase(saw("run", "lint"))), reply: { exitCode: 1 } },
  { match: afterBase(saw("run", "test")), reply: { exitCode: 1 } },
];

const WITH_REPAIR = { ...FULL, repair: repair() };

describe("the repair round, wired as an untrusted dry run", () => {
  it("runs one repair pass after a failed verification", async () => {
    const { h } = harness(WITH_REPAIR, [stayRed()]);

    await solveTicket(h.deps, request);

    // One, not a loop, armed or not.
    expect(h.seen.map((entry) => entry.pass)).toEqual(["recon", "fix", "simplify", "repair"]);
  });

  it("still fails when the repair re-verifies green, and says the round would have passed", async () => {
    // The whole point of the phase. Nobody has watched this pass work, and `architecture/solve.md` §15 records
    // that green is reachable here by deleting the assertion that failed.
    const { h } = harness(WITH_REPAIR, [redThenGreen()]);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") {
      throw new Error(`expected failed, got ${outcome.kind}`);
    }
    expect(outcome.repairOutcome).toBe("verified");
    expect(outcome.repair).toEqual(parseFix(repair(), request.issueKey));
  });

  it("reports the pre-repair failure, never the round's own re-run", async () => {
    // A `failed` outcome quoting a passing verification is a self-contradiction a reader acts on.
    const { h } = harness(WITH_REPAIR, [redThenGreen()]);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome).toMatchObject({ verification: { outcome: "failed" } });
  });

  it("quotes the first failure's step even when the round fails at a different one", async () => {
    // The green round above cannot catch a wiring that prefers the round's own verification,
    // because a green round has none to prefer. Two reds, told apart by which step stopped them.
    const { h } = harness(WITH_REPAIR, redAtDifferentSteps());

    const outcome = await solveTicket(h.deps, request);

    expect(outcome).toMatchObject({ kind: "failed", repairOutcome: "failed" });
    expect(outcome).toMatchObject({ reason: expect.stringContaining("lint") });
    expect(outcome).not.toMatchObject({ reason: expect.stringContaining("test") });
    // The steps too, not only the reason: a wiring that swaps the whole `verification` over and
    // leaves `reason` alone is the plausible half-change, and `reason` alone cannot see it.
    if (outcome.kind !== "failed" || outcome.verification.outcome !== "failed") {
      throw new Error(`expected a failed verification, got ${outcome.kind}`);
    }
    expect(
      outcome.verification.steps.filter((step) => !step.passed).map((step) => step.name),
    ).toEqual(["lint"]);
  });

  it("keeps the repair's writes in the worktree rather than reverting them", async () => {
    // The decision, pinned: nothing reads a failed worktree, and the round's diff is the only
    // place `architecture/solve.md` §15's dishonest green would be visible. Undoing it would destroy the evidence.
    const { h } = harness(WITH_REPAIR, [redThenGreen()]);

    await solveTicket(h.deps, request);

    // Keyed on the worktree's own path, not on the subcommand alone: `checkFailFirst` legitimately
    // runs `git checkout` inside the probe checkout, whose path is a different argv element.
    const undo = h.calls.filter(
      (argv) =>
        argv.includes(worktree.path) &&
        ["checkout", "restore", "reset", "stash", "clean"].some((verb) => argv.includes(verb)),
    );
    expect(undo).toEqual([]);
  });

  it("carries the report when the repair round fails too", async () => {
    const { h } = harness(WITH_REPAIR, [stayRed()]);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome).toMatchObject({
      kind: "failed",
      repairOutcome: "failed",
      repair: parseFix(repair(), request.issueKey),
    });
  });

  it("says a round ran even when it died before reporting", async () => {
    // The case `repair` alone cannot express, and the reason `repairOutcome` is its own field:
    // a round that crashed carries no `FixReport`, so its absence must not read as "none ran".
    const { h } = harness(WITH_REPAIR, [stayRed()], { repair: "pass timed out after 900000ms" });

    const outcome = await solveTicket(h.deps, request);

    expect(outcome).toMatchObject({ kind: "failed", repairOutcome: "crashed" });
    expect(outcome).not.toHaveProperty("repair");
  });

  it("runs no round at all when REPAIR_ROUND is off", async () => {
    const { h } = harness(WITH_REPAIR, [stayRed()]);

    const outcome = await solveTicket(h.deps, { ...request, repairRound: false });

    expect(h.seen.some((entry) => entry.pass === "repair")).toBe(false);
    // Absent rather than a kind meaning "skipped": the outcome should look exactly as it did
    // before this wiring existed, so an operator who turned it off gets the old artifact back.
    expect(outcome).not.toHaveProperty("repairOutcome");
  });

  it("buys no round on a run that never failed verification", async () => {
    const { h } = harness(WITH_REPAIR);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome.kind).toBe("verified");
    expect(h.seen.some((entry) => entry.pass === "repair")).toBe(false);
  });
});

/** `commitAll`'s own read-back; without a real sha it reports the commit as failed. */
const SHA = "3f9a1c0e8b7d6f5a4c3b2a1908f7e6d5c4b3a291";
const committed = (): Rule => ({
  match: saw("rev-parse", "HEAD"),
  reply: { stdout: `${SHA}\n` },
});

/** Every commit the run made, with how many passes had run when it was made. */
const commits = (h: Harness) =>
  h.calls.flatMap((argv, index) =>
    argv.includes("commit") ? [{ argv, passesBefore: h.passesBefore[index] ?? -1 }] : [],
  );

describe("the commit that separates the fix from the repair round", () => {
  it("commits the fix, under the fix's own message, after it fails and before the repair runs", async () => {
    const { h } = harness(WITH_REPAIR, [committed(), stayRed()]);

    await solveTicket(h.deps, request);

    const made = commits(h);
    expect(made).toHaveLength(1);
    // Recon, fix and simplify before it and the repair after, so the repair's edits are the only
    // uncommitted delta.
    expect(made[0]?.passesBefore).toBe(3);
    expect(h.seen.map((entry) => entry.pass)).toEqual(["recon", "fix", "simplify", "repair"]);
    const argv = made[0]?.argv ?? [];
    expect(argv[argv.indexOf("-C") + 1]).toBe(worktree.path);
    expect(argv).toContain("fix(advisor): add missing favicon link");
    expect(argv).toContain("user.name=jira-police");
  });

  it("makes no commit on a run that verified, which `publish` would then find empty", async () => {
    // The plausible wrong placement — committing after the gate, whatever verification says —
    // leaves every ordinary solve with nothing for `publish` to commit, and no pull request.
    const { h } = harness(WITH_REPAIR, [committed()]);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome.kind).toBe("verified");
    expect(commits(h)).toEqual([]);
  });

  it("makes no commit when REPAIR_ROUND is off, so a failed run looks as it always did", async () => {
    const { h } = harness(WITH_REPAIR, [committed(), stayRed()]);

    await solveTicket(h.deps, { ...request, repairRound: false });

    expect(commits(h)).toEqual([]);
  });

  it("still runs the round when that commit fails — the measurement does not depend on it", async () => {
    // No `committed()` rule: the fake's empty `rev-parse` makes `commitAll` report a failure.
    const { h } = harness(WITH_REPAIR, [stayRed()]);

    const outcome = await solveTicket(h.deps, request);

    expect(commits(h)).toHaveLength(1);
    expect(outcome).toMatchObject({ kind: "failed", repairOutcome: "failed" });
  });
});

const ARMED: SolveRequest = { ...request, promoteRepair: true };

/** The worktree's own `status`, which is what says the round left a delta of its own on top of the fix. */
const worktreeStatus = (reply: Partial<CommandResult>): Rule => ({
  match: (argv) =>
    argv.includes("status") && argv.includes(worktree.path) && !argv.includes("-uall"),
  reply,
});
const REPAIR_LEFT_A_DELTA = worktreeStatus({ stdout: " M src/app/head.test.tsx\n" });

describe("the repair round, promoted by --repair", () => {
  it("returns a green round as the outcome, carrying the repair and the failure it corrected", async () => {
    const { h } = harness(WITH_REPAIR, [committed(), REPAIR_LEFT_A_DELTA, redThenGreen()]);

    const outcome = await solveTicket(h.deps, ARMED);

    expect(outcome.kind).toBe("verified");
    if (outcome.kind !== "verified") {
      throw new Error(`expected verified, got ${outcome.kind}`);
    }
    expect(outcome.repair).toEqual(parseFix(repair(), request.issueKey));
    expect(outcome.repairedFailure).toContain("test");
    // The round's own re-verification, which is green — the pre-repair one belongs to `repairedFailure`.
    expect(outcome.verification.outcome).toBe("passed");
    // What `publish` commits next: the repair, on top of the fix already committed.
    expect(outcome.commit.subject).toBe(
      "fix(advisor): correct the head link test for the merged fix",
    );
    expect(outcome.fix).toEqual(parseFix(fix(), request.issueKey));
  });

  it("leaves a green round failed when the fix could not be committed ahead of it", async () => {
    // Promoting it would ship fix and repair as one commit under the repair's message, which is
    // the blend the separate commit exists to prevent.
    const { h } = harness(WITH_REPAIR, [REPAIR_LEFT_A_DELTA, redThenGreen()]);

    const outcome = await solveTicket(h.deps, ARMED);

    expect(outcome).toMatchObject({ kind: "failed", repairOutcome: "verified" });
  });

  it("leaves a green round failed when it left nothing on top of the fix", async () => {
    // A round that claimed a change and made none, re-verified green by a flaky check: promoted,
    // `publish` would find nothing to commit and report the verified tree as holding no change
    // while the fix sat committed and unpushed.
    const { h } = harness(WITH_REPAIR, [
      committed(),
      worktreeStatus({ stdout: "" }),
      redThenGreen(),
    ]);

    const outcome = await solveTicket(h.deps, ARMED);

    expect(outcome).toMatchObject({ kind: "failed", repairOutcome: "verified" });
  });

  it("leaves a green round failed when what it left cannot be read", async () => {
    const { h } = harness(WITH_REPAIR, [
      committed(),
      worktreeStatus({ exitCode: 128, stderr: "fatal: not a git repository" }),
      redThenGreen(),
    ]);

    const outcome = await solveTicket(h.deps, ARMED);

    expect(outcome).toMatchObject({ kind: "failed", repairOutcome: "verified" });
  });

  it("promotes nothing but a green round: a red one stays the pre-repair failure", async () => {
    // The plausible wrong promotion — returning the round whatever it concluded — would report
    // the round's own failure, at the step it stopped at, in place of the one that sent it there.
    const { h } = harness(WITH_REPAIR, [committed(), ...redAtDifferentSteps()]);

    const outcome = await solveTicket(h.deps, ARMED);

    expect(outcome).toMatchObject({ kind: "failed", repairOutcome: "failed" });
    expect(outcome).toMatchObject({ reason: expect.stringContaining("lint") });
  });

  it("promotes nothing but a green round: a crashed one stays a failed run", async () => {
    const { h } = harness(WITH_REPAIR, [committed(), stayRed()], {
      repair: "pass timed out after 900000ms",
    });

    const outcome = await solveTicket(h.deps, ARMED);

    expect(outcome).toMatchObject({ kind: "failed", repairOutcome: "crashed" });
  });

  it("leaves a green round failed when the run was not armed, and absent is not armed", async () => {
    // Absent first: it is what the daemon sends, and an explicit `false` alone cannot tell
    // `=== true` from a fail-open `!== false` — measured, that mutation survived it.
    for (const unarmed of [request, { ...request, promoteRepair: false }]) {
      // Everything else a promotion needs is present, so arming is the only thing standing in the way.
      const { h } = harness(WITH_REPAIR, [committed(), REPAIR_LEFT_A_DELTA, redThenGreen()]);

      const outcome = await solveTicket(h.deps, unarmed);

      expect(outcome).toMatchObject({ kind: "failed", repairOutcome: "verified" });
    }
  });
});

/**
 * The guards on a round that resolves a merge conflict.
 *
 * The harness believes git's own state, never the pass's report, and every way this round can end badly leaves the checkout exactly as it was found.
 */
const CONFLICTED_FILE = "src/utils/DateUtils.ts";

const merge = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  resolved: true,
  resolutions: [
    {
      path: CONFLICTED_FILE,
      took: "both",
      why: "kept the branch's constructor fix and main's new named export",
    },
  ],
  summary: "merged origin/main, keeping both sides of the date helper",
  abandoned: "",
  injectionNoticed: "",
  ...overrides,
});

/** Matches the first time only, which is how a two-state git read is scripted. */
function once(match: (argv: readonly string[]) => boolean) {
  let spent = false;
  return (argv: readonly string[]): boolean => {
    if (spent || !match(argv)) {
      return false;
    }
    spent = true;
    return true;
  };
}

/**
 * A branch seven commits behind, conflicting in one file, resolved by the pass.
 *
 * The `--diff-filter=U` read answers twice on purpose: the conflict before the pass, empty (resolved) after — a fake answering the same both times would make the gate untestable.
 */
const conflicting = (): readonly Rule[] => [
  { match: saw("rev-list", "--count"), reply: { stdout: "7\n" } },
  { match: saw("merge", "--no-edit"), reply: { exitCode: 1, stderr: "CONFLICT (content)" } },
  { match: once(saw("--diff-filter=U")), reply: { stdout: `${CONFLICTED_FILE}\n` } },
  // `git grep` exits 1 for "nothing found"; the fake's default of exit 0 would read as markers found.
  { match: saw("grep"), reply: { exitCode: 1 } },
];

const conflictRequest: ConflictRoundRequest = {
  ...request,
  worktree,
  identity: { name: "jira-police", email: "jira-police@example.invalid" },
};

/** Every argv the round ran, one string each. */
const ranAll = (h: Harness): string[] => h.calls.map((argv) => argv.join(" "));
const ran = (h: Harness, match: string): boolean => ranAll(h).some((line) => line.includes(match));

describe("resolveConflict", () => {
  it("resolves, verifies, commits and pushes, in that order", async () => {
    const { h } = harness({ merge: merge() }, conflicting());

    const outcome = await resolveConflict(h.deps, conflictRequest);

    expect(outcome).toMatchObject({ kind: "resolved", behind: 7 });
    const lines = ranAll(h);
    const at = (match: string): number => lines.findIndex((line) => line.includes(match));
    // A merge commit that does not build is worse under review than the conflict it replaced.
    expect(at("run test")).toBeLessThan(at("commit --no-edit"));
    expect(at("commit --no-edit")).toBeLessThan(at(`push origin ${worktree.branch}`));
  });

  it("hands the pass git's conflicted paths, and no other pass's input", async () => {
    const { h } = harness({ merge: merge() }, conflicting());

    await resolveConflict(h.deps, conflictRequest);

    const options = h.seen[0]?.options;
    expect(options?.conflict).toContain(CONFLICTED_FILE);
    expect(options?.conflict).toContain("origin/main");
    // A merge is a fact about two histories, not the review; handing it the reviewer's comments would invite it to fix the ticket in a commit that only claims to have merged.
    expect(options?.reviewFeedback).toBeUndefined();
    expect(options?.brief).toBeUndefined();
  });

  it("spends nothing when the branch already contains its base", async () => {
    // No scripted pass: reaching one throws, which is the assertion.
    const { h } = harness({}, [{ match: saw("rev-list", "--count"), reply: { stdout: "0\n" } }]);

    const outcome = await resolveConflict(h.deps, conflictRequest);

    expect(outcome).toEqual({ kind: "current" });
    expect(h.seen).toEqual([]);
  });

  it("pushes a merge that no longer conflicts without paying for a pass", async () => {
    // The base moved between the attach that found the conflict and this round.
    const { h } = harness({}, [{ match: saw("rev-list", "--count"), reply: { stdout: "7\n" } }]);

    const outcome = await resolveConflict(h.deps, conflictRequest);

    expect(outcome).toEqual({ kind: "merged", behind: 7 });
    expect(h.seen).toEqual([]);
    expect(ran(h, `push origin ${worktree.branch}`)).toBe(true);
  });

  it("aborts and abandons when the pass declines to resolve it", async () => {
    const { h } = harness(
      {
        merge: merge({
          resolved: false,
          resolutions: [],
          abandoned: "both sides rewrote the same function and only a human knows which is wanted",
        }),
      },
      conflicting(),
    );

    const outcome = await resolveConflict(h.deps, conflictRequest);

    expect(outcome).toMatchObject({ kind: "abandoned" });
    expect(ran(h, "merge --abort")).toBe(true);
    expect(ran(h, "push")).toBe(false);
  });

  it("refuses a report naming files git never flagged, before touching the tree", async () => {
    const { h } = harness(
      {
        merge: merge({
          resolutions: [
            { path: "src/secrets.ts", took: "branch", why: "kept ours" },
            {
              path: CONFLICTED_FILE,
              took: "both",
              why: "kept the branch's constructor fix and main's named export",
            },
          ],
        }),
      },
      conflicting(),
    );

    const outcome = await resolveConflict(h.deps, conflictRequest);

    expect(outcome).toMatchObject({ kind: "refused" });
    expect(outcome.kind === "refused" ? outcome.reason : "").toContain("src/secrets.ts");
    // Nothing was staged: the report describes a situation git did not, so there is no reason to believe the rest of it.
    expect(ran(h, "add --")).toBe(false);
    expect(ran(h, "merge --abort")).toBe(true);
  });

  it("refuses when a conflict marker survives, whatever the report says", async () => {
    const { h } = harness({ merge: merge() }, [
      // Ahead of `conflicting()`'s own grep rule; the fake takes the first matching rule.
      { match: saw("grep"), reply: { exitCode: 0, stdout: `${CONFLICTED_FILE}:14:<<<<<<< HEAD` } },
      ...conflicting(),
    ]);

    const outcome = await resolveConflict(h.deps, conflictRequest);

    // Markers commit fine and fail most parsers, so verification would usually catch this — not the standard for a branch under review.
    expect(outcome).toMatchObject({ kind: "refused" });
    expect(ran(h, "commit --no-edit")).toBe(false);
    expect(ran(h, "merge --abort")).toBe(true);
  });

  it("refuses when the marker check could not run at all", async () => {
    // `git grep` exits 1 for "nothing found" and 0 for "found something"; anything above 1 is git failing to look, not an answer, and must not read as clean.
    const { h } = harness({ merge: merge() }, [
      { match: saw("grep"), reply: { exitCode: 128, stderr: "fatal: unable to read index" } },
      ...conflicting(),
    ]);

    const outcome = await resolveConflict(h.deps, conflictRequest);

    expect(outcome).toMatchObject({ kind: "refused" });
    expect(ran(h, "commit --no-edit")).toBe(false);
    expect(ran(h, "merge --abort")).toBe(true);
  });

  it("refuses when a path is still unmerged after the pass", async () => {
    // The `--diff-filter=U` read answers the same both times: the file the pass claimed to resolve is still conflicted.
    const { h } = harness({ merge: merge() }, [
      { match: saw("rev-list", "--count"), reply: { stdout: "7\n" } },
      { match: saw("merge", "--no-edit"), reply: { exitCode: 1 } },
      { match: saw("--diff-filter=U"), reply: { stdout: `${CONFLICTED_FILE}\n` } },
      { match: saw("grep"), reply: { exitCode: 1 } },
    ]);

    const outcome = await resolveConflict(h.deps, conflictRequest);

    expect(outcome).toMatchObject({ kind: "refused" });
    expect(outcome.kind === "refused" ? outcome.reason : "").toContain("still unmerged");
    expect(ran(h, "commit --no-edit")).toBe(false);
  });

  it("refuses when the pass changed something the merge did not conflict on", async () => {
    const { h } = harness({ merge: merge() }, [
      ...conflicting(),
      // The unstaged read, which is everything the pass touched outside the
      // paths that were staged as resolved.
      {
        match: (argv) =>
          argv.includes("--name-only") && !argv.includes("--diff-filter=U") && !argv.includes("-z"),
        reply: { stdout: "src/app/head.tsx\n" },
      },
    ]);

    const outcome = await resolveConflict(h.deps, conflictRequest);

    expect(outcome).toMatchObject({ kind: "refused" });
    expect(ran(h, "commit --no-edit")).toBe(false);
    expect(ran(h, "merge --abort")).toBe(true);
  });

  it("refuses when the pass left a new file behind", async () => {
    const { h } = harness({ merge: merge() }, [
      ...conflicting(),
      { match: saw("ls-files", "--others"), reply: { stdout: "src/app/notes.md\n" } },
    ]);

    const outcome = await resolveConflict(h.deps, conflictRequest);

    // Same hole as the diff gate: a bound reading only tracked files bounds nothing, since writing a new one steps past it.
    expect(outcome).toMatchObject({ kind: "refused" });
    expect(ran(h, "commit --no-edit")).toBe(false);
  });

  it("aborts rather than pushing a merge whose tests are red", async () => {
    const { h } = harness({ merge: merge() }, [
      ...conflicting(),
      { match: saw("run", "test"), reply: { exitCode: 1 } },
    ]);

    const outcome = await resolveConflict(h.deps, conflictRequest);

    expect(outcome).toMatchObject({ kind: "failed" });
    expect(ran(h, "push")).toBe(false);
    expect(ran(h, "merge --abort")).toBe(true);
  });

  it("undoes the merge commit when the push fails", async () => {
    const { h } = harness({ merge: merge() }, [
      ...conflicting(),
      { match: saw("push"), reply: { exitCode: 1, stderr: "rejected" } },
    ]);

    const outcome = await resolveConflict(h.deps, conflictRequest);

    // `merge --abort` cannot help once the merge is committed; `ORIG_HEAD` is the only route back.
    expect(outcome).toMatchObject({ kind: "refused" });
    expect(ran(h, "reset --hard ORIG_HEAD")).toBe(true);
  });

  it("stages only the paths git flagged, never everything it finds", async () => {
    const { h } = harness({ merge: merge() }, conflicting());

    await resolveConflict(h.deps, conflictRequest);

    const add = h.calls.find((argv) => argv.includes("add"));
    expect(add?.slice(-2)).toEqual(["--", CONFLICTED_FILE]);
    expect(add).not.toContain("-A");
  });
});

/** The file the `/agent-solve` slash command has to resolve to. */
function entryPoint(root: string): string {
  return join(root, ".claude", "skills", "agent-solve", "SKILL.md");
}

describe("the skill root", () => {
  it("is staged, on disk, before every pass that runs", async () => {
    // Every prompt opens with `/agent-solve <KEY> --<pass>`, which the worktree alone cannot resolve. Checked during the pass, not after, since the root is deleted on the way out.
    const { h } = harness(FULL);
    const staged: boolean[] = [];
    const passes: PassRunner = {
      run: (pass, options, parse) => {
        staged.push(existsSync(entryPoint(options.skillRootPath ?? "")));
        return h.deps.passes.run(pass, options, parse);
      },
    };

    await solveTicket({ ...h.deps, passes }, request);

    expect(staged).toEqual([true, true, true]);
  });

  it("is the same root for all three passes", async () => {
    // Restaging per pass would let `fix` read a different copy than `recon` did.
    const { h } = harness(FULL);
    await solveTicket(h.deps, request);

    const roots = new Set(h.seen.map(({ options }) => options.skillRootPath));
    expect(roots.size).toBe(1);
  });

  it("is removed once the run returns", async () => {
    const { h } = harness(FULL);
    await solveTicket(h.deps, request);

    const root = h.seen[0]?.options.skillRootPath ?? "";
    expect(root).not.toBe("");
    expect(existsSync(root)).toBe(false);
  });

  it("is removed even when the run throws", async () => {
    // Without the `finally`, a crashed run leaves a read-only directory the next run for that ticket cannot overwrite. The throw must come from the shell layer `runPass` does not wrap, after a pass has run, or there is no staged root to check.
    const { h } = harness({ recon: recon(), fix: fix(), simplify: simplify() }, [
      { match: saw("--numstat"), throws: "git died mid-diff" },
    ]);

    await expect(solveTicket(h.deps, request)).rejects.toThrow("git died mid-diff");

    const root = h.seen[0]?.options.skillRootPath ?? "";
    expect(root).not.toBe("");
    expect(existsSync(root)).toBe(false);
  });

  it("does not hand the pass the repository this service lives in", async () => {
    // `--add-dir` grants write to a pass that pre-approves `Write`; the staged root keeps the solver away from its own denylists and diff gate.
    const { h } = harness(FULL);
    await solveTicket(h.deps, request);

    for (const { pass, options } of h.seen) {
      expect(options.skillRootPath ?? "", `the ${pass} pass`).not.toContain("the-jira-police");
    }
  });

  it("reaches the review pass too", async () => {
    const { h } = harness({ review: review() });
    const seen: string[] = [];
    const passes: PassRunner = {
      run: (pass, options, parse) => {
        seen.push(existsSync(entryPoint(options.skillRootPath ?? "")) ? "staged" : "missing");
        return h.deps.passes.run(pass, options, parse);
      },
    };

    await resolveReview({ ...h.deps, passes }, reviewRequest);

    expect(seen).toEqual(["staged"]);
  });
});

describe("solveWithRetry", () => {
  /** A pipeline whose script changes between attempts; the attempt boundary is `recon`, the first pass `runPipeline` runs. */
  function attempts(
    scripts: readonly Partial<Record<Pass, unknown>>[],
    rules: readonly Rule[] = [],
  ): { readonly deps: SolveDependencies; readonly calls: readonly (readonly string[])[] } {
    let index = -1;
    const calls: (readonly string[])[] = [];
    const base = harness({}, rules).h;

    const passes: PassRunner = {
      run: (pass, options, parse) => {
        if (pass === "recon") {
          index += 1;
        }
        const script = scripts[index] ?? {};
        const output = script[pass];
        if (output === undefined) {
          throw new Error(`attempt ${String(index + 1)}: the ${pass} pass must not have run`);
        }
        return Promise.resolve(parse(output));
      },
    };

    const commands: CommandRunner = {
      run: async (argv, options) => {
        calls.push([...argv]);
        return base.deps.commands.run(argv, options);
      },
    };

    return { deps: { commands, passes }, calls };
  }

  const stopped = (cause: "judgement" | "environment"): Partial<Record<Pass, unknown>> => ({
    recon: recon(),
    fix: fix({
      changed: false,
      filesTouched: [],
      commitSubject: "",
      commitBody: "",
      testAdded: false,
      testOmittedReason: "nothing was changed",
      abandoned: cause === "environment" ? "a safety hook denied the write" : "the brief is wrong",
      abandonedCause: cause,
    }),
  });

  it("does not rerun a ticket the model judged", async () => {
    // A verdict is an answer. Asking the same question again costs a second
    // four-pass session and gets the same one.
    const { deps } = attempts([stopped("judgement")]);

    const result = await solveWithRetry(deps, request);

    expect(result.attempts).toBe(1);
    expect(result.outcome).toMatchObject({ kind: "abandoned", cause: "judgement" });
  });

  it("reruns a ticket the machine got in the way of", async () => {
    // The host's own safety hook can deny a write mid-pass non-deterministically; nothing about the ticket itself changed between attempts.
    const { deps } = attempts([stopped("environment"), FULL]);

    const result = await solveWithRetry(deps, request);

    expect(result.attempts).toBe(2);
    expect(result.outcome.kind).toBe("verified");
  });

  it("stops after one retry, however many times the machine gets in the way", async () => {
    // An obstacle surviving a clean retry is not transient; retrying further just turns a blocked host into a bill.
    const { deps } = attempts([stopped("environment"), stopped("environment")]);

    const result = await solveWithRetry(deps, request);

    expect(result.attempts).toBe(2);
    expect(result.outcome).toMatchObject({ kind: "abandoned", cause: "environment" });
  });

  it("clears the first attempt's worktree and branch before cutting a new one", async () => {
    // Both names are derived from the issue key, so a second `worktree add -b`
    // collides with its own predecessor unless both are gone.
    const { deps, calls } = attempts([stopped("environment"), FULL]);

    await solveWithRetry(deps, request);

    const git = calls.filter((argv) => argv.includes("worktree") || argv.includes("branch"));
    // Each add is preceded by the list deciding whether anything of ours is already at the path; here nothing is, so no salvage runs.
    expect(git.map((argv) => argv.slice(3, 5).join(" "))).toEqual([
      "worktree list",
      "worktree add",
      "worktree remove",
      "branch -d",
      "worktree list",
      "worktree add",
    ]);
  });

  it("does not retry when the first attempt's worktree survived", async () => {
    // `git worktree remove` refuses on a dirty checkout, and a dirty checkout
    // means the blocked attempt left work behind. That is evidence, and the
    // retry would have to destroy it to proceed.
    const { deps } = attempts(
      [stopped("environment"), FULL],
      [{ match: saw("worktree", "remove"), reply: { exitCode: 1, stderr: "contains modified" } }],
    );

    const result = await solveWithRetry(deps, request);

    expect(result.attempts).toBe(1);
    expect(result.retryBlocked).toContain("worktree is still there");
  });

  it("does not retry when the first attempt's branch survived", async () => {
    // `branch -d` refuses on unmerged commits — same argument, one layer down,
    // and the case the worktree check alone would miss.
    const { deps } = attempts(
      [stopped("environment"), FULL],
      [{ match: saw("branch", "-d"), reply: { exitCode: 1, stderr: "not fully merged" } }],
    );

    const result = await solveWithRetry(deps, request);

    expect(result.attempts).toBe(1);
    expect(result.retryBlocked).toContain("branch is still there");
  });

  it("leaves every other outcome exactly as it found it", async () => {
    const { deps } = attempts([FULL]);

    const result = await solveWithRetry(deps, request);

    expect(result).toMatchObject({ attempts: 1, retryBlocked: "" });
    expect(result.outcome.kind).toBe("verified");
  });
});

describe("runReconOnly", () => {
  it("never starts the fix pass", async () => {
    // The scripted fix pass throws if reached, same as `solveTicket`'s own
    // "never starts the fix pass" test — this function has no fix pass to
    // reach at all, and a script that only names recon proves it.
    const { h } = harness({ recon: recon() });

    const outcome = await runReconOnly(h.deps, request);

    expect(h.seen.map((entry) => entry.pass)).toEqual(["recon"]);
    expect(outcome.kind).toBe("proceed");
  });

  it("reports the stop the full pipeline would make at a refused plan", async () => {
    const { h } = harness({ recon: recon({ plannedFiles: ["src/app/head.tsx", "mvnw"] }) });

    const outcome = await runReconOnly(h.deps, request);

    expect(outcome).toMatchObject({
      kind: "bailed",
      reason: PLAN_REFUSED_REASON,
      refusedPlan: [expect.stringMatching(/^mvnw: /u)],
      recon: { proceed: true },
    });
    expect(outcome.kind === "bailed" ? outcome.cleanup.outcome : null).toBe("removed");
  });

  it("keeps recon's own bail when that bail names the refused path", async () => {
    const { h } = harness({
      recon: recon({
        proceed: false,
        bailReason: "the build needs a newer Maven wrapper, and mvnw is refused",
        bailBlockers: ["The wrapper pins Maven 3.6."],
        bailRemedy: "Update the wrapper on main, then re-run.",
        plannedFiles: ["mvnw"],
      }),
    });

    const outcome = await runReconOnly(h.deps, request);

    expect(outcome).toMatchObject({
      kind: "bailed",
      reason: expect.stringContaining("newer Maven wrapper"),
    });
    expect(outcome.kind === "bailed" ? outcome.refusedPlan : "not a bail").toBeUndefined();
  });

  it("discards the worktree on proceed, unlike the full pipeline", async () => {
    // `solveTicket` keeps the worktree on `proceed` so `fix` can write to it.
    // There is no `fix` here, so nothing needs the checkout kept.
    const { h } = harness({ recon: recon() });

    const outcome = await runReconOnly(h.deps, request);

    expect(outcome.kind === "proceed" ? outcome.cleanup.outcome : null).toBe("removed");
    expect(
      h.calls.some(
        (argv) => argv[0] === "git" && argv.includes("worktree") && argv.includes("remove"),
      ),
    ).toBe(true);
  });

  it("reports a bail and discards the worktree, same as the full pipeline", async () => {
    const { h } = harness({
      recon: recon({
        proceed: false,
        confidence: "low",
        bailReason: "the component was deleted three commits ago",
        bailBlockers: ["`Widget.tsx` was removed; nothing imports it."],
        bailRemedy: "Confirm whether the behaviour moved.",
        plannedFiles: [],
        estimatedLines: 0,
        approach: "",
        testPlan: "",
      }),
    });

    const outcome = await runReconOnly(h.deps, request);

    expect(outcome).toMatchObject({
      kind: "bailed",
      reason: expect.stringContaining("deleted three commits ago"),
    });
    expect(outcome.kind === "bailed" ? outcome.cleanup.outcome : null).toBe("removed");
  });

  it("keeps the worktree when recon crashes, so a human can see what it saw", async () => {
    const { h } = harness({}, [], { recon: "pass timed out after 900000ms" });

    const outcome = await runReconOnly(h.deps, request);

    expect(outcome.kind).toBe("crashed");
    expect(outcome.kind === "crashed" ? outcome.reason : "").toContain("timed out");
    expect(outcome.kind === "crashed" ? outcome.worktree.path : "").toBe(worktree.path);
    expect(
      h.calls.some(
        (argv) => argv[0] === "git" && argv.includes("worktree") && argv.includes("remove"),
      ),
    ).toBe(false);
  });

  it("never runs verification, because there is nothing to verify", async () => {
    const { h } = harness({ recon: recon() });

    await runReconOnly(h.deps, request);

    expect(h.calls.some((argv) => argv[0] === "pnpm")).toBe(false);
  });

  it("carries staged images onto the recon pass's own options", async () => {
    // `runner.ts`'s own gate does the withholding from other passes; this only
    // proves the plumbing that gets `images` from the request onto `base` at
    // all, which is the half a wiring test can actually see.
    const { h } = harness({ recon: recon() });
    const images = { block: "This ticket has 1 image(s).", directory: "/tmp/img" };

    await runReconOnly(h.deps, { ...request, images });

    expect(h.seen[0]?.options.images).toEqual(images);
  });

  it("leaves recon's options without an images field when none was staged", async () => {
    const { h } = harness({ recon: recon() });

    await runReconOnly(h.deps, request);

    expect(h.seen[0]?.options.images).toBeUndefined();
  });

  it("refuses a protected branch prefix before any pass starts", async () => {
    const { h } = harness({});

    const outcome = await runReconOnly(h.deps, { ...request, branchPrefix: "main" });

    expect(outcome.kind).toBe("no-worktree");
    expect(h.seen).toEqual([]);
  });
});
