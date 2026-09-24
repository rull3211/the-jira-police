import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type AdvanceRequest,
  type PublishRequest,
  advance,
  publish,
  reviewerComments,
  unansweredThreads,
} from "./delivery.ts";
import { BOT_PREFIX, MARKER_PREFIX, NEVER_READ, parseMarker } from "./marker.ts";
import type { PassRunner, SolveDependencies } from "./orchestrator.ts";
import {
  type BotIdentity,
  type ReviewComment,
  type ReviewOrigin,
  type ReviewState,
  type ReviewThread,
  readReviewThreads,
  replyToThread,
} from "./pr.ts";
import type { Pass, SolveRunOptions } from "./runner.ts";
import type { CommandResult, CommandRunner, Worktree, WorktreeResult } from "./worktree.ts";

/** The escape, not the byte, so this file stays greppable. See `verify.ts`. */
const NUL = "\u0000";

const MANIFEST = JSON.stringify({
  packageManager: "pnpm@11.20.0",
  scripts: { "check-types": "tsc --noEmit", lint: "oxlint", test: "vitest run" },
});

const FILES = ["src/app/head.tsx", "src/app/head.test.tsx"];
const NUMSTAT = [`12\t3\t${FILES[0] ?? ""}`, `9\t0\t${FILES[1] ?? ""}`, ""].join(NUL);
/** A diff the gate refuses: one ordinary file and one lockfile. */
const REFUSED_DIFF = ["1\t0\tsrc/app.ts", "8\t2\tpnpm-lock.yaml", ""].join(NUL);

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

const reviewJson = (overrides: Partial<ReviewState> = {}): string => {
  const base = {
    state: "OPEN",
    isDraft: true,
    // The floor under the silence clock: a payload without it is refused, not read as quiet.
    createdAt: "2026-09-05T09:00:00Z",
    reviews: [{ author: { login: "copilot" }, body: "The wrapper element looks unnecessary." }],
    comments: [] as unknown[],
    reviewRequests: [] as unknown[],
    ...overrides,
  };
  return JSON.stringify(base);
};

/** A marker comment as `gh pr view --json comments` returns it. Carries an `id`, since `findMarker` refuses a marker it could not edit. */
const markerComment = (
  count: number,
  lastRead: string,
  id = "IC_marker",
  reviewerCount?: number,
): unknown => ({
  author: { login: "rull3211" },
  body:
    `bot: iteration count ${String(count)}\nLast read: ${lastRead}\n` +
    (reviewerCount === undefined ? "" : `Reviewer rounds: ${String(reviewerCount)}\n`),
  createdAt: "2026-09-05T09:00:00Z",
  id,
});

/** A reviewer comment with a date on it, which is what the cursor sorts on. */
const dated = (body: string, createdAt: string): unknown => ({
  author: { login: "copilot" },
  body,
  createdAt,
  id: `IC_${createdAt}`,
});

/** The same, from somebody who is not the requested reviewer. */
const fromHuman = (body: string, createdAt = "2026-09-05T10:00:00Z"): unknown => ({
  author: { login: "a-colleague" },
  body,
  createdAt,
  id: `IC_human_${createdAt}`,
});

interface Rule {
  readonly match: (argv: readonly string[]) => boolean;
  readonly reply: Partial<CommandResult>;
}

/** Matches a GraphQL call by the operation named in its query text. */
const asked =
  (operation: string) =>
  (argv: readonly string[]): boolean =>
    argv.includes("graphql") && argv.some((arg) => arg.includes(operation));

/** One inline thread as GraphQL returns it. */
const thread = (overrides: Record<string, unknown> = {}): unknown => ({
  id: "PRRT_1",
  isResolved: false,
  isOutdated: false,
  path: "src/app/head.tsx",
  line: 19,
  comments: {
    pageInfo: { hasNextPage: false },
    nodes: [
      {
        author: { login: "copilot" },
        body: "this is not idempotent",
        createdAt: "2026-09-05T09:00:00Z",
      },
    ],
  },
  ...overrides,
});

/** The `reviewThreads` reply. Empty by default; no pull request need have any. */
const threadsJson = (...nodes: readonly unknown[]): string =>
  JSON.stringify({
    data: {
      repository: {
        pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes } },
      },
    },
  });

/** One comment inside a thread, as GraphQL nests them. */
const spoke = (author: string, body: string): unknown => ({
  author: { login: author },
  body,
  createdAt: "2026-09-05T09:00:00Z",
});

/** A thread carrying this conversation and nothing else changed. */
const talking = (...nodes: readonly unknown[]): unknown =>
  thread({ comments: { pageInfo: { hasNextPage: false }, nodes } });

/** Where a call landed in the sequence, or `-1`. Used for ordering claims. */
const at = (h: Harness, match: (argv: readonly string[]) => boolean): number =>
  h.calls.findIndex((argv) => match(argv));

/** A pull request carrying these inline threads and nothing else new. */
const inline = (...nodes: readonly unknown[]): Rule => ({
  match: asked("reviewThreads"),
  reply: { stdout: threadsJson(...nodes) },
});

/** The subject of every commit the run made, in order. */
const commitSubjects = (h: Harness): readonly string[] =>
  h.calls
    .filter((argv) => argv.includes("commit"))
    .map((argv) => argv[argv.indexOf("-m") + 1] ?? "");

/** The bodies of every comment the run posted, in order. */
const posts = (h: Harness): readonly string[] =>
  h.calls
    .filter((argv) => asked("addComment")(argv))
    // The last argv element is the mutation query, not the body; `at(-1)` would silently match nothing.
    .map((argv) => argv.find((element) => element.startsWith("body=")) ?? "")
    .map((body) => body.slice("body=".length));

/** The bodies of every inline thread reply the run posted, in order, read off the `gh` argv rather than the pass's own text. */
const replies = (h: Harness): readonly string[] =>
  h.calls
    .filter((argv) => asked("addPullRequestReviewThreadReply")(argv))
    // Same trap as `posts`: the last element is the mutation text, not the body.
    .map((argv) => argv.find((element) => element.startsWith("body=")) ?? "")
    .map((body) => body.slice("body=".length));

/**
 * The GitHub account this service posts through, which is a person's — a bot reply and an
 * operator comment arrive under the same login, so no test may key "ours" on the author.
 */
const OPERATOR = "rull3211";

/**
 * A thread comment carrying what this service would really have replied — built by running
 * `replyToThread` and taking the bytes it put on the wire, not `"bot: " + text` (PR #548): a
 * hand-written prefix here would pass even if the real writer stopped sending one.
 */
const ourReply = async (text: string): Promise<unknown> => {
  let sent = "";
  const runner: CommandRunner = {
    run: (argv) => {
      sent = argv.find((arg) => arg.startsWith("body="))?.slice("body=".length) ?? "";
      return Promise.resolve({
        ...OK,
        stdout: JSON.stringify({
          data: { addPullRequestReviewThreadReply: { comment: { url: REPLY_URL } } },
        }),
      });
    },
  };
  const posted = await replyToThread(runner, {
    cwd: "/tmp/wt",
    threadId: "PRRT_1",
    body: text,
    timeoutMs: 1000,
  });
  if (posted.outcome !== "replied") {
    throw new Error(`the fixture's own reply did not post: ${posted.reason}`);
  }
  return spoke(OPERATOR, sent);
};

/** Threads as a later round would see them: GraphQL's shape through the real parser. */
const asLaterRoundSees = async (...nodes: readonly unknown[]): Promise<readonly ReviewThread[]> => {
  const runner: CommandRunner = {
    run: () => Promise.resolve({ ...OK, stdout: threadsJson(...nodes) }),
  };
  const result = await readReviewThreads(runner, {
    worktreePath: "/tmp/wt",
    repo: "acme/widgets",
    number: 548,
    timeoutMs: 1000,
  });
  if (result.outcome !== "read") {
    throw new Error(`the fixture did not parse: ${result.reason}`);
  }
  return result.threads;
};

/** Does any of these bodies claim to be the iteration marker? */
const marker = (bodies: readonly string[]): boolean =>
  bodies.some((body) => body.startsWith(MARKER_PREFIX));

/** Did the run write the marker at all — either the first post or a later edit? */
const markerWritten = (h: Harness): boolean =>
  h.calls.some((argv) => asked("addComment")(argv) || asked("updateIssueComment")(argv));

/**
 * The body of the newest marker write, whichever mutation carried it — a pull request with no
 * marker yet is posted to, one with a marker is edited, and the counter must survive either.
 */
const markerBody = (h: Harness): string =>
  h.calls
    .filter((argv) => asked("addComment")(argv) || asked("updateIssueComment")(argv))
    .map((argv) =>
      (argv.find((element) => element.startsWith("body=")) ?? "").slice("body=".length),
    )
    .at(-1) ?? "";

/** The refusal `attachWorktree` gives when it cannot hand over a checkout. */
const refusedCheckout: WorktreeResult = {
  outcome: "refused",
  issueKey: "SSX-3822",
  reason: "the worktree has uncommitted changes",
};

