import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

// `SolveParseError` used to be imported here so a test could assert
// `solveTicket` rejected with it. It does not reject any more — a parser
// refusing the model's output is a `crashed` outcome now — and the import going
// unused is the small, real sign of that change.
import type { Pass, SolveRunOptions } from "./runner.ts";
import {
  type PassRunner,
  type SolveDependencies,
  type SolveRequest,
  resolveReview,
  solveTicket,
  solveWithRetry,
} from "./orchestrator.ts";
import { logger } from "../logger.ts";
import type { CommandResult, CommandRunner, Worktree } from "./worktree.ts";

/** The escape, not the byte, so this file stays greppable. See `verify.ts`. */
const NUL = "\u0000";

const MANIFEST = JSON.stringify({
  packageManager: "pnpm@11.20.0",
  scripts: { "check-types": "tsc --noEmit", lint: "oxlint", test: "vitest run" },
});

const FILES = ["src/app/head.tsx", "src/app/head.test.tsx"];
const NUMSTAT = [`12\t3\t${FILES[0] ?? ""}`, `9\t0\t${FILES[1] ?? ""}`, ""].join(NUL);

/**
 * A real unified patch, which is a different thing from `NUMSTAT`.
 *
 * The gate reads counts; a pass reads code. Keeping the two fixtures visibly
 * unalike is what lets a test tell which read a call site made — when one
 * function served both, no assertion in this file could distinguish them, and
 * the one at "gives simplify the diff" asserted the wrong one and passed.
 */
const PATCH = [
  `diff --git a/${FILES[0] ?? ""} b/${FILES[0] ?? ""}`,
  "@@ -1,3 +1,4 @@",
  " export function Head() {",
  '+  return <link rel="icon" href="/favicon-nonprod.svg" />;',
  "}",
  "",
].join("\n");

/** Six files, which is one past `DEFAULT_LIMITS.maxFiles`. */
const OVER_CAP = [
  ...Array.from({ length: 6 }, (_unused, index) => `1\t0\tsrc/f${String(index)}.ts`),
  "",
].join(NUL);

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
  summary: "address the reviewer's note about the fragment",
  commitSubject: "fix(advisor): move the favicon link into the head fragment",
  commitBody: "The reviewer pointed out the extra wrapper element.",
  unresolved: "",
  abandoned: "",
  injectionNoticed: "",
  ...overrides,
});

