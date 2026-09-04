import { describe, expect, it } from "vitest";

import {
  type AdvanceRequest,
  type PublishRequest,
  advance,
  publish,
  reviewerComments,
} from "./delivery.ts";
import type { PassRunner, SolveDependencies } from "./orchestrator.ts";
import type { BotIdentity, ReviewState } from "./pr.ts";
import type { Pass, SolveRunOptions } from "./runner.ts";
import type { CommandResult, CommandRunner, Worktree } from "./worktree.ts";

/** The escape, not the byte, so this file stays greppable. See `verify.ts`. */
const NUL = "\u0000";

const MANIFEST = JSON.stringify({
  packageManager: "pnpm@11.20.0",
  scripts: { "check-types": "tsc --noEmit", lint: "oxlint", test: "vitest run" },
});

const FILES = ["src/app/head.tsx", "src/app/head.test.tsx"];
const NUMSTAT = [`12\t3\t${FILES[0] ?? ""}`, `9\t0\t${FILES[1] ?? ""}`, ""].join(NUL);
const OVER_CAP = [
  ...Array.from({ length: 6 }, (_unused, index) => `1\t0\tsrc/f${String(index)}.ts`),
  "",
].join(NUL);

const IDENTITY: BotIdentity = { name: "jira-police", email: "jira-police@example.invalid" };

const worktree: Worktree = {
  issueKey: "SSX-3822",
  path: "/tmp/solve/SSX-3822",
  branch: "fix/ssx-3822-favicon-is-missing",
  repoPath: "/repos/buy-insurance-advisor-web",
};

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

const reviewJson = (overrides: Partial<ReviewState> = {}): string => {
  const base = {
    state: "OPEN",
    isDraft: true,
    reviews: [{ author: { login: "copilot" }, body: "The wrapper element looks unnecessary." }],
    comments: [] as unknown[],
    reviewRequests: [] as unknown[],
    ...overrides,
  };
  return JSON.stringify(base);
};

interface Rule {
  readonly match: (argv: readonly string[]) => boolean;
  readonly reply: Partial<CommandResult>;
}

const OK: CommandResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };

const saw =
  (...needles: readonly string[]) =>
  (argv: readonly string[]): boolean =>
    needles.every((needle) => argv.includes(needle));

const PR_URL = "https://github.com/acme/advisor/pull/42";

interface Harness {
  readonly deps: SolveDependencies;
  readonly calls: readonly (readonly string[])[];
  readonly seen: readonly { readonly pass: Pass; readonly options: SolveRunOptions }[];
}

function harness(
  script: Partial<Record<Pass, unknown>> = {},
  rules: readonly Rule[] = [],
): Harness {
  const calls: (readonly string[])[] = [];
  const seen: { pass: Pass; options: SolveRunOptions }[] = [];

  const defaults: readonly Rule[] = [
    { match: saw("show"), reply: { stdout: MANIFEST } },
    { match: saw("--name-only"), reply: { stdout: "" } },
    { match: saw("--numstat"), reply: { stdout: NUMSTAT } },
    { match: saw("rev-parse"), reply: { stdout: "a1b2c3d4e5f6" } },
    { match: saw("pr", "create"), reply: { stdout: PR_URL } },
    { match: saw("pr", "view"), reply: { stdout: reviewJson() } },
  ];
  const all = [...rules, ...defaults];

  const commands: CommandRunner = {
    run: (argv) => {
      calls.push([...argv]);
      const rule = all.find((candidate) => candidate.match(argv));
      return Promise.resolve({ ...OK, ...rule?.reply });
    },
  };

  const passes: PassRunner = {
    run: (pass, options, parse) => {
      seen.push({ pass, options });
      const output = script[pass];
      if (output === undefined) {
        throw new Error(`the ${pass} pass ran, and this test says it must not have`);
      }
      return Promise.resolve(parse(output));
    },
  };

  return { deps: { commands, passes }, calls, seen };
}

/** Did any command match? Used for "and then it stops" assertions. */
const ran = (h: Harness, ...needles: readonly string[]): boolean =>
  h.calls.some((argv) => saw(...needles)(argv));

const publishRequest: PublishRequest = {
  worktree,
  repo: "acme/advisor",
  baseBranch: "main",
  commit: { subject: "fix(advisor): add missing favicon link", body: "Body.\n\nRefs: SSX-3822" },
  title: "fix(advisor): add missing favicon link",
  body: "Closes SSX-3822.",
  identity: IDENTITY,
  timeoutMs: 60_000,
};