/**
 * A pull request whose marker records starts that never became rounds.
 *
 * Written out rather than built from `markerComment`, because the two lines
 * these tests are about — the count and the note it points at — are exactly
 * what a fifth positional parameter would bury. It also pins the note's format
 * from outside the module that writes it: the prefix is parsed back out by
 * `lastFailedStart`, so it is a format and not a phrasing.
 */
const stalling = (attempts: number, reviews?: readonly unknown[]): Rule => ({
  match: saw("pr", "view"),
  reply: {
    stdout: reviewJson({
      // Named explicitly so a test can ask for a pull request that is over the
      // bound and has nothing to answer — the pair the ordering of the check
      // turns on, and one the default reviewer review cannot express.
      ...(reviews === undefined ? {} : { reviews }),
      comments: [
        {
          author: { login: "rull3211" },
          body:
            `bot: iteration count 1\n` +
            `Last read: 2026-09-05T08:00:00Z\n` +
            `Reviewer rounds: 1\n` +
            `Failed starts: ${String(attempts)}\n\n` +
            `- failed to start — the worktree has uncommitted changes`,
          createdAt: "2026-09-05T09:00:00Z",
          id: "IC_marker",
        },
      ],
    } as never),
  },
});

/** A pull request that already carries a marker saying `count` rounds are gone. */
const spent = (count: number, lastRead = "2026-09-05T08:00:00Z"): Rule => ({
  match: saw("pr", "view"),
  reply: { stdout: reviewJson({ comments: [markerComment(count, lastRead)] } as never) },
});

/** A pull request spelled out whole: both marker counts, and exactly the reviews/comments named. */
const board = (opts: {
  readonly count: number;
  readonly reviewerCount: number;
  readonly reviews?: readonly unknown[];
  readonly comments?: readonly unknown[];
}): Rule => ({
  match: saw("pr", "view"),
  reply: {
    stdout: reviewJson({
      reviews: opts.reviews ?? [],
      comments: [
        markerComment(opts.count, "2026-09-05T08:00:00Z", "IC_marker", opts.reviewerCount),
        ...(opts.comments ?? []),
      ],
    } as never),
  },
});

const OK: CommandResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };

const saw =
  (...needles: readonly string[]) =>
  (argv: readonly string[]): boolean =>
    needles.every((needle) => argv.includes(needle));

/** A pull request whose reviewer has spoken and left no issue comment at all. */
const QUIET: Rule = {
  match: saw("pr", "view"),
  reply: {
    stdout: reviewJson({ reviews: [{ author: { login: "copilot" }, body: "" }] } as never),
  },
};

const PR_URL = "https://github.com/acme/advisor/pull/42";
const PR_NODE = "PR_kwDOnode";
const POSTED = "IC_marker";
const REPLY_URL = `${PR_URL}#discussion_r1`;

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
    // A Node base: `pom.xml` is absent, since `verify` refuses a base that declares both toolchains.
    {
      match: (argv) => argv.includes("show") && argv.some((arg) => arg.endsWith(":pom.xml")),
      reply: { exitCode: 128 },
    },
    { match: saw("show"), reply: { stdout: MANIFEST } },
    { match: saw("--name-only"), reply: { stdout: "" } },
    { match: saw("--numstat"), reply: { stdout: NUMSTAT } },
    { match: saw("rev-parse"), reply: { stdout: "a1b2c3d4e5f6" } },
    { match: saw("pr", "create"), reply: { stdout: PR_URL } },
    { match: saw("pr", "view"), reply: { stdout: reviewJson() } },
    // The marker's three GraphQL calls all succeed by default; a failed reservation must be arranged, not stumbled into.
    { match: asked("reviewThreads"), reply: { stdout: threadsJson() } },
    {
      match: asked("pullRequest(number:"),
      reply: { stdout: JSON.stringify({ data: { repository: { pullRequest: { id: PR_NODE } } } }) },
    },
    {
      match: asked("addComment"),
      reply: {
        stdout: JSON.stringify({ data: { addComment: { commentEdge: { node: { id: POSTED } } } } }),
      },
    },
    {
      match: asked("updateIssueComment"),
      reply: {
        stdout: JSON.stringify({ data: { updateIssueComment: { issueComment: { id: POSTED } } } }),
      },
    },
    // The two thread writes also succeed by default; a reply that fails to post must be arranged explicitly.
    {
      match: asked("addPullRequestReviewThreadReply"),
      reply: {
        stdout: JSON.stringify({
          data: { addPullRequestReviewThreadReply: { comment: { url: REPLY_URL } } },
        }),
      },
    },
    {
      match: asked("resolveReviewThread"),
      reply: {
        stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } }),
      },
    },
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

/** Matches the first time only, so a two-state git read (e.g. `--diff-filter=U` before and after a merge round) can be scripted. */
const once = (match: (argv: readonly string[]) => boolean) => {
  let used = false;
  return (argv: readonly string[]): boolean => {
    if (used || !match(argv)) {
      return false;
    }
    used = true;
    return true;
  };
};

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
    // A retry on an ordinary failure would open a second pull request.
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
  attach: () => Promise.resolve({ outcome: "created", worktree } as const),
  cwd: "/repos/buy-insurance-advisor-web",
  now: Date.parse("2026-09-05T10:00:00Z"),
  repo: "acme/advisor",
  number: 42,
  identity: IDENTITY,
  maxRounds: 3,
  maxTotalRounds: 20,
  maxFailedStarts: 3,
  ghTimeoutMs: 60_000,
};