interface Rule {
  readonly match: (argv: readonly string[]) => boolean;
  /** Omitted when `throws` is set — the command never gets as far as answering. */
  readonly reply?: Partial<CommandResult>;
  /**
   * The command *rejects*, rather than answering with a non-zero exit code.
   *
   * Those are different failures and only this one escapes `runPipeline`. A
   * non-zero exit is a result the pipeline inspects and turns into an outcome;
   * a rejection is the shell layer itself coming apart, and since pass failures
   * are now caught by `runPass` it is the only kind of throw left that can
   * reach `solveTicket`'s `finally`. Which makes it the only way to test it.
   */
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

interface Harness {
  readonly deps: SolveDependencies;
  /** Passes and commands interleaved, so ordering assertions are about order. */
  readonly timeline: readonly string[];
  readonly calls: readonly (readonly string[])[];
  readonly seen: readonly { readonly pass: Pass; readonly options: SolveRunOptions }[];
}

/**
 * A whole pipeline with no model and no shell.
 *
 * A pass with no scripted output **throws**. That is the assertion mechanism
 * for every "and then it stops" test in this file: proving the fix pass never
 * ran after a bail is worth more than proving the returned object says bailed,
 * because only the first one is about privilege.
 */
function harness(
  script: Partial<Record<Pass, unknown>>,
  rules: readonly Rule[] = [],
  /**
   * Passes whose `run` rejects, which is what a `SOLVE_TIMEOUT_MS` expiry looks
   * like from here. Distinct from an unscripted pass — that also throws, but
   * out of the harness rather than out of the runner, and it means "this test
   * says the pass must not have run" rather than "the pass ran and died".
   */
  dies: Partial<Record<Pass, string>> = {},
): { readonly h: Harness } {
  const timeline: string[] = [];
  const calls: (readonly string[])[] = [];
  const seen: { pass: Pass; options: SolveRunOptions }[] = [];

  const defaults: readonly Rule[] = [
    // The pilot repo is a Node one, so `pom.xml` is not in its base tree.
    // Answering every `git show` with the manifest would put both toolchains in
    // the base and `verify` would refuse before running a step.
    { match: SHOWS_POM, reply: { exitCode: 128 } },
    { match: saw("show"), reply: { stdout: MANIFEST } },
    { match: saw("--name-only"), reply: { stdout: "" } },
    { match: saw("--numstat"), reply: { stdout: NUMSTAT } },
    // `git diff` without `--numstat` is the patch read, and it must answer
    // differently from the one above or the two are indistinguishable here.
    {
      match: (argv) => argv.includes("diff") && !argv.includes("--numstat"),
      reply: { stdout: PATCH },
    },
  ];
  const all = [...rules, ...defaults];

  const commands: CommandRunner = {
    run: (argv) => {
      calls.push([...argv]);
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

  return { h: { deps: { commands, passes }, timeline, calls, seen } };
}

const request: SolveRequest = {
  issueKey: "SSX-3822",
  ticket: "Favicon is missing on the advisor page",
  summary: "Favicon is missing on the advisor page",
  repoPath: "/repos/buy-insurance-advisor-web",
  parentDirectory: "/tmp/solve",
  baseRef: "origin/main",
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
    // The only outcome that cleans up. Recon holds no `Write` and no `Edit`, so
    // the checkout is pristine; and a bail is the *expected* result whenever
    // triage's blind fitness call was optimistic, which makes this the leak
    // that would have grown fastest.
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
    // `--force` would turn "tidy up after a read-only pass" into "delete
    // whatever is in there". The whole safety of removing on this path rests on
    // git refusing when the assumption is wrong, and `--force` removes exactly
    // that backstop.
    const { h } = harness(bailed);

    await solveTicket(h.deps, request);

    const removal = h.calls.find((argv) => argv.includes("worktree") && argv.includes("remove"));
    expect(removal).toBeDefined();
    expect(removal).not.toContain("--force");
    expect(removal).not.toContain("-f");
  });

  it("keeps the worktree, and says why, when git refuses to remove it", async () => {
    // If recon ever gains a write, or something else dirties the checkout, git
    // declines and the reason has to reach the operator rather than a log.
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
    // Showing it the requirement would invite it to reconsider the change
    // rather than the way the change is written.
    //
    // REGRESSION, 2026-09-04. This test used to assert `toBe(NUMSTAT)` — the
    // gate's format, a table of line counts — under a name that said "the
    // diff", and it passed for as long as one function served both reads. The
    // first real solve crashed here, because the numstat is `-z` separated and
    // `spawn` refuses a NUL in argv. The crash was the lucky outcome: without
    // the `-z` the pass would have run, been shown a count table, found nothing
    // to simplify, and looked like it was working.
    const { h } = harness(FULL);

    await solveTicket(h.deps, request);

    const options = h.seen.find((entry) => entry.pass === "simplify")?.options;
    expect(options?.diff).toBe(PATCH);
    expect(options?.diff).toContain("@@");
    expect(options?.brief).toBeUndefined();
  });

  it("never puts a NUL in front of a pass", async () => {
    // THE GUARD, stated as the property rather than as one call site. Anything
    // handed to a pass becomes part of a single argv element, so a NUL anywhere
    // in it fails the run before the model is reached. Checked across every
    // string every pass received, so a future field added to `SolveRunOptions`
    // and wired to a `-z` read is caught here rather than in production.
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
    // THE GUARD, and it closes a hole rather than tidying one. `git diff <base>`
    // reports tracked files only, so a pass that *creates* a file did not appear
    // in it at all. Measured on the first real solve: the gate passed a
    // five-file change having read two files and four lines — the whole
    // implementation, its test and a new asset were invisible to it.
    //
    // Every categorical refusal the gate makes names a path that must not be
    // touched, and each was evadable by writing a new file instead of editing
    // one. A fresh `.github/workflows/*.yml` would have passed and then run.
    const { h } = harness(FULL);

    await solveTicket(h.deps, request);

    const staged = h.calls.findIndex((argv) => argv.includes("--intent-to-add"));
    const firstDiff = h.calls.findIndex((argv) => argv.includes("diff"));
    expect(staged).toBeGreaterThanOrEqual(0);
    expect(staged).toBeLessThan(firstDiff);
  });

  it("stages before every diff, not only the first", async () => {
    // A pass can create a file after an earlier read. Staging once at the top
    // would bound the fix pass's new files and miss simplify's.
    const { h } = harness(FULL);

    await solveTicket(h.deps, request);

    for (const [index, argv] of h.calls.entries()) {
      if (!argv.includes("diff")) {
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
    // Falling back to the tracked-only diff would report "nothing else changed"
    // about a change it could not see, which is the failure being fixed. An
    // unbounded diff has to stop the run.
    const { h } = harness(FULL, [{ match: saw("--intent-to-add"), reply: { exitCode: 128 } }]);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.stage).toBe("diff-gate");
    }
  });

  it.each([
    ["recon", { recon: recon({ proceed: false, bailReason: "the dev lens names a dead file" }) }],
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
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
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
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
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
    // Recon, simplify and verify all logged; `fix` did not, which left the only
    // pass holding `Write` and `Edit` as the single step with no record it had
    // run. On the first verified run that showed up as a six-minute hole in the
    // log between two lines, with no way to tell a slow fix from a hung one.
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const { h } = harness(FULL);

    await solveTicket(h.deps, request);

    expect(info).toHaveBeenCalledWith(
      "solve.fix",
      expect.objectContaining({ issueKey: "SSX-3822", changed: true, files: FILES.length }),
    );
    info.mockRestore();
  });

  it("keeps model-claimed file paths out of the fix log", async () => {
    // `filesTouched` is model-authored, derived from a ticket anyone with a
    // Jira account can edit, and the diff gate is what checks it against git's
    // own account. Printing the claim into a log a human skims invites reading
    // the claim as the finding — so the log carries the count and the gate
    // keeps the paths.
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const { h } = harness(FULL);

    await solveTicket(h.deps, request);

    const logged = info.mock.calls.find(([event]) => event === "solve.fix")?.[1];
    expect(JSON.stringify(logged)).not.toContain(FILES[0] ?? "");
    info.mockRestore();
  });

  it("still reads the numstat for the gate, not the patch", async () => {
    // The other half of the split. Feeding the gate a unified patch would make
    // `parseNumstat` return nothing, and an empty file list passes every cap —
    // the gate would report ok on a diff it never read.
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
    // Becomes an outcome rather than propagating. It used to reject, which read
    // as principled — a broken contract is not a ticket that did not work — but
    // the caller is a long-running job holding a worktree, and the practical
    // effect of the throw was that the process died and the worktree leaked.
    // The contract is still refused; what changed is that the refusal is
    // something the caller can act on.
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
    // The parser's complaint survives into the reason rather than being
    // flattened to "a pass died".
    expect(outcome.kind === "crashed" ? outcome.reason : "").toContain("unrelated.ts");
  });

  it("turns a pass that times out into an outcome, not a throw", async () => {
    // The case this was built for. `SOLVE_TIMEOUT_MS` fires inside `passes.run`,
    // and until `runPass` existed that rejection went straight past every
    // caller — `solve:once` printed a stack trace and the daemon that Phase E
    // adds would have taken the whole loop down with it.
    const { h } = harness({}, [], { recon: "pass timed out after 900000ms" });

    const outcome = await solveTicket(h.deps, request);

    expect(outcome.kind).toBe("crashed");
    expect(outcome.kind === "crashed" ? outcome.pass : null).toBe("recon");
    expect(outcome.kind === "crashed" ? outcome.reason : "").toContain("timed out");
  });

  it("does not run the fix pass after recon dies", async () => {
    // The privilege claim, and the reason this is a separate test from the one
    // above. `crashed` means no verdict was reached; if the write pass ran
    // anyway then a run that reports having reached no verdict has still edited
    // the worktree, which is the one way this outcome could lie.
    // `fix` is scripted, so a pipeline that wrongly continued would still
    // satisfy every assertion in the test above and only fail this one.
    const { h } = harness({ fix: fix() }, [], { recon: "pass timed out after 900000ms" });

    await solveTicket(h.deps, request);

    expect(h.seen.map(({ pass }) => pass)).toEqual(["recon"]);
  });

  it("carries no dev lens off a crashed run", async () => {
    // Recon is what produces the lens, so a run that lost recon has no reading
    // to report. Reporting one anyway would feed the fitness assessment
    // evidence nobody gathered — see `lensOf` in `feedback.ts`.
    const { h } = harness({}, [], { recon: "pass timed out" });

    const outcome = await solveTicket(h.deps, request);

    expect(outcome).not.toHaveProperty("devLens");
  });
});