describe("publish", () => {
  it("commits, pushes, opens a draft and asks the reviewer, in that order", async () => {
    const h = harness();

    const outcome = await publish(h.deps, publishRequest);

    expect(outcome).toEqual({ kind: "published", number: 42, url: PR_URL });
    const order = h.calls
      .map((argv) => argv.join(" "))
      .filter((line) => /commit|push|pr create|pr edit/u.test(line))
      .map((line) => line.match(/commit|push|pr create|pr edit/u)?.[0]);
    expect(order).toEqual(["commit", "push", "pr create", "pr edit"]);
  });

  it("opens the pull request as a draft", async () => {
    // The one property that keeps a human between this and a merge.
    const h = harness();

    await publish(h.deps, publishRequest);

    const create = h.calls.find((argv) => saw("pr", "create")(argv)) ?? [];
    expect(create).toContain("--draft");
  });

  it("never force-pushes", async () => {
    const h = harness();

    await publish(h.deps, publishRequest);

    for (const argv of h.calls) {
      expect(argv.join(" ")).not.toMatch(/--force/u);
    }
  });

  it("has no way to merge", async () => {
    const h = harness();

    await publish(h.deps, publishRequest);

    expect(ran(h, "pr", "merge")).toBe(false);
  });

  it("does not push when there was nothing to commit", async () => {
    const h = harness({}, [
      {
        match: saw("commit"),
        reply: { exitCode: 1, stdout: "nothing to commit, working tree clean" },
      },
    ]);

    const outcome = await publish(h.deps, publishRequest);

    expect(outcome).toEqual({ kind: "nothing-to-commit" });
    expect(ran(h, "push")).toBe(false);
  });

  it("does not open a pull request when the push failed", async () => {
    const h = harness({}, [{ match: saw("push"), reply: { exitCode: 1, stderr: "rejected" } }]);

    const outcome = await publish(h.deps, publishRequest);

    expect(outcome).toMatchObject({ kind: "failed", stage: "push" });
    expect(ran(h, "pr", "create")).toBe(false);
  });

  it("keeps a pull request that opened but got no reviewer out of `failed`", async () => {
    // The pull request is durable and externally visible. Reporting this as an
    // ordinary failure invites a retry, and the retry opens a second one.
    const h = harness({}, [
      { match: saw("pr", "edit"), reply: { exitCode: 1, stderr: "reviewer not found" } },
    ]);

    const outcome = await publish(h.deps, publishRequest);

    expect(outcome).toMatchObject({ kind: "published-unreviewed", number: 42, url: PR_URL });
  });

  it("asks Copilot by default", async () => {
    const h = harness();

    await publish(h.deps, publishRequest);

    const edit = h.calls.find((argv) => saw("pr", "edit")(argv)) ?? [];
    expect(edit).toContain("@copilot");
  });
});

const advanceRequest: AdvanceRequest = {
  issueKey: "SSX-3822",
  ticket: "Favicon is missing on the advisor page",
  summary: "Favicon is missing on the advisor page",
  repoPath: "/repos/buy-insurance-advisor-web",
  parentDirectory: "/tmp/solve",
  baseRef: "origin/main",
  gitTimeoutMs: 30_000,
  stepTimeoutMs: 300_000,
  installTimeoutMs: 600_000,
  worktree,
  repo: "acme/advisor",
  number: 42,
  identity: IDENTITY,
  round: 0,
  maxRounds: 3,
  ghTimeoutMs: 60_000,
};