describe("advance", () => {
  it("waits, and starts nothing, when the reviewer has not responded", async () => {
    const h = harness({}, [
      { match: saw("pr", "view"), reply: { stdout: reviewJson({ reviews: [] } as never) } },
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    // Measured from the pull request's own creation; `advance` only measures, the caller decides the bound.
    expect(outcome).toEqual({ kind: "waiting", quietMs: 3_600_000 });
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
            createdAt: "2026-09-05T09:00:00Z",
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

  it("undrafts on an approval instead of paying a round to acknowledge it", async () => {
    // An approval must go through `anyoneResponded` as well as `comments`, or this stays `waiting` until the silence brake fires.
    const h = harness({}, [
      {
        match: saw("pr", "view"),
        reply: {
          stdout: JSON.stringify({
            state: "OPEN",
            isDraft: true,
            createdAt: "2026-09-05T09:00:00Z",
            reviews: [
              {
                author: { login: "copilot" },
                body: "### 🟢 Approval recommended\n\nThe change is narrowly scoped.",
              },
            ],
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

  it("keeps waiting when the only thing on the pull request is a deploy notice", async () => {
    // CI is not a party to the review; undrafting on its notice would hand a human an unreviewed pull request.
    const h = harness({}, [
      {
        match: saw("pr", "view"),
        reply: {
          stdout: JSON.stringify({
            state: "OPEN",
            isDraft: true,
            createdAt: "2026-09-05T09:00:00Z",
            reviews: [],
            comments: [
              {
                author: { login: "github-actions" },
                body: ":rocket: Application Deployed\n\nhttps://pr-2663.example.dev",
                createdAt: "2026-09-05T09:30:00Z",
              },
            ],
            reviewRequests: [],
          }),
        },
      },
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "waiting" });
    expect(ran(h, "pr", "ready")).toBe(false);
    expect(h.seen).toEqual([]);
  });

  it("measures the silence from the reviewer's last word, not from the last deploy", async () => {
    // The notice is triggered by our own push; counting it would reset the clock every round and the silence brake would never fire.
    const h = harness({}, [
      {
        match: saw("pr", "view"),
        reply: {
          stdout: JSON.stringify({
            state: "OPEN",
            isDraft: true,
            createdAt: "2026-09-05T09:00:00Z",
            reviews: [],
            comments: [
              {
                author: { login: "github-actions" },
                body: ":rocket: Application Deployed",
                createdAt: "2026-09-05T09:59:00Z",
              },
            ],
            reviewRequests: [],
          }),
        },
      },
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    // A full hour from the pull request's own creation; counting the notice would read one minute instead.
    expect(outcome).toEqual({ kind: "waiting", quietMs: 3_600_000 });
  });

  it("resolves a round, pushes it and asks the reviewer again", async () => {
    const h = harness({ review: review() });

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "iterated", round: 1, reviewerRequested: "asked" });
    expect(ran(h, "push")).toBe(true);
    expect(ran(h, "pr", "edit")).toBe(true);
  });

  it.each([
    ["pushed a change", review({ unresolved: "the second point needs a product decision" })],
    [
      "only answered questions",
      review({
        changed: false,
        filesTouched: [],
        unresolved: "the second point needs a product decision",
      }),
    ],
  ])("carries what a successful round could not settle — %s", async (_case, report) => {
    // Both construction sites: `iterated` and `exhausted` are separate returns, and a fix to one leaves the other silent.
    const h = harness({ review: report });

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({
      kind: "iterated",
      unresolved: "the second point needs a product decision",
    });
  });

  it("reports that the re-request failed instead of claiming the reviewer was asked", async () => {
    const h = harness({ review: review() }, [
      {
        match: saw("pr", "edit"),
        reply: { exitCode: 1, stderr: "HTTP 403: Resource not accessible" },
      },
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    // Still iterated: the code pushed fine, only the notification is missing.
    expect(outcome).toMatchObject({ kind: "iterated", round: 1, reviewerRequested: "failed" });
    expect(ran(h, "push")).toBe(true);
  });

  it("does not undraft a pull request whose re-request failed", async () => {
    // Undrafting here would put an unreviewed pull request in front of a reviewer who was never asked.
    const h = harness({ review: review() }, [
      { match: saw("pr", "edit"), reply: { exitCode: 1, stderr: "HTTP 403" } },
    ]);

    await advance(h.deps, advanceRequest);

    expect(ran(h, "pr", "ready")).toBe(false);
  });

  it("does not ask the reviewer to re-read a tree it did not change", async () => {
    // `changed: false` routes here — a review that raised only questions, answered without an edit (PR #2658).
    const h = harness({ review: review({ changed: false }) });

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "iterated", reviewerRequested: "unnecessary" });
    expect(ran(h, "pr", "edit")).toBe(false);
    expect(ran(h, "push")).toBe(false);
  });

  it("does not report a failed re-request when it never made one", async () => {
    // "Not asked" and "asked and it failed" must not collapse to the same boolean and opposite instruction.
    const h = harness({ review: review({ changed: false }) }, [
      { match: saw("pr", "edit"), reply: { exitCode: 1, stderr: "HTTP 403" } },
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ reviewerRequested: "unnecessary" });
  });

  it("does not claim to have pushed on a round that changed nothing", async () => {
    // `kind` does not imply the push (PR #2658 round 2 changed no code but headlined "round 2 pushed").
    const h = harness({ review: review({ changed: false, filesTouched: [] }) });

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "iterated", pushed: false });
    expect(ran(h, "push")).toBe(false);
  });

  it("says it pushed on a round that did", async () => {
    const h = harness({ review: review() });

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "iterated", pushed: true });
    expect(ran(h, "push")).toBe(true);
  });

  it("does not claim a push when the edits turned out to commit to nothing", async () => {
    // The pass says it changed files, but `git commit` finds the tree byte-identical; the model's `changed` flag is not to be trusted here.
    const h = harness({ review: review() }, [
      {
        match: saw("commit"),
        reply: { exitCode: 1, stdout: "nothing to commit, working tree clean" },
      },
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "iterated", pushed: false });
  });

  it("puts its answer to a review body on the pull request", async () => {
    // A summary review has no thread to reply to (PR #2658 round 3); without this the answer never reaches the pull request.
    const h = harness({ review: review({ changed: false, responses: ["Checked: no icon link"] }) });

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ spoken: { outcome: "posted" } });
    expect(posts(h).some((body) => body.includes("Checked: no icon link"))).toBe(true);
  });

  it("prefixes what it posts, so the next round does not read it as feedback", async () => {
    // `gh` posts as the operator, so `bot: ` is the only thing separating our words from a reviewer's.
    const h = harness({ review: review({ changed: false, responses: ["answered"] }) });

    await advance(h.deps, advanceRequest);

    const spoken = posts(h).filter((body) => !body.startsWith(MARKER_PREFIX));
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.startsWith(BOT_PREFIX)).toBe(true);
    expect(reviewerComments({ comments: [{ body: spoken[0] ?? "" }] } as never)).toEqual([]);
  });

  it("says nothing on the pull request when every comment had a thread", async () => {
    // A round entirely inline has already answered in the right place.
    const h = harness({ review: review({ changed: false }) }, [QUIET, inline(thread())]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ spoken: { outcome: "nothing-to-say" } });
    expect(posts(h).filter((body) => !body.startsWith(MARKER_PREFIX))).toEqual([]);
  });

  it("takes the pull request out of draft when the round changed nothing", async () => {
    // Nothing new to re-read, nothing more the loop can do; an active pull request must never be left flagged unfinished.
    const h = harness({ review: review({ changed: false }) });

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ undrafted: "undrafted" });
    expect(ran(h, "pr", "ready")).toBe(true);
  });

  it("stays a draft when the answer did not reach the pull request", async () => {
    // The gate is the answer being *visible*, not merely produced. Undrafting
    // here hands a human a reviewer's objection with the rebuttal nowhere.
    const h = harness({ review: review({ changed: false, responses: ["answered"] }) }, [
      { match: asked("addComment"), reply: { exitCode: 1, stderr: "HTTP 403" } },
      spent(1),
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ spoken: { outcome: "failed" }, undrafted: "still-drafting" });
    expect(ran(h, "pr", "ready")).toBe(false);
  });

  it("stays a draft when a thread reply would not post", async () => {
    // Same rule through the other channel, and a separate call site.
    const h = harness(
      {
        review: review({
          changed: false,
          threadAnswers: [
            {
              threadId: "PRRT_1",
              reply: "checked, and the premise holds",
              basis: "checked",
              resolve: false,
            },
          ],
        }),
      },
      [
        {
          match: asked("addPullRequestReviewThreadReply"),
          reply: { exitCode: 1, stderr: "HTTP 403" },
        },
        QUIET,
        inline(thread()),
      ],
    );

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ undrafted: "still-drafting" });
    expect(ran(h, "pr", "ready")).toBe(false);
  });

  it("keeps the round when it cannot leave draft, and says so out loud", async () => {
    // Discarding it over a failed transition would throw away a paid pass; hiding the failure sends nobody to the button.
    const h = harness({ review: review({ changed: false }) }, [
      { match: saw("pr", "ready"), reply: { exitCode: 1, stderr: "HTTP 403" } },
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "iterated", undrafted: "failed" });
  });

  it("does not undraft while it is still iterating", async () => {
    // Undrafting mid-loop puts a half-answered pull request in front of a human as though it were finished.
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
    // Our own comment arrives under the operator's login (that's who `gh` authenticates as); only the prefix marks it.
    const h = harness({ review: review() }, [
      {
        match: saw("pr", "view"),
        reply: {
          stdout: JSON.stringify({
            state: "OPEN",
            isDraft: true,
            createdAt: "2026-09-05T09:00:00Z",
            reviews: [{ author: { login: "copilot" }, body: "the wrapper looks unnecessary" }],
            comments: [{ author: { login: "rull3211" }, body: "bot: moved it, as you suggested" }],
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

  describe("a repository member's request", () => {
    /** Copilot's review, then the operator asking for more, as PR #2688 had them. */
    const memberAsked: Rule = {
      match: saw("pr", "view"),
      reply: {
        stdout: JSON.stringify({
          state: "OPEN",
          isDraft: true,
          createdAt: "2026-09-05T09:00:00Z",
          reviews: [
            {
              author: { login: "copilot" },
              authorAssociation: "NONE",
              body: "the wrapper looks unnecessary",
            },
          ],
          comments: [
            {
              author: { login: "rull3211" },
              authorAssociation: "MEMBER",
              body: "and drop the unused exports while you are in there",
            },
          ],
          reviewRequests: [],
        }),
      },
    };
    const widened = (requestedBy: string) =>
      review({ widened: [{ path: FILES[0] ?? "", requestedBy, what: "dropped the exports" }] });

    it("is labelled with a token minted for the round, and the pass is told the same token", async () => {
      const h = harness({ review: review() }, [memberAsked]);

      await advance(h.deps, advanceRequest);

      const options = h.seen[0]?.options;
      const token = options?.memberToken ?? "";
      expect(token).toMatch(/^[0-9a-f]{12}$/u);
      expect(options?.reviewFeedback).toContain(`by rull3211 · repository member ${token} ---`);
      expect(options?.reviewFeedback).toContain("by copilot ---");
    });

    it("gets a different token next round, so a label quoted back from this one does not pass", async () => {
      const first = harness({ review: review() }, [memberAsked]);
      const second = harness({ review: review() }, [memberAsked]);

      await advance(first.deps, advanceRequest);
      await advance(second.deps, advanceRequest);

      expect(first.seen[0]?.options.memberToken).not.toBe(second.seen[0]?.options.memberToken);
    });

    it("lets a widening cite the member's comment", async () => {
      const h = harness({ review: widened("comment 2") }, [memberAsked]);

      const outcome = await advance(h.deps, advanceRequest);

      expect(outcome).toMatchObject({ kind: "iterated", pushed: true });
    });

    it("refuses a widening cited to the reviewer's comment", async () => {
      const h = harness({ review: widened("comment 1") }, [memberAsked]);

      const outcome = await advance(h.deps, advanceRequest);

      expect(outcome).toMatchObject({ kind: "refused", stage: "widening" });
      expect(ran(h, "push")).toBe(false);
    });

    it("tells whoever asked why a refused round pushed nothing, mentioning only the member", async () => {
      const h = harness({ review: widened("comment 1") }, [memberAsked]);

      const outcome = await advance(h.deps, advanceRequest);

      expect(outcome).toMatchObject({ kind: "refused", told: { outcome: "posted" } });
      const told = posts(h).find((body) => body.includes("nothing from this round was pushed"));
      expect(told?.startsWith(BOT_PREFIX)).toBe(true);
      expect(told).toContain("@rull3211 — Nothing from this round was pushed");
      expect(told).toContain("refused it at the widening");
      // Quoted, never mentioned: `@copilot` in a comment asks GitHub's agent to act.
      expect(told).not.toContain("@copilot");
      expect(told).toContain("> the wrapper looks unnecessary");
      expect(told).toContain("> and drop the unused exports while you are in there");
    });

    it("breaks a mention inside a quote, so quoting a comment cannot summon anyone", async () => {
      // `comment 2` does not exist here, so the widening is refused and the reason goes out.
      const h = harness({ review: widened("comment 2") }, [
        {
          match: saw("pr", "view"),
          reply: {
            stdout: JSON.stringify({
              state: "OPEN",
              isDraft: true,
              createdAt: "2026-09-05T09:00:00Z",
              reviews: [],
              comments: [
                {
                  author: { login: "rull3211" },
                  authorAssociation: "MEMBER",
                  body: "@copilot and drop the unused exports",
                },
              ],
              reviewRequests: [],
            }),
          },
        },
      ]);

      await advance(h.deps, advanceRequest);

      const told = posts(h).find((body) => body.includes("nothing from this round was pushed"));
      expect(told).toContain("@rull3211 — ");
      expect(told).toContain("> @\u200bcopilot and drop the unused exports");
      expect(told).not.toMatch(/@copilot/u);
    });

    it("quotes a comment's first visible line, past an HTML comment GitHub would hide", async () => {
      // SSX-3918 #1459 round 5 quoted `<!-- gh-pr-review -->`, which rendered as an empty quote.
      const h = harness({ review: widened("comment 2") }, [
        {
          match: saw("pr", "view"),
          reply: {
            stdout: JSON.stringify({
              state: "OPEN",
              isDraft: true,
              createdAt: "2026-09-05T09:00:00Z",
              reviews: [],
              comments: [
                {
                  author: { login: "jacobbiorn" },
                  authorAssociation: "MEMBER",
                  body: "<!-- gh-pr-review -->\n**Review:** 0 must fix \u00b7 3 nice to fix",
                },
              ],
              reviewRequests: [],
            }),
          },
        },
      ]);

      await advance(h.deps, advanceRequest);

      const told = posts(h).find((body) => body.includes("nothing from this round was pushed"));
      expect(told).toContain("> **Review:** 0 must fix \u00b7 3 nice to fix");
      expect(told).not.toContain("<!--");
    });

    it("pushes the rest when one edit is refused, and tells the member who asked for it", async () => {
      const withPom = [`12\t3\t${FILES[0] ?? ""}`, "1\t1\tpom.xml", ""].join(NUL);
      let postRoundReads = 0;
      const h = harness(
        {
          review: review({
            filesTouched: [FILES[0] ?? "", "pom.xml"],
            widened: [
              {
                path: "pom.xml",
                requestedBy: "comment 2",
                what: "corrected the stale version comment",
              },
            ],
          }),
        },
        [
          memberAsked,
          // The pull request's own diff, before the round: pom.xml is already in it.
          {
            match: (argv) =>
              argv.includes("--numstat") && argv.some((arg) => arg.endsWith("...HEAD")),
            reply: { stdout: withPom },
          },
          // The round's diff: refused the first time, clean once pom.xml is restored.
          {
            match: (argv) => {
              if (!argv.includes("--numstat")) {
                return false;
              }
              postRoundReads += 1;
              return postRoundReads === 1;
            },
            reply: { stdout: withPom },
          },
          {
            match: (argv) =>
              argv.includes("diff") && argv.includes("--name-only") && argv.includes("HEAD"),
            reply: { stdout: `pom.xml${NUL}${FILES[0] ?? ""}${NUL}` },
          },
          { match: saw("ls-tree"), reply: { stdout: `pom.xml${NUL}` } },
        ],
      );

      const outcome = await advance(h.deps, advanceRequest);

      expect(outcome).toMatchObject({
        kind: "iterated",
        pushed: true,
        dropped: { paths: ["pom.xml"], notice: { outcome: "posted" } },
      });
      const told = posts(h).find((body) => body.includes("part of this round was not pushed"));
      expect(told).toContain("@rull3211 — The rest of this round was pushed");
      expect(told).toContain("`pom.xml` was not changed: pom.xml:");
      // Told to the comment the widening named, not to every comment on the round.
      expect(told).toContain("> and drop the unused exports while you are in there");
      expect(told).not.toContain("the wrapper looks unnecessary");
      const commit = h.calls.find((argv) => argv.includes("commit") && argv.includes("-m"));
      expect(commit?.join("\n")).toContain("Not in this commit: pom.xml.");
    });

    it("tells nothing to a comment the round marked as asking nothing", async () => {
      const h = harness({ review: { ...widened("comment 1"), silent: ["comment 1"] } }, [
        memberAsked,
      ]);

      await advance(h.deps, advanceRequest);

      const told = posts(h).find((body) => body.includes("nothing from this round was pushed"));
      expect(told).not.toContain("the wrapper looks unnecessary");
      expect(told).toContain("> and drop the unused exports while you are in there");
    });
  });

  describe("a round that fails verification, with a solve's repair authority", () => {
    const repairReport = {
      changed: true,
      filesTouched: [FILES[0] ?? ""],
      summary: "deleted the interface the round left declared and unused",
      commitSubject: "fix(advisor): delete the interface the round left unused",
      commitBody: "Removing its export left it unreferenced, which lint refuses.",
      testAdded: false,
      testOmittedReason: "a lint correction",
      residualRisk: "",
      abandoned: "",
      abandonedCause: "none",
    };
    /** The round's own `run test` is red; the repair's re-run is green. A factory, since the first match spends it. */
    const redThenGreen = (): Rule => {
      let failedOnce = false;
      return {
        match: (argv: readonly string[]) => {
          if (failedOnce || !saw("run", "test")(argv)) {
            return false;
          }
          failedOnce = true;
          return true;
        },
        reply: { exitCode: 1 },
      };
    };
    const repairLeftADelta: Rule = {
      match: (argv) =>
        argv.includes("status") && argv.includes(worktree.path) && !argv.includes("-uall"),
      reply: { stdout: ` M ${FILES[0] ?? ""}\n` },
    };

    it("armed, pushes the repair as the round's second commit and says so on the pull request", async () => {
      const h = harness({ review: review(), repair: repairReport }, [
        redThenGreen(),
        repairLeftADelta,
      ]);

      const outcome = await advance(h.deps, { ...advanceRequest, promoteRepair: true });

      expect(outcome).toMatchObject({
        kind: "iterated",
        pushed: true,
        repaired: { notice: { outcome: "posted" } },
      });
      expect(commitSubjects(h)).toEqual([
        "fix(advisor): move the favicon link into the head fragment",
        "fix(advisor): delete the interface the round left unused",
      ]);
      const notice = posts(h).find((body) => body.includes("a repair pass finished"));
      expect(notice).toContain("test did not pass");
      expect(notice).toContain("read that commit on its own");
      expect(notice?.startsWith(BOT_PREFIX)).toBe(true);
    });

    it("replies in the thread when the round that failed was answering one", async () => {
      const h = harness(
        {
          review: review({
            responses: [],
            threadAnswers: [
              {
                threadId: "PRRT_1",
                reply: "Done — appended only when absent.",
                basis: "changed-code",
                resolve: true,
              },
            ],
          }),
        },
        [QUIET, inline(thread()), { match: saw("run", "test"), reply: { exitCode: 1 } }],
      );

      const outcome = await advance(h.deps, { ...advanceRequest, repairRound: false });

      expect(outcome).toMatchObject({ kind: "failed", told: { outcome: "posted" } });
      expect(replies(h)).toEqual([
        expect.stringContaining("its change failed verification: test did not pass"),
      ]);
      // The pass's "Done" described a change that was discarded, so it is not what goes out.
      expect(replies(h).join("")).not.toContain("appended only when absent");
    });

    it("unarmed, pushes nothing and records the verdict in the ledger", async () => {
      const directory = mkdtempSync(join(tmpdir(), "review-repair-ledger-"));
      const h = harness({ review: review(), repair: repairReport }, [
        redThenGreen(),
        repairLeftADelta,
      ]);

      const outcome = await advance(h.deps, { ...advanceRequest, repairLedger: directory });

      expect(outcome).toMatchObject({
        kind: "failed",
        stage: "verification",
        repairOutcome: "verified",
      });
      expect(ran(h, "push")).toBe(false);
      const page = readFileSync(join(directory, "repair-rounds.md"), "utf8");
      expect(page).toContain(
        `| SSX-3822 #42 | verified | ${FILES[0] ?? ""} | ${worktree.path} | unread |`,
      );
    });
  });

  it("does not give up when the only comment left is our own", async () => {
    // Counting our own reply as feedback would undraft while the reviewer is still typing.
    const h = harness({}, [
      {
        match: saw("pr", "view"),
        reply: {
          stdout: JSON.stringify({
            state: "OPEN",
            isDraft: true,
            createdAt: "2026-09-05T09:00:00Z",
            reviews: [{ author: { login: "copilot" }, body: "" }],
            comments: [{ author: { login: "rull3211" }, body: "bot: pushed a fix" }],
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
    const h = harness({}, [spent(3)]);

    const outcome = await advance(h.deps, { ...advanceRequest, maxRounds: 3 });

    expect(outcome).toMatchObject({ kind: "reviewer-exhausted", rounds: 3 });
    expect(h.seen).toEqual([]);
    expect(ran(h, "pr", "ready")).toBe(true);
  });

  it("carries the unanswered comments out when it gives up", async () => {
    const h = harness({}, [spent(3)]);

    const outcome = await advance(h.deps, { ...advanceRequest, maxRounds: 3 });

    if (outcome.kind !== "reviewer-exhausted") {
      throw new Error(`expected exhausted, got ${outcome.kind}`);
    }
    expect(outcome.unresolved).toContain("wrapper element");
  });

  it("does not reserve a round it is not going to run", async () => {
    // The cap must come before the reservation, or a round that stops immediately still gets charged.
    const h = harness({}, [spent(3)]);

    await advance(h.deps, { ...advanceRequest, maxRounds: 3 });

    expect(markerWritten(h)).toBe(false);
  });

  it("cuts no checkout on any outcome decided before a round runs", async () => {
    // The survey is two `gh` reads and names its repository explicitly, so it needs no checkout; unplugging this pays a fetch/checkout/install every tick.
    const cases: readonly { readonly why: string; readonly rules: readonly Rule[] }[] = [
      {
        why: "waiting",
        rules: [
          { match: saw("pr", "view"), reply: { stdout: reviewJson({ reviews: [] } as never) } },
        ],
      },
      {
        why: "ready",
        rules: [
          {
            match: saw("pr", "view"),
            reply: {
              stdout: reviewJson({
                reviews: [{ author: { login: "copilot" }, body: "" }],
              } as never),
            },
          },
        ],
      },
      { why: "reviewer-exhausted", rules: [spent(3)] },
      { why: "capped", rules: [spent(20)] },
    ];

    for (const { why, rules } of cases) {
      const h = harness({}, rules);
      let attached = 0;
      const attach = (): Promise<WorktreeResult> => {
        attached += 1;
        return Promise.resolve({ outcome: "created", worktree } as const);
      };

      await advance(h.deps, { ...advanceRequest, attach, maxRounds: 3, maxTotalRounds: 20 });

      expect(`${why}: ${String(attached)}`).toBe(`${why}: 0`);
    }
  });

  it("reports a refused checkout as its own stage, before anything is spent", async () => {
    // No round has moved and no pass has run, so the honest report is that the machine could not get to the work, not that the work failed.
    const h = harness({}, []);

    const outcome = await advance(h.deps, {
      ...advanceRequest,
      attach: () => Promise.resolve(refusedCheckout),
    });

    expect(outcome).toMatchObject({ kind: "failed", stage: "worktree" });
    expect(h.seen).toEqual([]);
  });

  it("counts the attempt even though it counts no round", async () => {
    // Both round bounds are read out of the marker, so a failure before the checkout is invisible unless this write happens (SSX-3835).
    const h = harness({}, []);

    await advance(h.deps, { ...advanceRequest, attach: () => Promise.resolve(refusedCheckout) });

    expect(markerWritten(h)).toBe(true);
    expect(markerBody(h)).toContain("Failed starts: 1");
    expect(markerBody(h)).toContain("failed to start — the worktree has uncommitted changes");
  });

  it("does not spend a round on an attempt that never got one", async () => {
    // Writing the attempt through the same marker as rounds risks bumping the round count too, which would misreport a stall as exhausted.
    const h = harness({}, [
      board({
        count: 4,
        reviewerCount: 0,
        comments: [dated("the wrapper element looks unnecessary", "2026-09-05T10:00:00Z")],
      }),
    ]);

    await advance(h.deps, { ...advanceRequest, attach: () => Promise.resolve(refusedCheckout) });

    expect(markerBody(h)).toContain("iteration count 4");
    // The high-water mark stays where it was, so the unanswered comments are not skipped next tick.
    expect(markerBody(h)).toContain("Last read: 2026-09-05T08:00:00Z");
  });

  it("keeps counting across attempts rather than restarting at one", async () => {
    // A counter that reset on each attempt would never reach the bound, indistinguishable from the bound being absent.
    const h = harness({}, [stalling(2)]);

    await advance(h.deps, { ...advanceRequest, attach: () => Promise.resolve(refusedCheckout) });

    expect(markerBody(h)).toContain("Failed starts: 3");
  });

  it("still reports the checkout failure when the attempt cannot be recorded", async () => {
    // Two unrelated failures; the round must report the worktree problem, not the comment-write failure.
    const h = harness({}, [
      { match: asked("updateIssueComment"), reply: { exitCode: 1, stderr: "gh: 404" } },
      { match: asked("addComment"), reply: { exitCode: 1, stderr: "gh: 404" } },
    ]);

    const outcome = await advance(h.deps, {
      ...advanceRequest,
      attach: () => Promise.resolve(refusedCheckout),
    });

    expect(outcome).toEqual({
      kind: "failed",
      stage: "worktree",
      reason: refusedCheckout.reason,
    });
  });

  it("stops attempting once the bound is reached, and does not attach to find out", async () => {
    // Fires from the survey, before `attach`, since a salvaging worktree's attempt is a full checkout and install, not a free refusal.
    const h = harness({}, [stalling(3)]);
    let attached = 0;

    const outcome = await advance(h.deps, {
      ...advanceRequest,
      attach: () => {
        attached += 1;
        return Promise.resolve(refusedCheckout);
      },
    });

    expect(outcome).toMatchObject({ kind: "stalled", attempts: 3 });
    expect(attached).toBe(0);
    expect(markerWritten(h)).toBe(false);
  });

  it("carries the last reason into the stall, so the log names the cause", async () => {
    // A stall reporting only "three attempts failed" sends an operator to read the marker to find out what for.
    const h = harness({}, [stalling(3)]);

    const outcome = await advance(h.deps, {
      ...advanceRequest,
      attach: () => Promise.resolve(refusedCheckout),
    });

    // `kind` is asserted alongside the reason: a `failed`/`worktree` outcome carries the same string, so a reason-only check would pass with the bound unplugged.
    expect(outcome).toMatchObject({
      kind: "stalled",
      reason: "the worktree has uncommitted changes",
    });
  });

  it("does not report a stall on a tick that was never going to attach", async () => {
    // The check is last in the survey, and this is why. Every earlier return
    // either needs no checkout or has already stopped for a better reason, so a
    // stall reported here would be a verdict about work this tick never
    // intended to do — and on the `ready` path it would stop a pull request
    // being undrafted by the one outcome that can still do it, over `gh`, for
    // nothing. Move the check to the top of the survey and this goes red.
    // Over the bound *and* with nothing to answer: no comment and no thread, so
    // the survey's own verdict is `ready` and it undrafts over `gh` alone.
    const h = harness({}, [stalling(3, [{ author: { login: "copilot" }, body: "" }])]);

    const outcome = await advance(h.deps, {
      ...advanceRequest,
      attach: () => Promise.resolve(refusedCheckout),
    });

    expect(outcome).toMatchObject({ kind: "ready" });
    expect(ran(h, "pr", "ready")).toBe(true);
  });

  it("lets a pull request that recovered start counting again", async () => {
    // The bound is on consecutive attempts; a reservation proves the machinery works now, so earlier failures are history.
    const h = harness({ review: review() }, [stalling(2)]);

    await advance(h.deps, advanceRequest);

    expect(markerBody(h)).not.toContain("Failed starts:");
  });

  it("does not re-mark a pull request ready that is already out of draft", async () => {
    // Not an optimisation: an unconditional `gh pr ready` would write every tick, forever, on pull requests waiting days for a human merge.
    const h = harness({}, [
      {
        match: saw("pr", "view"),
        reply: {
          stdout: reviewJson({
            isDraft: false,
            reviews: [{ author: { login: "copilot" }, body: "" }],
          } as never),
        },
      },
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "ready" });
    expect(ran(h, "pr", "ready")).toBe(false);
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
    // No re-request either: nothing new on the branch for a reviewer to look at.
    expect(ran(h, "pr", "edit")).toBe(false);
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
      { match: saw("--numstat"), reply: { stdout: REFUSED_DIFF } },
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
            createdAt: "2026-09-05T09:00:00Z",
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

/** The body of the marker this run wrote, or `""` if it wrote none. */
const wrote = (h: Harness): string => {
  const call = h.calls.find(
    (argv) => asked("addComment")(argv) || asked("updateIssueComment")(argv),
  );
  return (call ?? []).find((arg) => arg.startsWith("body="))?.slice("body=".length) ?? "";
};

describe("advance's review cursor", () => {
  /** A pull request with a marker and one dated reviewer comment on it. */
  const withComment = (markCount: number, lastRead: string, commentAt: string): Rule => ({
    match: saw("pr", "view"),
    reply: {
      stdout: JSON.stringify({
        state: "OPEN",
        isDraft: true,
        createdAt: "2026-09-05T09:00:00Z",
        // Dateless, so the review body cannot be what makes the round run, or every test below would pass with no cursor at all.
        reviews: [{ author: { login: "copilot" }, body: "" }],
        comments: [
          markerComment(markCount, lastRead),
          dated("the wrapper element looks unnecessary", commentAt),
        ],
        reviewRequests: [],
      }),
    },
  });

  it("does not act twice on a comment an earlier round already read", async () => {
    // Unplug the high-water mark and the same comment resolves at full solve cost on every tick until the pull request is merged.
    const h = harness({}, [withComment(1, "2026-09-05T10:00:00Z", "2026-09-05T09:00:00Z")]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "ready" });
    expect(h.seen).toEqual([]);
    expect(ran(h, "push")).toBe(false);
  });

  it("acts on a comment written after the mark", async () => {
    // A cursor that never lets anything through is a stopped loop, indistinguishable from the test above.
    const h = harness({ review: review() }, [
      withComment(1, "2026-09-05T09:00:00Z", "2026-09-05T10:00:00Z"),
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "iterated", round: 2 });
  });

  it("treats a comment written at exactly the mark as already read", async () => {
    // Must be strictly newer: equality would re-handle the previous round's newest comment every tick.
    const h = harness({}, [withComment(1, "2026-09-05T10:00:00Z", "2026-09-05T10:00:00Z")]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "ready" });
    expect(h.seen).toEqual([]);
  });

  it("counts the round from the marker rather than from zero", async () => {
    const h = harness({ review: review() }, [spent(2)]);

    const outcome = await advance(h.deps, { ...advanceRequest, maxRounds: 5 });

    expect(outcome).toMatchObject({ kind: "iterated", round: 3 });
  });

  it("refuses the round when the marker will not parse, and does not read it as zero", async () => {
    // A parse failure that fell back to zero would turn a bounded loop unbounded, quietly, on exactly the pull request nobody is watching.
    const h = harness({}, [
      {
        match: saw("pr", "view"),
        reply: {
          stdout: reviewJson({
            comments: [
              { author: { login: "rull3211" }, body: "bot: iteration count nine", id: "IC_bad" },
            ],
          } as never),
        },
      },
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "failed", stage: "cursor" });
    expect(h.seen).toEqual([]);
    expect(markerWritten(h)).toBe(false);
  });

  it("refuses the round when there are two markers, rather than picking one", async () => {
    const h = harness({}, [
      {
        match: saw("pr", "view"),
        reply: {
          stdout: reviewJson({
            comments: [
              markerComment(1, "2026-09-05T08:00:00Z", "IC_a"),
              markerComment(7, "2026-09-05T08:00:00Z", "IC_b"),
            ],
          } as never),
        },
      },
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "failed", stage: "cursor" });
    expect(h.seen).toEqual([]);
  });

  it("reserves the round before running the pass", async () => {
    // Reversed, a failed write would hand back a free round every tick, forever: the count is a reservation, not a receipt.
    const h = harness({ review: review() });

    await advance(h.deps, advanceRequest);

    const reserved = h.calls.findIndex((argv) => asked("addComment")(argv));
    expect(reserved).toBeGreaterThanOrEqual(0);
    // `git show` reading the manifest is the first thing `resolveReview` does.
    expect(h.calls.findIndex((argv) => saw("show")(argv))).toBeGreaterThan(reserved);
  });

  it("does not run the pass when the reservation could not be written", async () => {
    const h = harness({}, [
      { match: asked("addComment"), reply: { exitCode: 1, stderr: "HTTP 403" } },
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "failed", stage: "cursor" });
    expect(h.seen).toEqual([]);
    expect(ran(h, "push")).toBe(false);
  });

  it("posts a marker on a pull request that has none, and edits the one that has", async () => {
    const first = harness({ review: review() });
    await advance(first.deps, advanceRequest);
    expect(ran(first, "graphql")).toBe(true);
    expect(first.calls.some((argv) => asked("updateIssueComment")(argv))).toBe(false);

    const later = harness({ review: review() }, [spent(1)]);
    await advance(later.deps, advanceRequest);
    expect(later.calls.some((argv) => asked("updateIssueComment")(argv))).toBe(true);
    // Not "posted no comment at all" — a round also posts its answer to the
    // review bodies, which is an `addComment` too. The claim is narrower and
    // is the one that matters: no *second marker*, because two markers is a
    // refusal on the next round and a person has to delete one by hand.
    expect(marker(posts(later))).toBe(false);
  });

  it("edits the marker by its node id, and never with --edit-last", async () => {
    // `--edit-last` edits the last comment of the current user, the operator — a round after a human commented would overwrite their words.
    const h = harness({ review: review() }, [spent(1)]);

    await advance(h.deps, advanceRequest);

    const edit = h.calls.find((argv) => asked("updateIssueComment")(argv)) ?? [];
    expect(edit).toContain("id=IC_marker");
    for (const argv of h.calls) {
      expect(argv).not.toContain("--edit-last");
    }
  });

  it("never treats a human's comment as the marker to overwrite", async () => {
    // Nothing but the prefix separates the operator's comments from the bot's; getting this wrong destroys somebody's words.
    const h = harness({ review: review() }, [
      {
        match: saw("pr", "view"),
        reply: {
          stdout: reviewJson({
            comments: [
              {
                author: { login: "rull3211" },
                body: "Can you also handle the empty case?",
                createdAt: "2026-09-05T10:00:00Z",
                id: "IC_human",
              },
            ],
          } as never),
        },
      },
    ]);

    await advance(h.deps, advanceRequest);

    expect(h.calls.some((argv) => asked("updateIssueComment")(argv))).toBe(false);
    for (const argv of h.calls) {
      expect(argv).not.toContain("id=IC_human");
    }
  });

  it("moves the mark to the newest comment it read", async () => {
    const h = harness({ review: review() }, [
      {
        match: saw("pr", "view"),
        reply: {
          stdout: JSON.stringify({
            state: "OPEN",
            isDraft: true,
            createdAt: "2026-09-05T09:00:00Z",
            reviews: [{ author: { login: "copilot" }, body: "" }],
            comments: [
              markerComment(1, "2026-09-05T08:00:00Z"),
              dated("the first point", "2026-09-05T09:00:00Z"),
              dated("the second point", "2026-09-05T11:00:00Z"),
              dated("the third point", "2026-09-05T10:00:00Z"),
            ],
            reviewRequests: [],
          }),
        },
      },
    ]);

    await advance(h.deps, advanceRequest);

    expect(wrote(h)).toContain("Last read: 2026-09-05T11:00:00Z");
    expect(wrote(h)).toContain("bot: iteration count 2");
  });

  it("does not move the mark backwards when the batch came back undated", async () => {
    // An all-undated batch must not reset the cursor to the epoch and re-open every prior comment.
    const h = harness({ review: review() }, [
      {
        match: saw("pr", "view"),
        reply: {
          stdout: reviewJson({
            comments: [markerComment(1, "2026-09-05T08:00:00Z")],
          } as never),
        },
      },
    ]);

    await advance(h.deps, advanceRequest);

    expect(wrote(h)).toContain("Last read: 2026-09-05T08:00:00Z");
  });

  it("writes a marker the next round can read back", async () => {
    // A round that renders something `parseMarker` refuses makes the pull request permanently unadvanceable by its own hand.
    const h = harness({ review: review() });

    await advance(h.deps, advanceRequest);
    const body = wrote(h);
    const reread = parseMarker(body);

    expect(reread.outcome).toBe("parsed");
    expect(body).toContain(`Last read: ${NEVER_READ}`);
  });

  it("stops at the absolute cap without undrafting", async () => {
    // Unlike `exhausted`: a pull request that cost twenty rounds says nothing about whether the code is ready.
    const h = harness({}, [spent(20)]);

    const outcome = await advance(h.deps, { ...advanceRequest, maxRounds: 3, maxTotalRounds: 20 });

    expect(outcome).toMatchObject({ kind: "capped", rounds: 20 });
    expect(ran(h, "pr", "ready")).toBe(false);
    expect(h.seen).toEqual([]);
  });

  it("lets the absolute cap outrank a relaxed reviewer cap", async () => {
    // The caps are separate so raising the policy one cannot step past the brake.
    const h = harness({}, [spent(20)]);

    const outcome = await advance(h.deps, {
      ...advanceRequest,
      maxRounds: 500,
      maxTotalRounds: 20,
    });

    expect(outcome).toMatchObject({ kind: "capped" });
    expect(h.seen).toEqual([]);
  });
});

describe("advance's inline threads", () => {
  const ANSWER = {
    threadId: "PRRT_1",
    reply: "appended only when there is no icon link already — 8235cae",
    basis: "changed-code",
    resolve: true,
  };

  it("runs a round for an open thread even when no issue comment is new", async () => {
    // The gate reads both channels: on #2658 the review's substance lived in threads that `--json` could not see, and the loop undrafted unreviewed.
    const h = harness({ review: review({ threadAnswers: [ANSWER] }) }, [QUIET, inline(thread())]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "iterated", round: 1 });
    expect(ran(h, "pr", "ready")).toBe(false);
  });

  it("does not re-litigate a thread whose last comment is ours", async () => {
    // Keyed on a fact, not a date: a bot restating a settled point leaves no new comment, so nothing time-based could tell this from a fresh objection.
    const h = harness({}, [
      QUIET,
      inline(talking(spoke("copilot", "this is not idempotent"), await ourReply("it is"))),
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "ready" });
    expect(h.seen).toEqual([]);
  });

  it("acts again when the reviewer comes back after our reply", async () => {
    // A rule that never lets a thread through is a loop that stopped listening, and looks identical to the test above.
    const h = harness({ review: review({ threadAnswers: [ANSWER] }) }, [
      QUIET,
      inline(
        talking(
          spoke("copilot", "this is not idempotent"),
          await ourReply("it is"),
          spoke("copilot", "no — bootstrap runs twice under HMR"),
        ),
      ),
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "iterated" });
  });

  it("leaves a thread somebody already resolved alone", async () => {
    const h = harness({}, [QUIET, inline(thread({ isResolved: true }))]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "ready" });
    expect(h.seen).toEqual([]);
  });

  it("hands the pass each thread's id and words, not a summary of them", async () => {
    // On #2658 the pass, given only the review's summary, guessed at what the inline comments said and invented one.
    const h = harness({ review: review({ threadAnswers: [ANSWER] }) }, [QUIET, inline(thread())]);

    await advance(h.deps, advanceRequest);

    expect(h.seen[0]?.options.reviewFeedback).toContain("PRRT_1");
    expect(h.seen[0]?.options.reviewFeedback).toContain("this is not idempotent");
  });

  it("answers the thread only after the commit it talks about is pushed", async () => {
    // Posted before the push, a reply is a public claim about a commit that may never arrive.
    const h = harness({ review: review({ threadAnswers: [ANSWER] }) }, [QUIET, inline(thread())]);

    await advance(h.deps, advanceRequest);

    const pushed = at(h, saw("push"));
    expect(pushed).toBeGreaterThan(-1);
    expect(at(h, asked("addPullRequestReviewThreadReply"))).toBeGreaterThan(pushed);
  });

  it("still answers on a round that changed no code", async () => {
    // The no-change branch is a separate return and was separately capable of staying silent.
    const h = harness({ review: review({ changed: false, threadAnswers: [ANSWER] }) }, [
      QUIET,
      inline(thread()),
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "iterated", threads: { answered: 1, resolved: 1 } });
    expect(ran(h, "push")).toBe(false);
  });

  it("marks its thread reply as its own, so the next round reads it back as answered", async () => {
    // PR #548: `answerThreads` sent the body through untouched and `unansweredThreads` filtered on `isOurs`, but the two halves were never tested together.
    const h = harness({ review: review({ threadAnswers: [ANSWER] }) }, [QUIET, inline(thread())]);

    await advance(h.deps, advanceRequest);

    const posted = replies(h);
    expect(posted).toHaveLength(1);

    // Through the real reader, not a hand-built `ReviewThread`: a prefix lost in parsing would still be caught here.
    const answered = await asLaterRoundSees(
      talking(spoke("copilot", "this is not idempotent"), spoke(OPERATOR, posted[0] ?? "")),
    );
    expect(unansweredThreads(answered)).toEqual([]);

    // Control: the same thread with the reviewer speaking last is still owed an answer.
    const reopened = await asLaterRoundSees(
      talking(
        spoke(OPERATOR, posted[0] ?? ""),
        spoke("copilot", "no, the guard is on the wrong branch"),
      ),
    );
    expect(unansweredThreads(reopened)).toHaveLength(1);
  });

  it("posts nothing on a thread it was never given", async () => {
    // The id is model-authored, so it is untrusted like every other field the pass fills in.
    const h = harness(
      { review: review({ threadAnswers: [{ ...ANSWER, threadId: "PRRT_elsewhere" }] }) },
      [QUIET, inline(thread())],
    );

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "iterated", threads: { answered: 0, resolved: 0 } });
    expect(at(h, asked("addPullRequestReviewThreadReply"))).toBe(-1);
    expect((outcome as { threads: { failures: readonly string[] } }).threads.failures[0]).toContain(
      "PRRT_elsewhere",
    );
  });

  it("does not close a thread whose reply would not post", async () => {
    // Resolving is how a reviewer's queue gets shorter, so a thread closed
    // without the argument arriving buries the objection. The resolve takes the
    // reply's receipt for exactly this reason; unplug it and this fails.
    const h = harness({ review: review({ threadAnswers: [ANSWER] }) }, [
      QUIET,
      inline(thread()),
      {
        match: asked("addPullRequestReviewThreadReply"),
        reply: { exitCode: 1, stderr: "HTTP 502" },
      },
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "iterated", threads: { answered: 0, resolved: 0 } });
    expect(at(h, asked("resolveReviewThread"))).toBe(-1);
    expect((outcome as { threads: { failures: readonly string[] } }).threads.failures).toHaveLength(
      1,
    );
  });

  it("keeps a pushed round when the reply would not post, and says so out loud", async () => {
    // Discarding a healthy pushed round over a comment that would not send helps nobody; the silence is the part that is not acceptable.
    const h = harness({ review: review({ threadAnswers: [ANSWER] }) }, [
      QUIET,
      inline(thread()),
      {
        match: asked("addPullRequestReviewThreadReply"),
        reply: { exitCode: 1, stderr: "HTTP 502" },
      },
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "iterated" });
    expect(ran(h, "push")).toBe(true);
  });

  it("fails the round when the inline comments cannot be read at all", async () => {
    // Half a review is worse than none: `readReviewThreads` refuses rather than returning a short list, and this call site must not soften that.
    const h = harness({ review: review() }, [
      QUIET,
      { match: asked("reviewThreads"), reply: { exitCode: 1, stderr: "HTTP 502" } },
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "failed", stage: "read" });
    expect(h.seen).toEqual([]);
    expect(markerWritten(h)).toBe(false);
  });

  it("names the open thread when it gives up on the pull request", async () => {
    // `unresolved` tells a human to stop the loop and look; on a capped pull request the threads are most of what is still open.
    const h = harness({}, [spent(20), inline(thread())]);

    const outcome = await advance(h.deps, { ...advanceRequest, maxTotalRounds: 20 });

    expect(outcome).toMatchObject({ kind: "capped" });
    expect((outcome as { unresolved: string }).unresolved).toContain(
      "src/app/head.tsx:19 — this is not idempotent",
    );
  });
});

const said = (author: string, body: string, origin: ReviewOrigin = "reviewer"): ReviewComment => ({
  author,
  body,
  createdAt: "2026-09-05T10:00:00Z",
  id: "IC_1",
  origin,
  member: false,
});

const stateWith = (...comments: readonly ReviewComment[]): ReviewState => ({
  anyoneResponded: true,
  reviewerErrored: false,
  state: "OPEN",
  isDraft: true,
  createdAt: "2026-09-05T09:00:00Z",
  newestAt: "2026-09-05T10:00:00Z",
  comments,
});

describe("reviewerComments", () => {
  it("drops our own comments, so a round is not fed its own replies", () => {
    const theirs = said("copilot", "the wrapper looks unnecessary");
    const state = stateWith(theirs, said("rull3211", "bot: moved it, as suggested"));

    expect(reviewerComments(state)).toEqual([theirs]);
  });

  it("keeps a comment posted from the account the bot posts under", () => {
    // `gh` is authenticated as the operator, so a human comment and the bot's own arrive with the same author (verified on PR #2658).
    const human = said("rull3211", "Can you also handle the empty case?");

    expect(reviewerComments(stateWith(human))).toEqual([human]);
  });

  it("does not claim a comment that merely mentions the prefix", () => {
    const human = said("copilot", "The `bot: ` prefix is missing from this reply.");

    expect(reviewerComments(stateWith(human))).toEqual([human]);
  });

  it("keeps everything when none of it is ours", () => {
    expect(reviewerComments(stateWith(said("copilot", "a")))).toHaveLength(1);
  });
});

describe("advance's round classification", () => {
  const REVIEWER = { author: { login: "copilot" }, body: "the wrapper looks unnecessary" };

  /** A review with an empty body, opening the `waiting` gate without contributing a comment of its own. */
  const APPROVED = { author: { login: "copilot" }, body: "" };

  it("wakes for a person who commented before the reviewer did", async () => {
    // `waiting` asked whether the requested reviewer had spoken, narrower than the list behind it, so a human review went unread.
    const h = harness({ review: review() }, [
      board({ count: 0, reviewerCount: 0, comments: [fromHuman("please rename this")] }),
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome.kind).not.toBe("waiting");
    expect(h.seen).toHaveLength(1);
  });

  it("runs a round for a person after the reviewer's budget is spent", async () => {
    // `MAX_REVIEW_ITERATIONS` bounds two machines talking past each other; a person's request is exactly the outside information the cap protects against the absence of.
    const h = harness({ review: review() }, [
      board({ count: 3, reviewerCount: 3, comments: [fromHuman("please rename this")] }),
    ]);

    const outcome = await advance(h.deps, { ...advanceRequest, maxRounds: 3 });

    expect(outcome.kind).not.toBe("reviewer-exhausted");
    expect(h.seen).toHaveLength(1);
  });

  it("counts a mixed batch as a human round", async () => {
    // Over-counting silently declines a person's request because a bot commented in the same window; under-counting only costs one extra round.
    const h = harness({ review: review() }, [
      board({
        count: 3,
        reviewerCount: 3,
        reviews: [REVIEWER],
        comments: [fromHuman("and please rename this")],
      }),
    ]);

    const outcome = await advance(h.deps, { ...advanceRequest, maxRounds: 3 });

    expect(outcome.kind).not.toBe("reviewer-exhausted");
    expect(h.seen).toHaveLength(1);
  });

  it("leaves the reviewer count where it was on a human round", async () => {
    const h = harness({ review: review() }, [
      board({ count: 1, reviewerCount: 1, comments: [fromHuman("please rename this")] }),
    ]);

    await advance(h.deps, advanceRequest);

    // The total moves (the absolute brake counts everything), the reviewer's half does not.
    expect(wrote(h)).toContain("bot: iteration count 2");
    expect(wrote(h)).toContain("Reviewer rounds: 1");
  });

  it("spends the reviewer count on a reviewer-only round", async () => {
    const h = harness({ review: review() }, [
      board({ count: 1, reviewerCount: 1, reviews: [REVIEWER] }),
    ]);

    await advance(h.deps, advanceRequest);

    expect(wrote(h)).toContain("bot: iteration count 2");
    expect(wrote(h)).toContain("Reviewer rounds: 2");
  });

  it("still stops a human at the absolute cap", async () => {
    // `MAX_PR_ROUNDS_TOTAL` is a brake on the machinery, not a reviewer policy; one a person's comment could step past is not a brake.
    const h = harness({ review: review() }, [
      board({ count: 20, reviewerCount: 0, comments: [fromHuman("one more thing")] }),
    ]);

    const outcome = await advance(h.deps, { ...advanceRequest, maxTotalRounds: 20 });

    expect(outcome).toMatchObject({ kind: "capped", rounds: 20 });
    expect(h.seen).toEqual([]);
  });

  it("reads a thread's origin from whoever raised the point", async () => {
    // The first comment, not the last — reading the newest would let any passer-by reset the reviewer's budget by agreeing with it.
    const h = harness({ review: review() }, [
      board({ count: 3, reviewerCount: 3, reviews: [APPROVED] }),
      inline(talking(spoke("copilot", "this is not idempotent"), spoke("a-colleague", "agreed"))),
    ]);

    const outcome = await advance(h.deps, { ...advanceRequest, maxRounds: 3 });

    expect(outcome).toMatchObject({ kind: "reviewer-exhausted" });
  });

  it("treats a thread a person opened as a human round", async () => {
    const h = harness({ review: review() }, [
      board({ count: 3, reviewerCount: 3, reviews: [APPROVED] }),
      inline(talking(spoke("a-colleague", "this needs a null check"))),
    ]);

    const outcome = await advance(h.deps, { ...advanceRequest, maxRounds: 3 });

    expect(outcome.kind).not.toBe("reviewer-exhausted");
    expect(h.seen).toHaveLength(1);
  });

  it("undrafts and keeps listening when the reviewer's budget runs out", async () => {
    // `exhausted` is not a terminal: the pull request comes out of draft and a later human comment still gets a round.
    const h = harness({ review: review() }, [
      board({ count: 3, reviewerCount: 3, reviews: [REVIEWER] }),
    ]);

    const outcome = await advance(h.deps, { ...advanceRequest, maxRounds: 3 });

    expect(outcome).toMatchObject({ kind: "reviewer-exhausted", rounds: 3 });
    expect(ran(h, "pr", "ready")).toBe(true);
  });
});

describe("advance's merge round", () => {
  const CONFLICTED = "src/utils/DateUtils.ts";

  /** An attach that got a clean checkout and a base that will not merge into it. */
  const conflicted: AdvanceRequest = {
    ...advanceRequest,
    attach: () =>
      Promise.resolve({
        outcome: "conflicted",
        worktree,
        behind: 7,
        files: [CONFLICTED],
      } as const),
  };

  /** A reviewer waiting for an answer, so the survey does not return `waiting`. */
  const WAITING_REVIEWER = dated("this still allocates on every render", "2026-09-05T10:00:00Z");

  /** Seven commits behind, and the merge goes through on its own. */
  const BEHIND: Rule = { match: saw("rev-list", "--count"), reply: { stdout: "7\n" } };

  it("spends a round on the base and leaves the review where it found it", async () => {
    const h = harness({}, [
      board({ count: 2, reviewerCount: 1, reviews: [WAITING_REVIEWER] }),
      BEHIND,
    ]);

    const outcome = await advance(h.deps, conflicted);

    expect(outcome).toEqual({ kind: "synced", round: 3, behind: 7, conflicts: [] });
    const body = markerBody(h);
    // The total moves: a merge round costs money like any other.
    expect(body).toContain("iteration count 3");
    // The reviewer's own budget does not; spending a turn here would tell the reviewer the loop was out of turns because a base moved.
    expect(body).toContain("Reviewer rounds: 1");
    // The high-water mark does not move either, since nothing read a comment.
    expect(body).toContain("Last read: 2026-09-05T08:00:00Z");
    expect(body).not.toContain("2026-09-05T10:00:00Z");
    // Said out loud: otherwise a round that answers nobody looks like a round that ignored the review.
    expect(body).toContain("round 3 — merge");
  });

  it("does not touch the branch when the round could not be reserved", async () => {
    // Fails closed exactly as a review round does: no marker, no round, including the git half that would otherwise push an uncounted merge commit.
    const h = harness({}, [
      { match: asked("addComment"), reply: { exitCode: 1, stderr: "gh: rate limited" } },
      BEHIND,
    ]);

    const outcome = await advance(h.deps, conflicted);

    expect(outcome).toMatchObject({ kind: "failed", stage: "cursor" });
    expect(ran(h, "merge")).toBe(false);
    expect(ran(h, "push")).toBe(false);
    expect(h.seen).toEqual([]);
  });

  it("reports a branch that turned out to be current as a sync of nothing", async () => {
    // The base moved between the conflicted attach and this round; the branch already containing it is the round's goal state, not a failure.
    const h = harness({}, [
      board({ count: 0, reviewerCount: 0, reviews: [WAITING_REVIEWER] }),
      { match: saw("rev-list", "--count"), reply: { stdout: "0\n" } },
    ]);

    const outcome = await advance(h.deps, conflicted);

    expect(outcome).toEqual({ kind: "synced", round: 1, behind: 0, conflicts: [] });
    expect(h.seen).toEqual([]);
  });

  it("carries the resolved paths out of the pass's report", async () => {
    const h = harness(
      {
        merge: {
          resolved: true,
          resolutions: [{ path: CONFLICTED, took: "both", why: "kept both sides" }],
          summary: "merged origin/main",
          abandoned: "",
          injectionNoticed: "",
        },
      },
      [
        board({ count: 0, reviewerCount: 0, reviews: [WAITING_REVIEWER] }),
        BEHIND,
        { match: saw("merge", "--no-edit"), reply: { exitCode: 1, stderr: "CONFLICT (content)" } },
        { match: once(saw("--diff-filter=U")), reply: { stdout: `${CONFLICTED}\n` } },
        // `git grep` exits 1 when it finds nothing; the fake's default of 0 would read as markers found.
        { match: saw("grep"), reply: { exitCode: 1 } },
      ],
    );

    const outcome = await advance(h.deps, conflicted);

    expect(outcome).toEqual({ kind: "synced", round: 1, behind: 7, conflicts: [CONFLICTED] });
    expect(h.seen.map((run) => run.pass)).toEqual(["merge"]);
  });

  it("does not call a merge that would not push a sync", async () => {
    // `pushBranch` resets to `ORIG_HEAD` on a failed push, so nothing downstream may read this as merged; stage is `merge` since the plumbing broke, not verification.
    const h = harness({}, [
      board({ count: 0, reviewerCount: 0, reviews: [WAITING_REVIEWER] }),
      BEHIND,
      { match: saw("push"), reply: { exitCode: 1, stderr: "! [rejected]" } },
    ]);

    const outcome = await advance(h.deps, conflicted);

    expect(outcome).toMatchObject({ kind: "failed", stage: "merge" });
  });
});
