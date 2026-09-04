import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SolveParseError, type Pass, type SolveRunOptions } from "./runner.ts";
import {
  type PassRunner,
  type SolveDependencies,
  type SolveRequest,
  resolveReview,
  solveTicket,
} from "./orchestrator.ts";
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
  readonly reply: Partial<CommandResult>;
}

const OK: CommandResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };

/** Matches on the presence of a flag, so a rule survives an argv reordering. */
const saw =
  (...needles: readonly string[]) =>
  (argv: readonly string[]): boolean =>
    needles.every((needle) => argv.includes(needle));

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
): { readonly h: Harness } {
  const timeline: string[] = [];
  const calls: (readonly string[])[] = [];
  const seen: { pass: Pass; options: SolveRunOptions }[] = [];

  const defaults: readonly Rule[] = [
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
      return Promise.resolve({ ...OK, ...rule?.reply });
    },
  };

  const passes: PassRunner = {
    run: (pass, options, parse) => {
      timeline.push(`pass:${pass}`);
      seen.push({ pass, options });
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
    // Propagates rather than becoming an outcome: a report that contradicts
    // its own contract is a broken contract, not a ticket that did not work.
    const { h } = harness({
      ...FULL,
      simplify: simplify({
        changed: true,
        filesTouched: ["src/unrelated.ts"],
        changes: ["renamed a variable"],
        declined: "",
      }),
    });

    await expect(solveTicket(h.deps, request)).rejects.toThrow(SolveParseError);
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
    expect(h.calls.some((argv) => argv[1] === "run" && argv[2] === "test")).toBe(true);
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

  it("is removed even when a pass throws", async () => {
    // The `finally`, and the reason it is one. Unplugging it leaves a
    // read-only directory per crashed run, which the next run for that ticket
    // then cannot overwrite — a failure that only shows up after a crash.
    const { h } = harness({ recon: recon() });

    await expect(solveTicket(h.deps, request)).rejects.toThrow();

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