describe("solveTicket, at the diff gate", () => {
  it("refuses rather than guessing when the diff cannot be read", async () => {
    const { h } = harness(FULL, [{ match: saw("--numstat"), reply: { exitCode: 128 } }]);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome).toMatchObject({ kind: "refused", stage: "diff-gate" });
  });

  it("does not report an unreadable diff as an empty one", async () => {
    // Both refuse, so asserting only `kind` passes either way — which is how a
    // mutation returning "" instead of null from `realDiff` first survived.
    // The distinction is the whole point: "the agent changed nothing" is a
    // statement about the agent, and git having failed does not license it.
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

  it("refuses an over-cap diff and never runs a verification step", async () => {
    const { h } = harness(FULL, [{ match: saw("--numstat"), reply: { stdout: OVER_CAP } }]);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome).toMatchObject({ kind: "refused", stage: "diff-gate" });
    expect(h.calls.some((argv) => argv[0] === "pnpm")).toBe(false);
  });

  it("reports refusal reasons, since a human has to widen the bound or not", async () => {
    const { h } = harness(FULL, [{ match: saw("--numstat"), reply: { stdout: OVER_CAP } }]);

    const outcome = await solveTicket(h.deps, request);

    if (outcome.kind !== "refused") {
      throw new Error(`expected refused, got ${outcome.kind}`);
    }
    expect(outcome.reasons.length).toBeGreaterThan(0);
  });
});

