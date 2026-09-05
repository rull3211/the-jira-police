import { describe, expect, it } from "vitest";

import {
  type AdvanceRequest,
  type PublishRequest,
  advance,
  publish,
  reviewerComments,
} from "./delivery.ts";
import { BOT_PREFIX, MARKER_PREFIX, NEVER_READ, parseMarker } from "./marker.ts";
import type { PassRunner, SolveDependencies } from "./orchestrator.ts";
import type { BotIdentity, ReviewComment, ReviewOrigin, ReviewState } from "./pr.ts";
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
  threadAnswers: [],
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

/**
 * A marker comment as `gh pr view --json comments` returns it.
 *
 * Carries an `id`, because `findMarker` refuses a marker it could not edit and
 * a fixture without one would exercise that refusal rather than the cursor.
 */
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

/** The bodies of every comment the run posted, in order. */
const posts = (h: Harness): readonly string[] =>
  h.calls
    .filter((argv) => asked("addComment")(argv))
    // `gh api graphql` passes each variable as its own `-f key=value`, and the
    // last element is the query, not the body. Reading `at(-1)` returns the
    // mutation text for every call and silently matches nothing.
    .map((argv) => argv.find((element) => element.startsWith("body=")) ?? "")
    .map((body) => body.slice("body=".length));

/** Does any of these bodies claim to be the iteration marker? */
const marker = (bodies: readonly string[]): boolean =>
  bodies.some((body) => body.startsWith(MARKER_PREFIX));

/** Did the run write the marker at all — either the first post or a later edit? */
const markerWritten = (h: Harness): boolean =>
  h.calls.some((argv) => asked("addComment")(argv) || asked("updateIssueComment")(argv));

/** A pull request that already carries a marker saying `count` rounds are gone. */
const spent = (count: number, lastRead = "2026-09-05T08:00:00Z"): Rule => ({
  match: saw("pr", "view"),
  reply: { stdout: reviewJson({ comments: [markerComment(count, lastRead)] } as never) },
});

/**
 * A pull request spelled out whole: both counts on the marker, and exactly the
 * reviews and comments named. Used by the round-classification tests, which are
 * the only ones that care that the two counts can differ and that the reviews
 * list can be empty while the comments list is not.
 */
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

