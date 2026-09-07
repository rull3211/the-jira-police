/**
 * Two functions from `solve-run.ts`, and both are here because of what is *not*.
 *
 * `solve-run.ts` has no general test harness — nothing in this tree constructs
 * `runSolveRungs`'s dependencies, which is why D4e could measure that its own
 * call-site mutation survives the whole suite. That gap is recorded at the call
 * site and is still not closed. What is covered here is the two places where
 * the *absence* of a test was itself the defect:
 *
 * `sleep` is the only line in the review chain that has to hold the process
 * open, it did the opposite for a day, and the failure is invisible to every
 * kind of test this repository usually writes. It has to be a child process. A
 * unit test cannot observe "the event loop stayed alive" from inside a runner
 * that is itself holding the loop open — Vitest's own timers, workers and file
 * handles keep the process up no matter what `sleep` does, so an in-process
 * assertion would pass against both the broken version and the fixed one. The
 * thing being tested is a property of a program, so the test runs a program.
 *
 * `createReviewAct`'s refused-checkout branch is the daemon's copy of a branch
 * `advance` also has, and the copy that ran against PR #2663 every two minutes
 * for four days without recording a thing. `delivery.test.ts` covers the other
 * copy thoroughly; that coverage is exactly what made this one look tested. A
 * duplicated branch nothing constructs is where two copies drift, and the
 * direction they drifted last time was silence.
 */

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

import { createReviewAct } from "./solve-run.ts";
import type { AdvanceRequest, PendingRound } from "../solve/delivery.ts";
import type { SolveDependencies } from "../solve/orchestrator.ts";
import type { WatchedTicket } from "../solve/review-cycle.ts";
import type { CommandResult, CommandRunner } from "../solve/worktree.ts";

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

/** The refusal `attachWorktree` gives when it will not hand over a checkout. */
const REFUSAL = "the worktree at /tmp/solve/SSX-3835 has uncommitted changes";

/** The marker comment already on the pull request, so the write is an edit. */
const MARKER_ID = "IC_marker";

const OK: CommandResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };

const ticket: WatchedTicket = {
  key: "SSX-3835",
  summary: "Warranty type is not carried onto the offer",
  url: "https://example.invalid/browse/SSX-3835",
  labels: ["agent:reviewing"],
  updated: "2026-09-05T09:00:00Z",
};

/**
 * A round the survey has already decided on, one attempt in.
 *
 * `failedStarts: 1` rather than `0` so the assertion below reads `2` and not
 * `1`: a call site that wrote a constant, or re-derived the count from an empty
 * marker, would land on `1` and look right.
 */
const pending: PendingRound = {
  comments: [],
  threads: [],
  marker: {
    count: 1,
    reviewerCount: 1,
    failedStarts: 1,
    lastRead: "2026-09-05T08:00:00Z",
    rounds: ["failed to start — the worktree has uncommitted changes"],
  },
  markerId: MARKER_ID,
  round: 2,
  reviewerRound: 2,
  failedStarts: 1,
  humanRound: false,
  isDraft: true,
};

interface ActHarness {
  readonly deps: SolveDependencies;
  readonly act: ReturnType<typeof createReviewAct>;
  readonly calls: readonly (readonly string[])[];
}

/** The checkout the merge round works in, which is the one the `finally` removes. */
const conflictedWorktree = {
  issueKey: ticket.key,
  path: "/tmp/solve/SSX-3835",
  branch: "fix/ssx-3835-warranty-type",
  repoPath: "/repos/buy-insurance-advisor-web",
} as const;

const REFUSING_ATTACH: AdvanceRequest["attach"] = () =>
  Promise.resolve({ outcome: "refused", issueKey: ticket.key, reason: REFUSAL } as const);

/** An attach that got a clean checkout and a base that will not merge into it. */
const CONFLICTED_ATTACH: AdvanceRequest["attach"] = () =>
  Promise.resolve({
    outcome: "conflicted",
    worktree: conflictedWorktree,
    behind: 7,
    files: ["src/utils/DateUtils.ts"],
  } as const);

/**
 * One watched ticket whose checkout cannot be handed over.
 *
 * `passes` throws rather than returning a stub. The claim this test makes is
 * partly about what did *not* happen — no pass runs on a round that never got a
 * worktree — and a stub that quietly answers would let that half pass silently.
 */