describe("advance", () => {
  it("waits, and starts nothing, when the reviewer has not responded", async () => {
    const h = harness({}, [
      { match: saw("pr", "view"), reply: { stdout: reviewJson({ reviews: [] } as never) } },
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toEqual({ kind: "waiting" });
    expect(h.seen).toEqual([]);
    expect(ran(h, "pr", "ready")).toBe(false);
  });

  it("undrafts when the reviewer responded with nothing to act on", async () => {
    const h = harness({}, [
      {
        match: saw("pr", "view"),
        reply: {
          stdout: JSON.stringify({
            state: "OPEN",
            isDraft: true,
            reviews: [{ author: { login: "copilot" }, body: "" }],
            comments: [],
            reviewRequests: [],
          }),
        },
      },
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "ready" });
    expect(ran(h, "pr", "ready")).toBe(true);
    expect(h.seen).toEqual([]);
  });

  it("resolves a round, pushes it and asks the reviewer again", async () => {
    const h = harness({ review: review() });

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "iterated", round: 1 });
    expect(ran(h, "push")).toBe(true);
    expect(ran(h, "pr", "edit")).toBe(true);
  });

  it("does not undraft while it is still iterating", async () => {
    // Undrafting mid-loop puts a half-answered pull request in front of a
    // human as though it were finished.
    const h = harness({ review: review() });

    await advance(h.deps, advanceRequest);

    expect(ran(h, "pr", "ready")).toBe(false);
  });

  it("hands the reviewer's comments to the resolution pass as data", async () => {
    const h = harness({ review: review() });

    await advance(h.deps, advanceRequest);

    expect(h.seen[0]?.pass).toBe("review");
    expect(h.seen[0]?.options.reviewFeedback).toContain("wrapper element");
  });

  it("does not feed the round our own previous replies", async () => {
    // `reviewerComments` is tested on its own below; this asserts `advance`
    // actually routes through it. A pass answering its own last answer is a
    // loop with no new information in it, and it burns a round each time.
    const h = harness({ review: review() }, [
      {
        match: saw("pr", "view"),
        reply: {
          stdout: JSON.stringify({
            state: "OPEN",
            isDraft: true,
            reviews: [{ author: { login: "copilot" }, body: "the wrapper looks unnecessary" }],
            comments: [{ author: { login: "jira-police" }, body: "moved it, as you suggested" }],
            reviewRequests: [],
          }),
        },
      },
    ]);

    await advance(h.deps, advanceRequest);

    const feedback = h.seen[0]?.options.reviewFeedback ?? "";
    expect(feedback).toContain("wrapper");
    expect(feedback).not.toContain("as you suggested");
  });

  it("does not give up when the only comment left is our own", async () => {
    // Our reply is not feedback. Counting it would spend rounds answering
    // ourselves, and here it would undraft while the reviewer is still typing.
    const h = harness({}, [
      {
        match: saw("pr", "view"),
        reply: {
          stdout: JSON.stringify({
            state: "OPEN",
            isDraft: true,
            reviews: [{ author: { login: "copilot" }, body: "" }],
            comments: [{ author: { login: "jira-police" }, body: "pushed a fix" }],
            reviewRequests: [],
          }),
        },
      },
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "ready" });
    expect(h.seen).toEqual([]);
  });

  it("stops resolving at the round cap and undrafts, saying so", async () => {
    const h = harness({}, []);

    const outcome = await advance(h.deps, { ...advanceRequest, round: 3, maxRounds: 3 });

    expect(outcome).toMatchObject({ kind: "exhausted", rounds: 3 });
    expect(h.seen).toEqual([]);
    expect(ran(h, "pr", "ready")).toBe(true);
  });

  it("carries the unanswered comments out when it gives up", async () => {
    const h = harness({}, []);

    const outcome = await advance(h.deps, { ...advanceRequest, round: 3, maxRounds: 3 });

    if (outcome.kind !== "exhausted") {
      throw new Error(`expected exhausted, got ${outcome.kind}`);
    }
    expect(outcome.unresolved).toContain("wrapper element");
  });

  it("pushes nothing when the round only answered questions", async () => {
    const h = harness({
      review: review({
        changed: false,
        filesTouched: [],
        commitSubject: "",
        commitBody: "",
        responses: ["the null check is unreachable; the caller guarantees a value"],
      }),
    });

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "iterated", round: 1 });
    expect(ran(h, "push")).toBe(false);
    expect(ran(h, "pr", "edit")).toBe(true);
  });

  it("does not push a round that failed verification", async () => {
    const h = harness({ review: review() }, [
      { match: saw("run", "test"), reply: { exitCode: 1 } },
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "failed", stage: "verification" });
    expect(ran(h, "push")).toBe(false);
  });

  it("does not push a round the diff gate refused", async () => {
    const h = harness({ review: review() }, [
      { match: saw("--numstat"), reply: { stdout: OVER_CAP } },
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "refused", stage: "diff-gate" });
    expect(ran(h, "push")).toBe(false);
  });

  it("does not undraft a pull request whose round was abandoned", async () => {
    const h = harness({
      review: review({
        changed: false,
        filesTouched: [],
        commitSubject: "",
        commitBody: "",
        responses: ["this needs a breaking API change"],
        abandoned: "the reviewer is asking for something outside what this may do",
      }),
    });

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "abandoned" });
    expect(ran(h, "pr", "ready")).toBe(false);
  });

  it("reports a failed undraft rather than claiming the pull request is ready", async () => {
    const h = harness({}, [
      { match: saw("pr", "ready"), reply: { exitCode: 1, stderr: "no permission" } },
      {
        match: saw("pr", "view"),
        reply: {
          stdout: JSON.stringify({
            state: "OPEN",
            isDraft: true,
            reviews: [{ author: { login: "copilot" }, body: "" }],
            comments: [],
            reviewRequests: [],
          }),
        },
      },
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "failed", stage: "undraft" });
  });

  it("never merges, at any point in the loop", async () => {
    const h = harness({ review: review() });

    await advance(h.deps, advanceRequest);

    expect(ran(h, "pr", "merge")).toBe(false);
  });
});

describe("reviewerComments", () => {
  it("drops our own comments, so a round is not fed its own replies", async () => {
    const state: ReviewState = {
      reviewerResponded: true,
      state: "OPEN",
      isDraft: true,
      comments: [
        { author: "copilot", body: "the wrapper looks unnecessary" },
        { author: "jira-police", body: "moved it, as suggested" },
      ],
    };

    expect(reviewerComments(state, IDENTITY)).toEqual([
      { author: "copilot", body: "the wrapper looks unnecessary" },
    ]);
    await Promise.resolve();
  });

  it("matches our identity regardless of case", () => {
    const state: ReviewState = {
      reviewerResponded: true,
      state: "OPEN",
      isDraft: true,
      comments: [{ author: "JIRA-Police", body: "mine" }],
    };

    expect(reviewerComments(state, IDENTITY)).toEqual([]);
  });

  it("keeps everything when none of it is ours", () => {
    const state: ReviewState = {
      reviewerResponded: true,
      state: "OPEN",
      isDraft: true,
      comments: [{ author: "copilot", body: "a" }],
    };

    expect(reviewerComments(state, IDENTITY)).toHaveLength(1);
  });
});