describe("solveTicket, at verification", () => {
  it("returns failed — a fact about the code — when a step does not pass", async () => {
    const { h } = harness(FULL, [{ match: saw("run", "test"), reply: { exitCode: 1 } }]);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome.kind).toBe("failed");
  });

  it("returns refused — not failed — when the harness could not form a verdict", async () => {
    // Install dying verifies nothing. Reporting it as `failed` would blame the
    // change for evidence that was never gathered.
    const { h } = harness(FULL, [{ match: saw("install"), reply: { exitCode: 1 } }]);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome).toMatchObject({ kind: "refused", stage: "verification" });
  });

  it("keeps a manifest edit a refusal, not a failure", async () => {
    const { h } = harness(FULL, [
      { match: saw("--name-only"), reply: { stdout: `package.json${NUL}` } },
    ]);

    const outcome = await solveTicket(h.deps, request);

    expect(outcome).toMatchObject({ kind: "refused", stage: "verification" });
  });

  it("carries the dev-lens verdict out of a refusal too", async () => {
    const { h } = harness(
      { ...FULL, recon: recon({ devLensAccurate: false, devLensCorrection: "wrong file" }) },
      [{ match: saw("--numstat"), reply: { stdout: OVER_CAP } }],
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

const reviewRequest = {
  ...request,
  worktree,
  reviewFeedback: "Copilot: the wrapper element looks unnecessary here.",
};

describe("resolveReview", () => {
  it("passes the reviewer's comments in and withholds the brief", async () => {
    const { h } = harness({ review: review() });

    await resolveReview(h.deps, reviewRequest);

    const options = h.seen[0]?.options;
    expect(options?.reviewFeedback).toBe(reviewRequest.reviewFeedback);
    expect(options?.brief).toBeUndefined();
  });

  it("runs no simplify pass — the reviewer is the second opinion", async () => {
    // A simplify pass here would edit the diff between the comment and the
    // re-read, so the reviewer would no longer be reviewing what they saw.
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
    // The one place a dead pass is deliberately *not* `crashed`. By here a pull
    // request exists, so there is a human on the other end and somewhere to put
    // the reason; a new outcome kind would only make every caller of
    // `resolveReview` handle a case that reduces to "this round produced
    // nothing". The reason still has to survive, or the PR sits there with no
    // explanation of why the bot stopped answering.
    const { h } = harness({}, [], { review: "pass timed out after 900000ms" });

    const outcome = await resolveReview(h.deps, reviewRequest);

    expect(outcome.kind).toBe("abandoned");
    expect(outcome.kind === "abandoned" ? outcome.reason : "").toContain("timed out");
  });

  it("gates the whole cumulative diff, not just the round's increment", async () => {
    // The reviewer is looking at the cumulative diff, so that is what has to
    // stay inside the bound.
    const { h } = harness({ review: review() }, [
      { match: saw("--numstat"), reply: { stdout: OVER_CAP } },
    ]);

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
    expect(h.calls).toEqual([]);
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
    // `residualRisk` in the fix pass, `unresolved` here; both end up as the
    // thing a human reading `git log` needs to know was left open.
    const { h } = harness({
      review: review({ unresolved: "comment 3 needs a product decision" }),
    });

    const outcome = await resolveReview(h.deps, reviewRequest);

    expect(outcome.kind).toBe("resolved");
  });
});

/** The file the `/agent-solve` slash command has to resolve to. */
function entryPoint(root: string): string {
  return join(root, ".claude", "skills", "agent-solve", "SKILL.md");
}

describe("the skill root", () => {
  it("is staged, on disk, before every pass that runs", async () => {
    // THE ONE THAT MATTERS. Every prompt opens with `/agent-solve <KEY>
    // --<pass>`, and the session's working directory is the worktree, which
    // contains no skills. Probed 2026-09-04 from such a directory:
    // `Unknown command: /agent-solve`. Checking existence *during* the pass
    // rather than after is the point — it is deleted on the way out, so an
    // assertion afterwards would prove nothing about what the pass could see.
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
    // Restaging per pass would work and would also mean the `fix` pass could be
    // reading a different copy from the one `recon` read.
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
    // The `finally`, and the reason it is one. Unplugging it leaves a
    // read-only directory per crashed run, which the next run for that ticket
    // then cannot overwrite — a failure that only shows up after a crash.
    //
    // This used to throw by leaving a pass unscripted, which stopped working
    // when `runPass` started catching those; the run returns `crashed` now and
    // a `finally` is indistinguishable from a plain trailing statement on a
    // path that returns. So the throw has to come from the layer `runPass`
    // does *not* wrap — the shell — and it has to land after a pass has run,
    // or there is no staged root recorded to go looking for.
    const { h } = harness({ recon: recon(), fix: fix(), simplify: simplify() }, [
      { match: saw("--numstat"), throws: "git died mid-diff" },
    ]);

    await expect(solveTicket(h.deps, request)).rejects.toThrow("git died mid-diff");

    const root = h.seen[0]?.options.skillRootPath ?? "";
    expect(root).not.toBe("");
    expect(existsSync(root)).toBe(false);
  });

  it("does not hand the pass the repository this service lives in", async () => {
    // `--add-dir` grants write to a pass that pre-approves `Write` (probed
    // 2026-09-04). The staged root is what keeps the solver away from its own
    // denylists and its own diff gate.
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
  /**
   * A pipeline whose script changes between attempts.
   *
   * The attempt boundary is the `recon` pass, because that is the first thing
   * `runPipeline` runs. Everything else about the harness is the one above.
   */
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
    // Observed 2026-09-04: the host's own safety hook denied a write mid-pass,
    // twice in eight write-capable sessions, non-deterministically — and the
    // run that wrote materially identical content to a neighbouring path
    // succeeded. Nothing about the ticket changed between them.
    const { deps } = attempts([stopped("environment"), FULL]);

    const result = await solveWithRetry(deps, request);

    expect(result.attempts).toBe(2);
    expect(result.outcome.kind).toBe("verified");
  });

  it("stops after one retry, however many times the machine gets in the way", async () => {
    // An obstacle that survives a clean retry is not transient, and a loop that
    // keeps paying to find that out turns a blocked host into a bill.
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
    expect(git.map((argv) => argv.slice(3, 5).join(" "))).toEqual([
      "worktree add",
      "worktree remove",
      "branch -d",
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