function actHarness(attach: AdvanceRequest["attach"] = REFUSING_ATTACH): ActHarness {
  const calls: (readonly string[])[] = [];
  const commands: CommandRunner = {
    run: (argv) => {
      calls.push(argv);
      // A branch that already contains its base, so the merge round below
      // reaches a verdict without a pass. Everything else answers the marker
      // edit, which is the only other call the refusal path makes.
      if (argv.includes("rev-list")) {
        return Promise.resolve({ ...OK, stdout: "0\n" });
      }
      // Only the GraphQL call gets a body. Answering every command with that
      // JSON would make `git status --porcelain` read as a dirty checkout, and
      // the merge round would refuse before it reached the question under test.
      if (!argv.includes("graphql")) {
        return Promise.resolve(OK);
      }
      return Promise.resolve({
        ...OK,
        stdout: JSON.stringify({
          data: { updateIssueComment: { issueComment: { id: MARKER_ID } } },
        }),
      });
    },
  };
  const deps: SolveDependencies = {
    commands,
    passes: {
      run: () => {
        throw new Error("a round ran without a checkout");
      },
    },
  };

  const request: AdvanceRequest = {
    issueKey: ticket.key,
    ticket: ticket.summary,
    summary: ticket.summary,
    repoPath: "/repos/buy-insurance-advisor-web",
    parentDirectory: "/tmp/solve",
    baseRef: "origin/main",
    gitTimeoutMs: 30_000,
    stepTimeoutMs: 300_000,
    installTimeoutMs: 600_000,
    attach,
    cwd: "/repos/buy-insurance-advisor-web",
    now: Date.parse("2026-09-05T10:00:00Z"),
    repo: "acme/advisor",
    number: 2663,
    identity: { name: "jira-police", email: "jira-police@example.invalid" },
    maxRounds: 3,
    maxTotalRounds: 20,
    maxFailedStarts: 3,
    ghTimeoutMs: 60_000,
  };

  const targets = new Map([[ticket.key, { request, holder: { worktree: null } }]]);
  return { deps, act: createReviewAct(deps, targets), calls };
}

/** The body of the marker write the run made, or `""` if it made none. */
const written = (h: ActHarness): string =>
  h.calls
    .filter((argv) => argv.includes("graphql"))
    .map((argv) =>
      (argv.find((element) => element.startsWith("body=")) ?? "").slice("body=".length),
    )
    .at(-1) ?? "";

describe("createReviewAct", () => {
  it("reports a refused checkout without pretending a round ran", async () => {
    const h = actHarness();

    const outcome = await h.act(ticket, pending, 2663);

    expect(outcome).toEqual({ kind: "failed", stage: "worktree", reason: REFUSAL });
  });

  it("counts the attempt in the marker, which is the only place a bound can see it", async () => {
    const h = actHarness();

    await h.act(ticket, pending, 2663);

    // The whole of #2663's four days: this branch returned the refusal and
    // wrote nothing, so every cap read a marker that said the pull request was
    // idle while a tick was failing on it every two minutes. Revert the call to
    // a plain `{ kind: "failed", stage: "worktree" }` and this is the assertion
    // that goes red — the outcome above is identical either way, which is why
    // it cannot be the one guarding this.
    expect(written(h)).toContain("Failed starts: 2");
  });

  it("spends the round on the merge when the base will not go into the branch", async () => {
    // The daemon's own path, and the one that has to agree with `advance`. A
    // review round here would run `pnpm install`, typecheck and test against a
    // tree that does not exist yet, then answer a reviewer from whatever came
    // out — so the checkout decides the round, not the survey. `passes` throws,
    // which is the other half of the claim: this branch is already current, so
    // the merge round reaches its verdict without paying for a pass.
    const h = actHarness(CONFLICTED_ATTACH);

    const outcome = await h.act(ticket, pending, 2663);

    expect(outcome).toEqual({ kind: "synced", round: 3, behind: 0, conflicts: [] });
    // Reserved like any other round, and the history line says which kind it
    // was: a merge round answers nobody, so a marker that recorded it as an
    // ordinary round would leave the reviewer's silence looking like assent.
    expect(written(h)).toContain("bot: iteration count 3");
    expect(written(h)).toContain("round 3 — merge");
    // And neither of the two counters a merge has no business moving.
    expect(written(h)).toContain("Reviewer rounds: 2");
    expect(written(h)).toContain("Last read: 2026-09-05T08:00:00Z");
  });

  it("spends no round on an attempt that never had one", async () => {
    const h = actHarness();

    await h.act(ticket, pending, 2663);

    // Both counters stand still and the cursor does not move. A failed start
    // that consumed a round would let a wedged pull request exhaust
    // `MAX_PR_ROUNDS_TOTAL` and be reported as an argument that went too long;
    // one that advanced `Last read` would drop the reviewer's comments on the
    // way there, unanswered and now invisible.
    expect(written(h)).toContain("bot: iteration count 1");
    expect(written(h)).toContain("Reviewer rounds: 1");
    expect(written(h)).toContain("Last read: 2026-09-05T08:00:00Z");
  });
});