/**
 * A pull request whose reviewer has spoken and left no issue comment at all.
 *
 * Lets a test distinguish "the round ran because of the thread" from "the round
 * ran because of a comment", and — since `advance` now posts its answer to the
 * comment channel — "it said nothing because there was nothing to say".
 */
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
    // A Node base: `pom.xml` is absent. Answering every `git show` with the
    // manifest would make the base look like it declared both toolchains, and
    // `verify` refuses that rather than choosing.
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
    // The marker's three GraphQL calls. All succeed by default, so a test that
    // wants a failed reservation has to say so — the reservation refusing is
    // the interesting case and must not be reachable by forgetting a fixture.
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
    // The two thread writes, both succeeding by default for the same reason: a
    // test about a reply that would not post has to arrange that failure, so it
    // cannot be reached by leaving a fixture out.
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
  maxRounds: 3,
  maxTotalRounds: 20,
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
    // Only `exhausted` used to carry this, so on a round that worked the field
    // the skill calls "what tells a human to stop the loop and look" was read
    // and dropped. Both construction sites, because they are separate returns
    // and a fix to one leaves the other silent.
    const h = harness({ review: report });

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({
      kind: "iterated",
      unresolved: "the second point needs a product decision",
    });
  });

  // `publish` already treats a failed reviewer request as its own outcome.
  // `advance` used to discard the same result while its type said "the reviewer
  // was asked again", so the one caller that could act on it was never told.
  it("reports that the re-request failed instead of claiming the reviewer was asked", async () => {
    const h = harness({ review: review() }, [
      {
        match: saw("pr", "edit"),
        reply: { exitCode: 1, stderr: "HTTP 403: Resource not accessible" },
      },
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    // Still an iterated round: the code is pushed and the pull request is
    // healthy. Only the notification is missing, and a human can supply it.
    expect(outcome).toMatchObject({ kind: "iterated", round: 1, reviewerRequested: "failed" });
    expect(ran(h, "push")).toBe(true);
  });

  it("does not undraft a pull request whose re-request failed", async () => {
    // The dangerous reading of "the reviewer never came back" is to give up and
    // mark it ready. With the cursor in place the next tick sees nothing new
    // and undrafts by itself, which is bad enough; doing it on the very round
    // that failed to notify anyone would put an unreviewed pull request in
    // front of a reviewer who was never asked.
    const h = harness({ review: review() }, [
      { match: saw("pr", "edit"), reply: { exitCode: 1, stderr: "HTTP 403" } },
    ]);

    await advance(h.deps, advanceRequest);

    expect(ran(h, "pr", "ready")).toBe(false);
  });

  it("does not ask the reviewer to re-read a tree it did not change", async () => {
    // Measured on PR #2658. The round at 12:23 changed no code, re-requested
    // review anyway, and Copilot re-reviewed the identical tree at 12:28 and
    // restated its previous verdict. That is a paid review whose only possible
    // output is the one already on the pull request, and the loop then has to
    // spend a round reading it. `changed: false` is what routes here — a review
    // that raised only questions, answered without an edit.
    const h = harness({ review: review({ changed: false }) });

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "iterated", reviewerRequested: "unnecessary" });
    expect(ran(h, "pr", "edit")).toBe(false);
    // Proves it took the no-change path rather than duplicating the test above.
    expect(ran(h, "push")).toBe(false);
  });

  it("does not report a failed re-request when it never made one", async () => {
    // The reading that would undo the fix. "Not asked" and "asked and it did
    // not work" are the same boolean and opposite instructions: one is a person
    // clicking the reviewer in, the other is nothing to do. A round that
    // pushed nothing must not send anybody after that button.
    const h = harness({ review: review({ changed: false }) }, [
      { match: saw("pr", "edit"), reply: { exitCode: 1, stderr: "HTTP 403" } },
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ reviewerRequested: "unnecessary" });
  });

  it("does not claim to have pushed on a round that changed nothing", async () => {
    // Found on round 2 of PR #2658: the round deliberately changed no code and
    // the headline still read "round 2 pushed". The kind does not imply the
    // push, so the round has to carry the fact.
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
    // The path between the other two, and the one a reader would miss: the pass
    // says it changed files, and `git commit` then finds the tree identical —
    // a rewrite that reproduced the file byte for byte. Nothing reaches the
    // branch, so nothing may be claimed, and the model's own `changed` flag is
    // the wrong thing to have believed.
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
    // Round 3 of PR #2658: Copilot's feedback was a summary review, which has
    // no thread to reply to, so the pass's refutation went to the operator's
    // terminal and the reviewer's objection stood unanswered in public.
    const h = harness({ review: review({ changed: false, responses: ["Checked: no icon link"] }) });

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ spoken: { outcome: "posted" } });
    expect(posts(h).some((body) => body.includes("Checked: no icon link"))).toBe(true);
  });

  it("prefixes what it posts, so the next round does not read it as feedback", async () => {
    // There is no login to key on — `gh` posts as the operator — so `bot: ` is
    // the only thing separating our own words from a reviewer's. Without it the
    // loop is handed its own last answer and argues with itself.
    const h = harness({ review: review({ changed: false, responses: ["answered"] }) });

    await advance(h.deps, advanceRequest);

    const spoken = posts(h).filter((body) => !body.startsWith(MARKER_PREFIX));
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.startsWith(BOT_PREFIX)).toBe(true);
    expect(reviewerComments({ comments: [{ body: spoken[0] ?? "" }] } as never)).toEqual([]);
  });

  it("says nothing on the pull request when every comment had a thread", async () => {
    // The bot chatter the marker section refuses to add. A round whose input
    // was entirely inline has already answered in the right place.
    const h = harness({ review: review({ changed: false }) }, [QUIET, inline(thread())]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ spoken: { outcome: "nothing-to-say" } });
    expect(posts(h).filter((body) => !body.startsWith(MARKER_PREFIX))).toEqual([]);
  });

  it("takes the pull request out of draft when the round changed nothing", async () => {
    // This side is finished: nothing new to re-read, nothing more the loop can
    // do. A later tick would clear the draft only if nothing new arrived, so on
    // an active pull request it never clears and a human reviews something
    // flagged unfinished.
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
    // The round did its work. Discarding it over a failed transition would
    // throw away a paid pass; hiding the failure sends nobody to the button.
    const h = harness({ review: review({ changed: false }) }, [
      { match: saw("pr", "ready"), reply: { exitCode: 1, stderr: "HTTP 403" } },
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "iterated", undrafted: "failed" });
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
    //
    // Note the author: our own comment arrives under the operator's login,
    // because that is who `gh` is authenticated as. Only the prefix marks it.
    const h = harness({ review: review() }, [
      {
        match: saw("pr", "view"),
        reply: {
          stdout: JSON.stringify({
            state: "OPEN",
            isDraft: true,
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

  it("does not give up when the only comment left is our own", async () => {
    // Our reply is not feedback. Counting it would spend rounds answering
    // ourselves, and here it would undraft while the reviewer is still typing.
    // Again under the operator's login, and again told apart by the prefix.
    const h = harness({}, [
      {
        match: saw("pr", "view"),
        reply: {
          stdout: JSON.stringify({
            state: "OPEN",
            isDraft: true,
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
    // The reservation comes before the pass, so the cap has to come before the
    // reservation. Bumping the count on a round that stops immediately would
    // charge a pull request for the ticks that report it is out of rounds.
    const h = harness({}, [spent(3)]);

    await advance(h.deps, { ...advanceRequest, maxRounds: 3 });

    expect(markerWritten(h)).toBe(false);
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
    // And no re-request either, for the reason the test below this one gives:
    // there is nothing new on the branch for a reviewer to look at.
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
        // Dateless, so the review body itself cannot be what makes the round
        // run — otherwise every test below would pass with no cursor at all.
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
    // **The mutation that matters most in the whole feature.** Unplug the
    // high-water mark and this fails: the same comment is resolved on every
    // tick, at full solve cost, until somebody merges the pull request. The
    // round cap bounds that today and D4 removes the cap for human feedback,
    // which is exactly the feedback that sits unanswered the longest.
    const h = harness({}, [withComment(1, "2026-09-05T10:00:00Z", "2026-09-05T09:00:00Z")]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "ready" });
    expect(h.seen).toEqual([]);
    expect(ran(h, "push")).toBe(false);
  });

  it("acts on a comment written after the mark", async () => {
    // The other half of the same mutation. A cursor that never lets anything
    // through is a loop that has stopped, and it would look identical to the
    // test above.
    const h = harness({ review: review() }, [
      withComment(1, "2026-09-05T09:00:00Z", "2026-09-05T10:00:00Z"),
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "iterated", round: 2 });
  });

  it("treats a comment written at exactly the mark as already read", async () => {
    // Strictly newer. Equality here re-handles the newest comment of the
    // previous round on every tick — the same runaway, arriving as an
    // off-by-one rather than as a missing feature.
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
    // Losing the count is how a bounded loop becomes an unbounded one, quietly,
    // on the one pull request whose marker got mangled — which is also the one
    // nobody is watching. Make the parse failure fall back to zero and this
    // fails: the round runs, and it runs again every tick after that.
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
    // Reverse this ordering and a failed write hands back a free round, every
    // tick, forever. The count is a reservation, not a receipt.
    const h = harness({ review: review() });

    await advance(h.deps, advanceRequest);

    const reserved = h.calls.findIndex((argv) => asked("addComment")(argv));
    expect(reserved).toBeGreaterThanOrEqual(0);
    // Every command the pass causes comes after it. `git show` reading the
    // manifest is the first thing `resolveReview` does.
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
    // `gh pr comment --edit-last` edits the last comment of the *current user*,
    // and the current user is the operator. A round running after a human
    // commented would overwrite that person's words with machine state.
    const h = harness({ review: review() }, [spent(1)]);

    await advance(h.deps, advanceRequest);

    const edit = h.calls.find((argv) => asked("updateIssueComment")(argv)) ?? [];
    expect(edit).toContain("id=IC_marker");
    for (const argv of h.calls) {
      expect(argv).not.toContain("--edit-last");
    }
  });

  it("never treats a human's comment as the marker to overwrite", async () => {
    // The operator's own comment arrives under the same login the bot posts as,
    // so nothing but the prefix separates them. Getting this wrong destroys
    // somebody's words rather than costing money.
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
    // An all-undated batch must not reset the cursor to the epoch and re-open
    // every comment before it. The comments are still handled; they just do not
    // get to say when.
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
    // A round that renders something `parseMarker` refuses makes the pull
    // request permanently unadvanceable, by its own hand. The first round has
    // no mark to keep and its comments may be undated, which is where the
    // tempting empty string would land.
    const h = harness({ review: review() });

    await advance(h.deps, advanceRequest);
    const body = wrote(h);
    const reread = parseMarker(body);

    expect(reread.outcome).toBe("parsed");
    expect(body).toContain(`Last read: ${NEVER_READ}`);
  });

  it("stops at the absolute cap without undrafting", async () => {
    // Unlike `exhausted`. A pull request that has cost twenty rounds says
    // nothing about whether the code is ready, and undrafting on it would be
    // the loop reporting a verdict it did not reach.
    const h = harness({}, [spent(20)]);

    const outcome = await advance(h.deps, { ...advanceRequest, maxRounds: 3, maxTotalRounds: 20 });

    expect(outcome).toMatchObject({ kind: "capped", rounds: 20 });
    expect(ran(h, "pr", "ready")).toBe(false);
    expect(h.seen).toEqual([]);
  });

  it("lets the absolute cap outrank a relaxed reviewer cap", async () => {
    // The two caps are separate so that raising the policy one cannot step past
    // the brake. Check the reviewer's budget first and this returns `exhausted`
    // — or worse, runs — on a pull request the brake has already stopped.
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
    // The gate reads both channels, and this is the half that was missing on
    // #2658: the substance of that review lived in the threads, `--json` could
    // not see it, and the loop marked the pull request reviewed. Make the gate
    // consider comments alone and this undrafts over an unanswered review.
    const h = harness({ review: review({ threadAnswers: [ANSWER] }) }, [QUIET, inline(thread())]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "iterated", round: 1 });
    expect(ran(h, "pr", "ready")).toBe(false);
  });

  it("does not re-litigate a thread whose last comment is ours", async () => {
    // The instability rule, keyed on a fact rather than a date: a bot reviewer
    // restating a settled point leaves no new comment, so nothing time-based
    // could tell this from a fresh objection. Unplug it and the round argues
    // with an answer it already gave, every tick, at full solve cost.
    const h = harness({}, [
      QUIET,
      inline(talking(spoke("copilot", "this is not idempotent"), spoke("rull3211", "bot: it is"))),
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "ready" });
    expect(h.seen).toEqual([]);
  });

  it("acts again when the reviewer comes back after our reply", async () => {
    // The other half of the rule. One that never lets a thread through is a
    // loop that has stopped listening, and it looks identical to the test above.
    const h = harness({ review: review({ threadAnswers: [ANSWER] }) }, [
      QUIET,
      inline(
        talking(
          spoke("copilot", "this is not idempotent"),
          spoke("rull3211", "bot: it is"),
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
    // #2658 again: the pass was given the review's one-line summary, inferred
    // what the inline comments must have said, guessed one of them right and
    // invented the other. It gets the text now, and the id it has to quote back.
    const h = harness({ review: review({ threadAnswers: [ANSWER] }) }, [QUIET, inline(thread())]);

    await advance(h.deps, advanceRequest);

    expect(h.seen[0]?.options.reviewFeedback).toContain("PRRT_1");
    expect(h.seen[0]?.options.reviewFeedback).toContain("this is not idempotent");
  });

  it("answers the thread only after the commit it talks about is pushed", async () => {
    // A reply says what changed. Posted before the push it is a public claim
    // about a commit that may never arrive, and the reviewer reads an answer to
    // a change that is not there.
    const h = harness({ review: review({ threadAnswers: [ANSWER] }) }, [QUIET, inline(thread())]);

    await advance(h.deps, advanceRequest);

    const pushed = at(h, saw("push"));
    expect(pushed).toBeGreaterThan(-1);
    expect(at(h, asked("addPullRequestReviewThreadReply"))).toBeGreaterThan(pushed);
  });

  it("still answers on a round that changed no code", async () => {
    // The no-change branch is a separate return and was separately capable of
    // staying silent. A round that answered without editing has answered, and
    // the argument belongs next to the comment rather than in a terminal.
    const h = harness({ review: review({ changed: false, threadAnswers: [ANSWER] }) }, [
      QUIET,
      inline(thread()),
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome).toMatchObject({ kind: "iterated", threads: { answered: 1, resolved: 1 } });
    expect(ran(h, "push")).toBe(false);
  });

  it("posts nothing on a thread it was never given", async () => {
    // The id is model-authored, so it is untrusted like every other field the
    // pass fills in. One that came from nowhere addresses a conversation this
    // round never read, and answering it is the loop talking to a stranger.
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
    // The same trade `reviewerRequested` makes. The code is pushed and the pull
    // request is healthy; discarding the round over a comment that would not
    // send helps nobody. Silence is the part that is not acceptable.
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
    // Half a review is worse than none: the round would resolve what it did see
    // and undraft on the strength of it. `readReviewThreads` refuses rather than
    // returning a short list, and this call site must not soften that.
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
    // `unresolved` is what tells a human to stop the loop and look, and on a
    // capped pull request the threads are most of what is still open.
    const h = harness({}, [spent(20), inline(thread())]);

    const outcome = await advance(h.deps, { ...advanceRequest, maxTotalRounds: 20 });

    expect(outcome).toMatchObject({ kind: "capped" });
    expect((outcome as { unresolved: string }).unresolved).toContain(
      "src/app/head.tsx:19 — this is not idempotent",
    );
  });
});

const said = (
  author: string,
  body: string,
  origin: ReviewOrigin = "reviewer",
): ReviewComment => ({
  author,
  body,
  createdAt: "2026-09-05T10:00:00Z",
  id: "IC_1",
  origin,
});

const stateWith = (...comments: readonly ReviewComment[]): ReviewState => ({
  anyoneResponded: true,
  reviewerErrored: false,
  state: "OPEN",
  isDraft: true,
  comments,
});

describe("reviewerComments", () => {
  it("drops our own comments, so a round is not fed its own replies", () => {
    const theirs = said("copilot", "the wrapper looks unnecessary");
    const state = stateWith(theirs, said("rull3211", "bot: moved it, as suggested"));

    expect(reviewerComments(state)).toEqual([theirs]);
  });

  it("keeps a comment posted from the account the bot posts under", () => {
    // The mutation whose failure destroys somebody's words rather than costing
    // money. `gh` is authenticated as the operator, so this human comment and
    // the bot's own arrive with the same author — verified on PR #2658. Only
    // the prefix separates them.
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

  /**
   * A review with nothing in the body, which is what an inline comment arrives
   * under. It opens the `waiting` gate — somebody spoke — and contributes no
   * comment of its own, so the two thread tests below get a batch that is
   * entirely inline and can be classified by the thread alone.
   */
  const APPROVED = { author: { login: "copilot" }, body: "" };

  it("wakes for a person who commented before the reviewer did", async () => {
    // The comment was always collected; the gate threw it away. `waiting` asked
    // whether the *requested reviewer* had spoken, which is a narrower question
    // than the list behind it answers, so a human review on a pull request the
    // bot reviewer had not reached yet went unread.
    const h = harness({ review: review() }, [
      board({ count: 0, reviewerCount: 0, comments: [fromHuman("please rename this")] }),
    ]);

    const outcome = await advance(h.deps, advanceRequest);

    expect(outcome.kind).not.toBe("waiting");
    expect(h.seen).toHaveLength(1);
  });

  it("runs a round for a person after the reviewer's budget is spent", async () => {
    // The user's rule, and the reason for it: `MAX_REVIEW_ITERATIONS` bounds two
    // machines talking to each other, because nothing in that conversation adds
    // information from outside it. A person asking for a change is exactly the
    // outside information the cap protects against the absence of. Capping it
    // would be the bot telling a reviewer it has run out of turns.
    const h = harness({ review: review() }, [
      board({ count: 3, reviewerCount: 3, comments: [fromHuman("please rename this")] }),
    ]);

    const outcome = await advance(h.deps, { ...advanceRequest, maxRounds: 3 });

    expect(outcome.kind).not.toBe("reviewer-exhausted");
    expect(h.seen).toHaveLength(1);
  });

  it("counts a mixed batch as a human round", async () => {
    // Where the rule is easiest to get subtly wrong, and the asymmetry decides
    // it: over-counting silently declines work a person asked for because a bot
    // happened to comment in the same window, under-counting spends one more
    // round. Only one of those is recoverable by whoever notices.
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

    // The total moves — the absolute brake counts everything — and the
    // reviewer's half does not.
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
    // `MAX_PR_ROUNDS_TOTAL` is a brake on the machinery rather than a policy
    // about a reviewer, and a brake a person's comment could step past is not a
    // brake. This is the half of the split that human feedback does not lift.
    const h = harness({ review: review() }, [
      board({ count: 20, reviewerCount: 0, comments: [fromHuman("one more thing")] }),
    ]);

    const outcome = await advance(h.deps, { ...advanceRequest, maxTotalRounds: 20 });

    expect(outcome).toMatchObject({ kind: "capped", rounds: 20 });
    expect(h.seen).toEqual([]);
  });

  it("reads a thread's origin from whoever raised the point", async () => {
    // The first comment, not the last. A reviewer's thread that a person has
    // replied on is still the reviewer's point, and reading the newest comment
    // instead would let any passer-by reset the reviewer's budget by agreeing
    // with it.
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
    // The rename is the point. `exhausted` read as a terminal, and it is not
    // one any more: the pull request comes out of draft, says so, and a human
    // comment arriving afterwards still gets a round.
    const h = harness({ review: review() }, [
      board({ count: 3, reviewerCount: 3, reviews: [REVIEWER] }),
    ]);

    const outcome = await advance(h.deps, { ...advanceRequest, maxRounds: 3 });

    expect(outcome).toMatchObject({ kind: "reviewer-exhausted", rounds: 3 });
    expect(ran(h, "pr", "ready")).toBe(true);
  });
});
