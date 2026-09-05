import { describe, expect, it } from "vitest";

import {
  type CommitRequest,
  type CreatePrRequest,
  type MarkReadyRequest,
  type PushRequest,
  type ReviewComment,
  type ReviewOrigin,
  type ReviewRequest,
  type ReviewThread,
  type ThreadReply,
  COPILOT_REVIEWER,
  MAX_FEEDBACK_CHARS,
  commitAll,
  createDraftPr,
  editComment,
  findPullRequest,
  formatReviewFeedback,
  formatThreads,
  markReady,
  parsePrUrl,
  postComment,
  push,
  readReview,
  readReviewThreads,
  replyToThread,
  reviewOrigin,
  requestReview,
  resolveThread,
} from "./pr.ts";
import type { CommandResult, CommandRunner } from "./worktree.ts";

const OK: CommandResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };

/**
 * Records every argv it is handed and replies from a table.
 *
 * `calls` holds the argv arrays themselves and is never joined. That is the
 * whole point of the interface under test: a test that compared
 * `calls[0].join(" ")` against a string would pass just as happily if two
 * arguments had been concatenated into one element, which is precisely the bug
 * argv arrays exist to make impossible.
 *
 * Replies are looked up by substring of the joined command, and that joining is
 * confined to this function — it is a convenience for saying "the commit
 * fails", not an assertion mechanism.
 */
function fakeRunner(
  replies: Readonly<Record<string, Partial<CommandResult>>> = {},
): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: (argv) => {
      calls.push([...argv]);
      const joined = argv.join(" ");
      const match = Object.entries(replies).find(([needle]) => joined.includes(needle));
      return Promise.resolve({ ...OK, ...match?.[1] });
    },
  };
}

const WORKTREE = "/tmp/solve/SSX-3822";
const BRANCH = "fix/ssx-3822-favicon-is-missing";
const REPO = "sparebank1/buy-insurance-advisor-web";

/** A title a shell would take apart. It must arrive as one element, unchanged. */
const NASTY = 'a"; rm -rf /; echo "';

const commitRequest = (overrides: Partial<CommitRequest> = {}): CommitRequest => ({
  worktreePath: WORKTREE,
  subject: "fix(advisor): restore the favicon",
  body: "Closes SSX-3822.",
  identity: { name: "jira-police[bot]", email: "jira-police@example.invalid" },
  timeoutMs: 60_000,
  ...overrides,
});

const pushRequest = (overrides: Partial<PushRequest> = {}): PushRequest => ({
  worktreePath: WORKTREE,
  branch: BRANCH,
  timeoutMs: 60_000,
  ...overrides,
});

const prRequest = (overrides: Partial<CreatePrRequest> = {}): CreatePrRequest => ({
  worktreePath: WORKTREE,
  repo: REPO,
  baseBranch: "main",
  branch: BRANCH,
  title: "fix(advisor): restore the favicon",
  body: "Closes SSX-3822.",
  timeoutMs: 60_000,
  ...overrides,
});

const reviewRequest = (overrides: Partial<ReviewRequest> = {}): ReviewRequest => ({
  worktreePath: WORKTREE,
  repo: REPO,
  number: 42,
  timeoutMs: 60_000,
  ...overrides,
});

const readyRequest = (overrides: Partial<MarkReadyRequest> = {}): MarkReadyRequest => ({
  worktreePath: WORKTREE,
  repo: REPO,
  number: 42,
  timeoutMs: 60_000,
  ...overrides,
});

/** The reason of a failed outcome, or "" when it did not fail. */
function reason(result: { outcome: string; reason?: string }): string {
  return result.outcome === "failed" ? (result.reason ?? "") : "";
}

/** gh's JSON payload, with everything present unless a test removes it. */
function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    reviews: [],
    comments: [],
    state: "OPEN",
    isDraft: true,
    ...overrides,
  });
}

const HEAD_SHA = "9f1c2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3";

/** A review that said something, so the chrome tests have something to keep. */
const APPROVED = "### 🟢 Approval recommended\n\nThe change is narrowly scoped.";

/**
 * Copilot's trailing promotional block, copied from PR #1413 rather than
 * paraphrased — a fixture that invented its own wording would pass against a
 * rule that never matched the real thing.
 */
const PROMO =
  '\n\n---\n\n💡 <a href="/o/r/new/main?filename=.github/skills/code-review/SKILL.md">Add a `code-review` agent skill</a>' +
  ' or configure MCP servers for context-aware, tailored reviews. <a href="https://docs.github.com/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review?tool=webui">Learn more in the docs.</a>';

/** Reply table for the one `gh pr view` call `readReview` makes. */
const view = (stdout: string): Record<string, Partial<CommandResult>> => ({
  "pr view": { stdout },
});

const comment = (
  body: string,
  author = "copilot",
  origin: ReviewOrigin = "reviewer",
): ReviewComment => ({
  author,
  body,
  createdAt: "",
  id: "",
  origin,
});

describe("commitAll", () => {
  it("stages the whole worktree before committing", async () => {
    const runner = fakeRunner({ "rev-parse": { stdout: `${HEAD_SHA}\n` } });

    await commitAll(runner, commitRequest());

    expect(runner.calls[0]).toEqual(["git", "-C", WORKTREE, "add", "-A"]);
  });

  it("passes the bot identity as -c flags before -C, and the message as two -m flags", async () => {
    const runner = fakeRunner({ "rev-parse": { stdout: `${HEAD_SHA}\n` } });

    await commitAll(runner, commitRequest());

    // The whole array, in order. `-c` must precede `-C` because those are git's
    // own options, and the identity must be here at all so the commit does not
    // inherit whoever owns the ~/.gitconfig on this machine.
    expect(runner.calls[1]).toEqual([
      "git",
      "-c",
      "user.name=jira-police[bot]",
      "-c",
      "user.email=jira-police@example.invalid",
      "-C",
      WORKTREE,
      "commit",
      "-m",
      "fix(advisor): restore the favicon",
      "-m",
      "Closes SSX-3822.",
    ]);
  });

  it("puts -c ahead of -C, checked by index rather than by eye", async () => {
    const runner = fakeRunner({ "rev-parse": { stdout: `${HEAD_SHA}\n` } });

    await commitAll(runner, commitRequest());

    const argv = runner.calls[1] ?? [];
    expect(argv.indexOf("-c")).toBeGreaterThan(0);
    expect(argv.indexOf("-c")).toBeLessThan(argv.indexOf("-C"));
  });

  it("never builds the message as one concatenated argument", async () => {
    const runner = fakeRunner({ "rev-parse": { stdout: `${HEAD_SHA}\n` } });

    await commitAll(runner, commitRequest());

    const argv = runner.calls[1] ?? [];
    expect(argv.filter((element) => element === "-m")).toHaveLength(2);
    // A subject and body glued together with a blank line would still commit,
    // and would put git's message-formatting rule in the wrong module.
    expect(argv.some((element) => element.includes("\n\n"))).toBe(false);
  });

  it("carries a title full of shell metacharacters through as one argv element", async () => {
    const runner = fakeRunner({ "rev-parse": { stdout: `${HEAD_SHA}\n` } });

    await commitAll(runner, commitRequest({ subject: NASTY, body: "$(id) && `whoami`" }));

    const argv = runner.calls[1] ?? [];
    expect(argv).toContain(NASTY);
    expect(argv).toContain("$(id) && `whoami`");
    // Unchanged: not escaped, not quoted, not split. There is no shell, so
    // there is nothing to escape it for, and an escaper here would be a bug
    // waiting to be written.
    expect(argv.filter((element) => element === NASTY)).toHaveLength(1);
  });

  it("reads the sha back with rev-parse and returns it trimmed", async () => {
    const runner = fakeRunner({ "rev-parse": { stdout: `${HEAD_SHA}\n` } });

    const result = await commitAll(runner, commitRequest());

    expect(result).toEqual({ outcome: "committed", sha: HEAD_SHA });
    expect(runner.calls[2]).toEqual(["git", "-C", WORKTREE, "rev-parse", "HEAD"]);
  });

  it.each([
    ["nothing to commit, working tree clean", "on a clean tree"],
    ['no changes added to commit (use "git add")', "when nothing was staged"],
    ["Nothing To Commit, Working Tree Clean", "whatever the casing"],
  ])("treats %j as its own outcome, not a failure — %s", async (stdout) => {
    const runner = fakeRunner({ commit: { exitCode: 1, stdout } });

    const result = await commitAll(runner, commitRequest());

    expect(result).toEqual({ outcome: "nothing-to-commit" });
  });

  it("does not ask for a sha when there was nothing to commit", async () => {
    const runner = fakeRunner({
      commit: { exitCode: 1, stdout: "nothing to commit, working tree clean" },
    });

    await commitAll(runner, commitRequest());

    expect(runner.calls.map((argv) => argv.at(-1))).not.toContain("HEAD");
  });

  it("fails when staging fails, and does not go on to commit", async () => {
    const runner = fakeRunner({ "add -A": { exitCode: 128, stderr: "fatal: index locked" } });

    const result = await commitAll(runner, commitRequest());

    expect(reason(result)).toContain("index locked");
    expect(runner.calls).toHaveLength(1);
  });

  it("fails on a commit error that is not an empty index", async () => {
    const runner = fakeRunner({
      commit: { exitCode: 1, stderr: "error: pathspec did not match" },
    });

    const result = await commitAll(runner, commitRequest());

    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("pathspec did not match");
  });

  it("keeps the end of a long failure, where the verdict is", async () => {
    // REGRESSION, 2026-09-04. The first live `--pr` run was rejected by the
    // target repo's commit-msg hook, and the log said nothing useful: commitlint
    // echoes the message it was handed *before* printing its verdict, so a
    // head-only truncation kept 300 characters of our own commit body and cut
    // the rule name — the one part that says what to change.
    const echo = `⧗   input: fix(advisor): add a favicon\n\n${"padding ".repeat(60)}`;
    const runner = fakeRunner({
      commit: { exitCode: 1, stdout: `${echo}\n✖   body's lines must not be longer than 100` },
    });

    const result = await commitAll(runner, commitRequest());

    expect(reason(result)).toContain("body's lines must not be longer than 100");
  });

  it("keeps the start of a long failure too, and marks what it dropped", async () => {
    // Tail-only would be the same mistake facing the other way: a tool that
    // fails on step three of five names the step at the top.
    const runner = fakeRunner({
      commit: { exitCode: 1, stderr: `step 3 of 5 failed\n${"x".repeat(900)}\ntrailing detail` },
    });

    const result = await commitAll(runner, commitRequest());

    expect(reason(result)).toContain("step 3 of 5 failed");
    expect(reason(result)).toContain("trailing detail");
    expect(reason(result)).toMatch(/\[…\d+ chars…\]/u);
  });

  it("does not mangle a failure short enough to print whole", async () => {
    const runner = fakeRunner({ commit: { exitCode: 1, stderr: "error: pathspec did not match" } });

    const result = await commitAll(runner, commitRequest());

    expect(reason(result)).toContain("exit 1: error: pathspec did not match");
    expect(reason(result)).not.toContain("chars…");
  });

  it("treats a timed-out commit as a failure even though the exit code is zero", async () => {
    // The runner reports a killed command as exit 0 plus `timedOut`, and it
    // could plausibly have printed "nothing to commit" before it hung.
    const runner = fakeRunner({
      commit: { timedOut: true, stdout: "nothing to commit, working tree clean" },
    });

    const result = await commitAll(runner, commitRequest());

    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("timed out");
  });

  it("fails when rev-parse itself fails", async () => {
    const runner = fakeRunner({ "rev-parse": { exitCode: 128, stderr: "fatal: bad revision" } });

    const result = await commitAll(runner, commitRequest());

    expect(reason(result)).toContain("could not read the resulting sha");
  });

  it("refuses to report something that is not a sha as one", async () => {
    const runner = fakeRunner({ "rev-parse": { stdout: "HEAD is now at deadbee\n" } });

    const result = await commitAll(runner, commitRequest());

    expect(reason(result)).toContain("rather than a sha");
  });

  it.each([
    ["a line break in the name", { name: "bot\nUser", email: "bot@example.invalid" }],
    ["a line break in the email", { name: "bot", email: "bot@example.invalid\nx" }],
    ["an empty name", { name: "  ", email: "bot@example.invalid" }],
    ["an empty email", { name: "bot", email: "" }],
  ])("refuses %s without running anything", async (_label, identity) => {
    const runner = fakeRunner();

    const result = await commitAll(runner, commitRequest({ identity }));

    expect(reason(result)).toContain("commit identity");
    expect(runner.calls).toEqual([]);
  });
});

describe("push", () => {
  it("sets upstream on origin and nothing else", async () => {
    const runner = fakeRunner();

    const result = await push(runner, pushRequest());

    expect(result).toEqual({ outcome: "pushed" });
    expect(runner.calls[0]).toEqual([
      "git",
      "-C",
      WORKTREE,
      "push",
      "--set-upstream",
      "origin",
      BRANCH,
    ]);
  });

  it.each(["--force", "-f", "--force-with-lease", "+refs/heads/*"])(
    "never passes %s",
    async (flag) => {
      const runner = fakeRunner();

      await push(runner, pushRequest());

      // A force-push in an automated loop destroys commits that exist nowhere
      // else. This assertion is the reason the flag stays out.
      expect(runner.calls[0]).not.toContain(flag);
    },
  );

  it.each([
    "main",
    "master",
    "origin/main",
    "develop",
    "release/2026-09",
    "feature/ssx-3822-x",
    "fix/main",
    "",
  ])("refuses to push %j, and never reaches the runner", async (branch) => {
    const runner = fakeRunner();

    await expect(push(runner, pushRequest({ branch }))).rejects.toThrow(
      /not an implementation branch/u,
    );
    // Throwing rather than returning `failed` is deliberate: `failed` is a
    // value the orchestrator may retry, and "you tried to push to main" must
    // never be retryable.
    expect(runner.calls).toEqual([]);
  });

  it("reports a rejected push as failed, carrying git's own complaint", async () => {
    const runner = fakeRunner({
      push: { exitCode: 1, stderr: "! [rejected] fix/ssx-3822 -> fix/ssx-3822 (non-fast-forward)" },
    });

    const result = await push(runner, pushRequest());

    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("non-fast-forward");
    expect(reason(result)).toContain("not forced");
  });

  it("reports a timed-out push as failed rather than as a zero exit", async () => {
    const runner = fakeRunner({ push: { timedOut: true } });

    expect(reason(await push(runner, pushRequest()))).toContain("timed out");
  });
});

describe("createDraftPr", () => {
  const created = { "pr create": { stdout: `https://github.com/${REPO}/pull/42\n` } };

  it("builds the exact gh invocation, draft and repo-pinned", async () => {
    const runner = fakeRunner(created);

    const result = await createDraftPr(runner, prRequest());

    expect(result).toEqual({
      outcome: "created",
      number: 42,
      url: `https://github.com/${REPO}/pull/42`,
    });
    expect(runner.calls[0]).toEqual([
      "gh",
      "pr",
      "create",
      "--draft",
      "--repo",
      REPO,
      "--base",
      "main",
      "--head",
      BRANCH,
      "--title",
      "fix(advisor): restore the favicon",
      "--body",
      "Closes SSX-3822.",
    ]);
  });

  it("runs gh in the worktree with the request's timeout", async () => {
    const calls: { cwd: string; timeoutMs: number }[] = [];
    const runner: CommandRunner = {
      run: (_argv, options) => {
        calls.push({ cwd: options.cwd, timeoutMs: options.timeoutMs });
        return Promise.resolve({ ...OK, stdout: `https://github.com/${REPO}/pull/42` });
      },
    };

    await createDraftPr(runner, prRequest());

    expect(calls[0]).toEqual({ cwd: WORKTREE, timeoutMs: 60_000 });
  });

  it("carries a model-authored title and body through as single argv elements", async () => {
    const runner = fakeRunner(created);

    await createDraftPr(runner, prRequest({ title: NASTY, body: `line one\n${NASTY}` }));

    const argv = runner.calls[0] ?? [];
    expect(argv[argv.indexOf("--title") + 1]).toBe(NASTY);
    expect(argv[argv.indexOf("--body") + 1]).toBe(`line one\n${NASTY}`);
    // Even a body with a newline in it is one argument. Nothing splits it,
    // because nothing between here and execvp looks at whitespace.
    expect(argv).toHaveLength(14);
  });

  it("refuses to open a pull request from a branch onto itself", async () => {
    const runner = fakeRunner(created);

    await expect(
      createDraftPr(runner, prRequest({ baseBranch: BRANCH, branch: BRANCH })),
    ).rejects.toThrow(/onto itself/u);
    expect(runner.calls).toEqual([]);
  });

  it.each(["main", "master", "origin/main", "release/2026-09", "feature/x"])(
    "refuses %j as the head, and never reaches the runner",
    async (branch) => {
      const runner = fakeRunner(created);

      await expect(createDraftPr(runner, prRequest({ branch }))).rejects.toThrow();
      expect(runner.calls).toEqual([]);
    },
  );

  it("allows a work branch as the base, since nothing here writes to the base", async () => {
    const runner = fakeRunner(created);

    const result = await createDraftPr(runner, prRequest({ baseBranch: "feat/ssx-1-stack" }));

    expect(result.outcome).toBe("created");
  });

  it("fails when gh fails, without trying to parse anything", async () => {
    const runner = fakeRunner({
      "pr create": { exitCode: 1, stderr: "GraphQL: A pull request already exists" },
    });

    const result = await createDraftPr(runner, prRequest());

    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("already exists");
  });

  it("fails rather than guessing when gh exits zero but prints nothing usable", async () => {
    const runner = fakeRunner({ "pr create": { stdout: "Creating pull request…\n" } });

    const result = await createDraftPr(runner, prRequest());

    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("refused rather than guessed");
  });
});

describe("parsePrUrl", () => {
  it("reads the number from the URL gh prints", () => {
    expect(parsePrUrl("https://github.com/o/r/pull/42")).toEqual({
      number: 42,
      url: "https://github.com/o/r/pull/42",
    });
  });

  it("tolerates a trailing newline", () => {
    expect(parsePrUrl("https://github.com/o/r/pull/42\n")?.number).toBe(42);
  });

  it("takes the last line, past whatever gh printed on the way", () => {
    const stdout = [
      "Warning: 3 uncommitted changes",
      "Creating draft pull request for fix/x into main in o/r",
      "",
      "https://github.com/o/r/pull/1337",
      "",
    ].join("\n");

    expect(parsePrUrl(stdout)?.number).toBe(1337);
  });

  it.each([
    ["garbage", "something went wrong"],
    ["an empty stdout", ""],
    ["whitespace only", "   \n\n  "],
    ["a deep link, because the regex is end-anchored", "https://github.com/o/r/pull/42/files"],
    ["a checks link", "https://github.com/o/r/pull/42/checks?check_run_id=9"],
    ["a URL with a fragment", "https://github.com/o/r/pull/42#issuecomment-1"],
    ["a pull path with no number", "https://github.com/o/r/pull/"],
    ["an issue URL", "https://github.com/o/r/issues/42"],
    ["number zero", "https://github.com/o/r/pull/0"],
  ])("returns null for %s", (_label, stdout) => {
    expect(parsePrUrl(stdout)).toBeNull();
  });

  it("returns null for a number too large to survive parsing", () => {
    // 30 digits round-trips through `Number` having already lost information,
    // so the value compared here is not the value on the line.
    expect(parsePrUrl("https://github.com/o/r/pull/123456789012345678901234567890")).toBeNull();
  });
});

describe("requestReview", () => {
  it("asks for the Copilot reviewer by default", async () => {
    const runner = fakeRunner();

    const result = await requestReview(runner, reviewRequest());

    expect(result).toEqual({ outcome: "requested" });
    expect(runner.calls[0]).toEqual([
      "gh",
      "pr",
      "edit",
      "42",
      "--repo",
      REPO,
      "--add-reviewer",
      COPILOT_REVIEWER,
    ]);
  });

  it("uses an explicitly supplied reviewer instead", async () => {
    const runner = fakeRunner();

    await requestReview(runner, reviewRequest({ reviewer: "some-other-bot" }));

    expect(runner.calls[0]?.at(-1)).toBe("some-other-bot");
  });

  it("fails when the reviewer cannot be added, saying which one", async () => {
    const runner = fakeRunner({
      "pr edit": { exitCode: 1, stderr: "could not add reviewer: not found" },
    });

    const result = await requestReview(runner, reviewRequest());

    expect(reason(result)).toContain(COPILOT_REVIEWER);
    expect(reason(result)).toContain("not found");
  });
});

describe("readReview", () => {
  it("asks gh for exactly the four fields it reads", async () => {
    const runner = fakeRunner(view(payload()));

    await readReview(runner, reviewRequest());

    expect(runner.calls[0]).toEqual([
      "gh",
      "pr",
      "view",
      "42",
      "--repo",
      REPO,
      "--json",
      "reviews,comments,state,isDraft",
    ]);
  });

  it("reports no response when the PR has no reviews and no comments", async () => {
    const runner = fakeRunner(view(payload()));

    const result = await readReview(runner, reviewRequest());

    expect(result).toEqual({
      outcome: "read",
      review: {
        anyoneResponded: false,
        reviewerErrored: false,
        comments: [],
        state: "OPEN",
        isDraft: true,
      },
    });
  });

  it("collects a Copilot review and its comments", async () => {
    // The two lists name the same fact differently and this fixture says so:
    // a review dates itself with `submittedAt`, an issue comment with
    // `createdAt`. Probed against PR #2658 — a review has no `createdAt` at
    // all, and asking for one returns null.
    const runner = fakeRunner(
      view(
        payload({
          reviews: [
            {
              author: { login: "copilot" },
              body: "Two things below.",
              submittedAt: "2026-09-05T11:00:49Z",
              id: "PRR_1",
            },
          ],
          comments: [
            {
              author: { login: "copilot" },
              body: "Nit: rename this.",
              createdAt: "2026-09-05T11:04:00Z",
              id: "IC_1",
            },
          ],
        }),
      ),
    );

    const result = await readReview(runner, reviewRequest());

    expect(result.outcome === "read" ? result.review : null).toEqual({
      anyoneResponded: true,
      reviewerErrored: false,
      comments: [
        {
          author: "copilot",
          body: "Two things below.",
          createdAt: "2026-09-05T11:00:49Z",
          id: "PRR_1",
          origin: "reviewer",
        },
        {
          author: "copilot",
          body: "Nit: rename this.",
          createdAt: "2026-09-05T11:04:00Z",
          id: "IC_1",
          origin: "reviewer",
        },
      ],
      state: "OPEN",
      isDraft: true,
    });
  });

  it("dates a review even though a review has no createdAt", async () => {
    // The mutation this pins: read only `createdAt` and every review comes
    // back undated, an undated comment is treated as new, and the cursor
    // degrades into "everything is new" — which is the runaway it exists to
    // prevent, arriving through a field name rather than a missing feature.
    const runner = fakeRunner(
      view(
        payload({
          reviews: [
            {
              author: { login: "copilot" },
              body: "Two things below.",
              submittedAt: "2026-09-05T11:00:49Z",
              createdAt: null,
            },
          ],
        }),
      ),
    );

    const result = await readReview(runner, reviewRequest());

    expect(result.outcome === "read" ? result.review.comments[0]?.createdAt : null).toBe(
      "2026-09-05T11:00:49Z",
    );
  });

  it("leaves the date empty rather than guessing when the entry carries none", async () => {
    const runner = fakeRunner(
      view(payload({ reviews: [{ author: { login: "copilot" }, body: "No date on this one." }] })),
    );

    const result = await readReview(runner, reviewRequest());

    expect(result.outcome === "read" ? result.review.comments[0]?.createdAt : null).toBe("");
  });

  // The exact body GitHub posted on PR #2657, 2026-09-04. The Copilot app was
  // requested, ran, and could not read the pull request — its installation
  // lacked `pull_requests: read` on that repository — and reported that as an
  // ordinary COMMENTED review.
  const COPILOT_ERROR =
    "Copilot encountered an error and was unable to review this pull request. " +
    "You can try again by re-requesting a review.";

  it("does not read a reviewer's own error as feedback to act on", async () => {
    // Feeding this to a review round spends a paid pass asking a model to
    // address an error message.
    const runner = fakeRunner(
      view(payload({ reviews: [{ author: { login: "copilot" }, body: COPILOT_ERROR }] })),
    );

    const result = await readReview(runner, reviewRequest());

    expect(result.outcome === "read" ? result.review.comments : null).toEqual([]);
  });

  it("does not read a reviewer's own error as a clean review either", async () => {
    // The worse of the two. An empty comment list plus `anyoneResponded` is
    // indistinguishable from an approval, so the loop would undraft and mark
    // the ticket done on the strength of a review that never happened.
    const runner = fakeRunner(
      view(payload({ reviews: [{ author: { login: "copilot" }, body: COPILOT_ERROR }] })),
    );

    const result = await readReview(runner, reviewRequest());

    expect(result.outcome === "read" ? result.review.reviewerErrored : null).toBe(true);
  });

  it("still counts the error as the reviewer having responded", async () => {
    // It did respond. What it said was that it could not review, and those are
    // two different facts — collapsing them would make the loop wait forever
    // for a reviewer that has already answered.
    const runner = fakeRunner(
      view(payload({ reviews: [{ author: { login: "copilot" }, body: COPILOT_ERROR }] })),
    );

    const result = await readReview(runner, reviewRequest());

    expect(result.outcome === "read" ? result.review.anyoneResponded : null).toBe(true);
  });

  it("does not mistake a review that discusses an error for a failed review", async () => {
    // Both phrases must appear. "encountered an error" alone is ordinary
    // review prose about the code under review.
    const runner = fakeRunner(
      view(
        payload({
          reviews: [
            {
              author: { login: "copilot" },
              body: "This encountered an error path that is not covered by a test.",
            },
          ],
        }),
      ),
    );

    const result = await readReview(runner, reviewRequest());

    expect(result.outcome === "read" ? result.review.reviewerErrored : null).toBe(false);
    expect(result.outcome === "read" ? result.review.comments : []).toHaveLength(1);
  });

  it("ignores an error notice posted by somebody who is not the reviewer", async () => {
    // `reviewerErrored` is a statement about the reviewer we asked for. A human
    // quoting the failure in a comment has not made the reviewer fail.
    const runner = fakeRunner(
      view(payload({ comments: [{ author: { login: "a-human" }, body: COPILOT_ERROR }] })),
    );

    const result = await readReview(runner, reviewRequest());

    expect(result.outcome === "read" ? result.review.reviewerErrored : null).toBe(false);
    // And it is kept as a comment. A person quoting the failure is asking for
    // something; deleting their message because a bot used the same words would
    // be the recogniser reaching past what it knows.
    expect(result.outcome === "read" ? result.review.comments : []).toEqual([
      { author: "a-human", body: COPILOT_ERROR, createdAt: "", id: "", origin: "human" },
    ]);
  });

  it.each([
    "copilot",
    "Copilot",
    "COPILOT",
    "copilot-pull-request-reviewer[bot]",
    "copilot-pull-request-reviewer",
  ])("recognises %j as the reviewer it asked for", async (login) => {
    // The handle requested is `@copilot`; the login that answers is longer and
    // has changed shape before. An exact comparison would fail closed in the
    // worst direction — the loop would wait forever for a review it already has.
    const runner = fakeRunner(view(payload({ reviews: [{ author: { login }, body: "ok" }] })));

    const result = await readReview(runner, reviewRequest());

    expect(result.outcome === "read" && result.review.anyoneResponded).toBe(true);
  });

  it.each(["some-human", "not-copilot", "dependabot[bot]", ""])(
    "does not mistake %j for the reviewer",
    async (login) => {
      const runner = fakeRunner(view(payload({ comments: [{ author: { login }, body: "hi" }] })));

      const result = await readReview(runner, reviewRequest());

      // Not the reviewer, so `human` — and `origin` is what exempts a round from
      // `MAX_REVIEW_ITERATIONS`, so a login misread as the reviewer here spends a
      // person's request out of a budget that was never meant to bound them.
      expect(result.outcome === "read" ? result.review.comments[0]?.origin : null).toBe("human");
      // And the loop still wakes for it. The gate asks whether anyone actionable
      // spoke, not whether the requested reviewer did.
      expect(result.outcome === "read" && result.review.anyoneResponded).toBe(true);
    },
  );

  it("counts an approval with no body as a response", async () => {
    // An approving review carries an empty body. Reading that as silence would
    // stall the loop on a reviewer that has already finished.
    const runner = fakeRunner(
      view(payload({ reviews: [{ author: { login: "copilot" }, body: "" }] })),
    );

    const result = await readReview(runner, reviewRequest());

    expect(result.outcome === "read" && result.review.anyoneResponded).toBe(true);
    expect(result.outcome === "read" && result.review.comments).toEqual([]);
  });

  it("skips entries whose body is not a string, and keeps the rest", async () => {
    const runner = fakeRunner(
      view(
        payload({
          comments: [
            { author: { login: "a" }, body: null },
            { author: { login: "b" }, body: 42 },
            { author: { login: "c" }, body: "   " },
            { author: { login: "d" }, body: "real feedback" },
            "not an object",
            null,
          ],
        }),
      ),
    );

    const result = await readReview(runner, reviewRequest());

    expect(result.outcome === "read" ? result.review.comments : null).toEqual([
      { author: "d", body: "real feedback", createdAt: "", id: "", origin: "human" },
    ]);
  });

  it("drops the reviewer's promotional footer, which was never review", async () => {
    // Observed on PR #1413: the pass was handed this block, read it as a
    // request, and declined it in `responses` — which by then were posted
    // publicly, so a timezone bugfix carried a paragraph about not adding a
    // SKILL.md.
    const runner = fakeRunner(
      view(payload({ reviews: [{ author: { login: "copilot" }, body: APPROVED + PROMO }] })),
    );

    const result = await readReview(runner, reviewRequest());

    expect(result.outcome === "read" ? result.review.comments[0]?.body : null).toBe(APPROVED);
  });

  it("leaves the same footer alone when a human quotes it", async () => {
    // Scoped to the reviewer on exactly the grounds the error-notice drop is:
    // a person quoting the block is a person saying something, and matching on
    // text alone would silently edit their message.
    const runner = fakeRunner(
      view(
        payload({ comments: [{ author: { login: "some-human" }, body: "what is this?" + PROMO }] }),
      ),
    );

    const result = await readReview(runner, reviewRequest());

    expect(result.outcome === "read" ? result.review.comments[0]?.body : null).toContain(
      "docs.github.com/copilot",
    );
  });

  it("keeps a reviewer's trailing section when it is not the vendor's chrome", async () => {
    // A rule is not enough on its own, and neither is the 💡. Reviewers use
    // both when making a real suggestion, and swallowing one is the failure
    // direction nobody recovers from by noticing.
    const body = "Looks fine.\n\n---\n\n💡 Consider extracting the helper.";
    const runner = fakeRunner(view(payload({ reviews: [{ author: { login: "copilot" }, body }] })));

    const result = await readReview(runner, reviewRequest());

    expect(result.outcome === "read" ? result.review.comments[0]?.body : null).toBe(body);
  });

  it("drops a review that was nothing but chrome, rather than passing on a blank", async () => {
    const runner = fakeRunner(
      view(payload({ reviews: [{ author: { login: "copilot" }, body: PROMO }] })),
    );

    const result = await readReview(runner, reviewRequest());

    // Still a response — the reviewer spoke — but there is nothing in it to act on.
    expect(result.outcome === "read" && result.review.anyoneResponded).toBe(true);
    expect(result.outcome === "read" ? result.review.comments : null).toEqual([]);
  });

  it("names an author it could not read rather than dropping the comment", async () => {
    const runner = fakeRunner(view(payload({ comments: [{ body: "still feedback" }] })));

    const result = await readReview(runner, reviewRequest());

    expect(result.outcome === "read" ? result.review.comments : null).toEqual([
      { author: "unknown", body: "still feedback", createdAt: "", id: "", origin: "human" },
    ]);
  });

  it("treats missing reviews and comments keys as empty, not as an error", async () => {
    const runner = fakeRunner(view(JSON.stringify({ state: "OPEN", isDraft: true })));

    const result = await readReview(runner, reviewRequest());

    expect(result).toEqual({
      outcome: "read",
      review: {
        anyoneResponded: false,
        reviewerErrored: false,
        comments: [],
        state: "OPEN",
        isDraft: true,
      },
    });
  });

  it("treats a null reviews key as empty too", async () => {
    const runner = fakeRunner(view(payload({ reviews: null })));

    expect((await readReview(runner, reviewRequest())).outcome).toBe("read");
  });

  it.each([
    ["reviews as an object", payload({ reviews: { nope: true } })],
    ["comments as a string", payload({ comments: "none" })],
  ])("fails on %s rather than reading it as no feedback", async (_label, stdout) => {
    const runner = fakeRunner(view(stdout));

    const result = await readReview(runner, reviewRequest());

    expect(reason(result)).toContain("other than a list");
  });

  it.each([
    ["state", JSON.stringify({ reviews: [], comments: [], isDraft: true })],
    ["isDraft", JSON.stringify({ reviews: [], comments: [], state: "OPEN" })],
    ["a non-string state", payload({ state: 7 })],
    ["a non-boolean isDraft", payload({ isDraft: "true" })],
  ])("fails when the payload is missing %s", async (_label, stdout) => {
    // These two decide whether `gh pr ready` is allowed to run. A default here
    // would be a guess made immediately before an irreversible action.
    const runner = fakeRunner(view(stdout));

    const result = await readReview(runner, reviewRequest());

    expect(reason(result)).toContain("state or isDraft");
  });

  it.each([
    ["malformed JSON", "{not json at all"],
    ["a truncated payload", '{"reviews": ['],
    ["empty output", ""],
  ])("fails on %s without throwing", async (_label, stdout) => {
    const runner = fakeRunner(view(stdout));

    const result = await readReview(runner, reviewRequest());

    expect(reason(result)).toContain("not JSON");
  });

  it.each(["[]", '"a string"', "null", "7"])(
    "fails when the payload is %s rather than an object",
    async (stdout) => {
      const runner = fakeRunner(view(stdout));

      expect(reason(await readReview(runner, reviewRequest()))).toContain("not a JSON object");
    },
  );

  it("fails when gh itself fails", async () => {
    const runner = fakeRunner({ "pr view": { exitCode: 1, stderr: "no pull requests found" } });

    const result = await readReview(runner, reviewRequest());

    expect(reason(result)).toContain("no pull requests found");
  });

  it("calls everyone the reviewer when the reviewer name is empty", async () => {
    // The blank setting cannot tell anybody apart, and the two directions are not
    // symmetric: reading everyone as `human` would exempt every comment on every
    // pull request from `MAX_REVIEW_ITERATIONS` at once, on a typo in `.env`.
    // Reading everyone as `reviewer` only spends the cap sooner than it need be.
    const runner = fakeRunner(view(payload({ comments: [{ author: { login: "x" }, body: "y" }] })));

    const result = await readReview(runner, reviewRequest({ reviewer: "@" }));

    expect(result.outcome === "read" ? result.review.comments[0]?.origin : null).toBe("reviewer");
  });
});

/** One thread node, with every field present unless a test removes it. */
function thread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "PRRT_1",
    isResolved: false,
    isOutdated: false,
    path: "src/utils/setNonProductionFavicon.ts",
    line: 19,
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          author: { login: "copilot-pull-request-reviewer" },
          body: "not idempotent",
          createdAt: "2026-09-04T23:05:36Z",
        },
      ],
    },
    ...overrides,
  };
}

/** The GraphQL envelope around a list of thread nodes. */
function threadsPayload(nodes: readonly unknown[], hasNextPage = false): string {
  return JSON.stringify({
    data: {
      repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage }, nodes } } },
    },
  });
}

const graphql = (stdout: string): Record<string, Partial<CommandResult>> => ({
  "api graphql": { stdout },
});

describe("readReviewThreads", () => {
  it("reads the inline comments the --json flags cannot reach", async () => {
    const runner = fakeRunner(graphql(threadsPayload([thread()])));

    const result = await readReviewThreads(runner, reviewRequest());

    expect(result).toEqual({
      outcome: "read",
      threads: [
        {
          id: "PRRT_1",
          isResolved: false,
          isOutdated: false,
          path: "src/utils/setNonProductionFavicon.ts",
          line: 19,
          comments: [
            {
              author: "copilot-pull-request-reviewer",
              body: "not idempotent",
              createdAt: "2026-09-04T23:05:36Z",
              origin: "reviewer",
            },
          ],
        },
      ],
    });
  });

  it("splits the repo into the two arguments GraphQL takes separately", async () => {
    const runner = fakeRunner(graphql(threadsPayload([])));

    await readReviewThreads(runner, reviewRequest());

    const argv = runner.calls[0] ?? [];
    expect(argv.slice(0, 3)).toEqual(["gh", "api", "graphql"]);
    expect(argv).toContain("owner=sparebank1");
    expect(argv).toContain("name=buy-insurance-advisor-web");
    expect(argv).toContain("number=42");
    // The query is one element. Split across two it is not a query at all, and
    // the argv form is what keeps the caller from having to escape anything.
    expect(argv.filter((part) => part.startsWith("query=")).length).toBe(1);
  });

  it("passes owner and name raw, so an @ in one is not read as a filename", async () => {
    const runner = fakeRunner(graphql(threadsPayload([])));

    await readReviewThreads(runner, reviewRequest());

    const argv = runner.calls[0] ?? [];
    // gh's typed `-F` reads a value beginning with `@` out of a file. Only the
    // number, which cannot begin with one, is passed that way.
    expect(argv[argv.indexOf("owner=sparebank1") - 1]).toBe("-f");
    expect(argv[argv.indexOf("name=buy-insurance-advisor-web") - 1]).toBe("-f");
    expect(argv[argv.indexOf("number=42") - 1]).toBe("-F");
  });

  it("refuses a repo that is not an owner/name pair", async () => {
    const runner = fakeRunner(graphql(threadsPayload([])));

    const result = await readReviewThreads(runner, reviewRequest({ repo: "just-a-name" }));

    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("owner/name");
    expect(runner.calls).toEqual([]);
  });

  it("reports no inline comments only when the read said so", async () => {
    const runner = fakeRunner(graphql(threadsPayload([])));

    const result = await readReviewThreads(runner, reviewRequest());

    expect(result).toEqual({ outcome: "read", threads: [] });
  });

  it("fails when gh fails", async () => {
    const runner = fakeRunner({ "api graphql": { exitCode: 1, stderr: "Bad credentials" } });

    const result = await readReviewThreads(runner, reviewRequest());

    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("Bad credentials");
  });

  it("fails when gh prints something that is not JSON", async () => {
    const runner = fakeRunner(graphql("<html>proxy</html>"));

    const result = await readReviewThreads(runner, reviewRequest());

    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("not JSON");
  });

  it("fails on a partly-failed query rather than reading the half it got", async () => {
    // GraphQL answers with data *and* errors, and the data half looks complete.
    const runner = fakeRunner(
      graphql(
        JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
          errors: [{ message: "Something went wrong" }],
        }),
      ),
    );

    const result = await readReviewThreads(runner, reviewRequest());

    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("errors");
  });

  it("reads an unreadable shape as unreadable, not as a pull request with no threads", async () => {
    const runner = fakeRunner(graphql(JSON.stringify({ data: { repository: null } })));

    const result = await readReviewThreads(runner, reviewRequest());

    // The mutation this pins: return `{ outcome: "read", threads: [] }` here and
    // the round proceeds believing it has seen every comment on the diff.
    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("shape this does not understand");
  });

  it("refuses a second page of threads rather than dropping it", async () => {
    const runner = fakeRunner(graphql(threadsPayload([thread()], true)));

    const result = await readReviewThreads(runner, reviewRequest());

    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("more than 100 review threads");
  });

  it("refuses a second page of comments, where our own last reply would be", async () => {
    const runner = fakeRunner(
      graphql(
        threadsPayload([thread({ comments: { pageInfo: { hasNextPage: true }, nodes: [] } })]),
      ),
    );

    const result = await readReviewThreads(runner, reviewRequest());

    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("more than 100 comments");
  });

  it("refuses the whole read when one thread is missing a field", async () => {
    // Deliberately unlike `entriesOf`, which skips a bad entry. A skipped thread
    // is a comment the round does not answer while reporting that it answered
    // everything, so one bad node fails the read.
    const runner = fakeRunner(graphql(threadsPayload([thread(), thread({ isResolved: "no" })])));

    const result = await readReviewThreads(runner, reviewRequest());

    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("missing fields");
  });

  it("refuses a thread with no id, which is what a reply is addressed to", async () => {
    const runner = fakeRunner(graphql(threadsPayload([thread({ id: "" })])));

    const result = await readReviewThreads(runner, reviewRequest());

    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("missing fields");
  });

  it("refuses a thread node that is not an object", async () => {
    const runner = fakeRunner(graphql(threadsPayload(["PRRT_1"])));

    const result = await readReviewThreads(runner, reviewRequest());

    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("other than an object");
  });

  it("refuses a comment whose body could not be read", async () => {
    const runner = fakeRunner(
      graphql(
        threadsPayload([
          thread({ comments: { pageInfo: { hasNextPage: false }, nodes: [{ body: 7 }] } }),
        ]),
      ),
    );

    const result = await readReviewThreads(runner, reviewRequest());

    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("could not be read");
  });

  it("keeps a comment from a deleted account", async () => {
    const runner = fakeRunner(
      graphql(
        threadsPayload([
          thread({
            comments: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  author: null,
                  body: "still says what it says",
                  createdAt: "2026-09-04T23:05:36Z",
                },
              ],
            },
          }),
        ]),
      ),
    );

    const result = await readReviewThreads(runner, reviewRequest());

    expect(result.outcome === "read" && result.threads[0]?.comments[0]?.author).toBe("unknown");
    // And an author it could not read is not the reviewer. `human` exempts a
    // round from the reviewer's cap, so the guess has to go the other way from
    // the safe direction elsewhere in this file: a login nobody can identify
    // must not be handed the reviewer's budget, and must not be handed the
    // exemption either. It is only ever the *first* comment on a thread that
    // decides a round, and an unreadable one there is not a reviewer speaking.
    expect(result.outcome === "read" && result.threads[0]?.comments[0]?.origin).toBe("human");
  });

  it("classifies each thread comment by who wrote it", async () => {
    const runner = fakeRunner(
      graphql(
        threadsPayload([
          thread({
            comments: {
              pageInfo: { hasNextPage: false },
              nodes: [
                { author: { login: "copilot-pull-request-reviewer" }, body: "a", createdAt: "" },
                { author: { login: "a-colleague" }, body: "b", createdAt: "" },
              ],
            },
          }),
        ]),
      ),
    );

    const result = await readReviewThreads(runner, reviewRequest());
    const origins =
      result.outcome === "read" ? result.threads[0]?.comments.map((c) => c.origin) : null;

    expect(origins).toEqual(["reviewer", "human"]);
  });

  it("keeps the null line an outdated thread comes back with", async () => {
    const runner = fakeRunner(graphql(threadsPayload([thread({ isOutdated: true, line: null })])));

    const result = await readReviewThreads(runner, reviewRequest());

    expect(result.outcome === "read" && result.threads[0]?.line).toBe(null);
    expect(result.outcome === "read" && result.threads[0]?.isResolved).toBe(false);
  });
});

const THREAD_ID = "PRRT_kwDOE4J7MM6fduiU";
const REPLY_URL = "https://github.com/o/r/pull/2658#discussion_r1";

const replied = (url: string = REPLY_URL): Record<string, Partial<CommandResult>> => ({
  "api graphql": {
    stdout: JSON.stringify({
      data: { addPullRequestReviewThreadReply: { comment: { url } } },
    }),
  },
});

const resolved = (isResolved = true): Record<string, Partial<CommandResult>> => ({
  "api graphql": {
    stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved } } } }),
  },
});

const receipt = (overrides: Partial<ThreadReply> = {}): ThreadReply => ({
  threadId: THREAD_ID,
  commentUrl: REPLY_URL,
  ...overrides,
});

describe("replyToThread", () => {
  it("posts the answer on the thread and hands back a receipt", async () => {
    const runner = fakeRunner(replied());

    const result = await replyToThread(runner, {
      cwd: WORKTREE,
      threadId: THREAD_ID,
      body: "Checked: public/index.html ships no icon link.",
      timeoutMs: 60_000,
    });

    expect(result).toEqual({
      outcome: "replied",
      reply: { threadId: THREAD_ID, commentUrl: REPLY_URL },
    });
    const argv = runner.calls[0] ?? [];
    expect(argv.slice(0, 3)).toEqual(["gh", "api", "graphql"]);
    expect(argv).toContain(`threadId=${THREAD_ID}`);
    expect(argv).toContain("body=Checked: public/index.html ships no icon link.");
  });

  it("passes the body raw, so an @ in it is not read as a filename", async () => {
    const runner = fakeRunner(replied());

    await replyToThread(runner, {
      cwd: WORKTREE,
      threadId: THREAD_ID,
      // A reply body is model-written from a ticket anyone with a board account
      // can edit. gh's typed `-F` would read this out of a file.
      body: "@copilot this is the argument",
      timeoutMs: 60_000,
    });

    const argv = runner.calls[0] ?? [];
    expect(argv[argv.indexOf("body=@copilot this is the argument") - 1]).toBe("-f");
  });

  it("refuses a blank reply", async () => {
    const runner = fakeRunner(replied());

    const result = await replyToThread(runner, {
      cwd: WORKTREE,
      threadId: THREAD_ID,
      body: "   \n ",
      timeoutMs: 60_000,
    });

    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("blank reply");
    expect(runner.calls).toEqual([]);
  });

  it("refuses a reply with no thread to address", async () => {
    const runner = fakeRunner(replied());

    const result = await replyToThread(runner, {
      cwd: WORKTREE,
      threadId: "",
      body: "an answer",
      timeoutMs: 60_000,
    });

    expect(result.outcome).toBe("failed");
    expect(runner.calls).toEqual([]);
  });

  it("fails when gh fails", async () => {
    const runner = fakeRunner({ "api graphql": { exitCode: 1, stderr: "Not Found" } });

    const result = await replyToThread(runner, {
      cwd: WORKTREE,
      threadId: THREAD_ID,
      body: "an answer",
      timeoutMs: 60_000,
    });

    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("Not Found");
  });

  it("fails on GraphQL errors even when gh exits zero", async () => {
    const runner = fakeRunner({
      "api graphql": {
        stdout: JSON.stringify({ errors: [{ message: "Resource not accessible" }] }),
      },
    });

    const result = await replyToThread(runner, {
      cwd: WORKTREE,
      threadId: THREAD_ID,
      body: "an answer",
      timeoutMs: 60_000,
    });

    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("Resource not accessible");
  });

  it("issues no receipt when nothing came back to prove the reply posted", async () => {
    const runner = fakeRunner(replied(""));

    const result = await replyToThread(runner, {
      cwd: WORKTREE,
      threadId: THREAD_ID,
      body: "an answer",
      timeoutMs: 60_000,
    });

    // No URL, no receipt, and therefore nothing that can resolve the thread.
    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("nothing proves it posted");
  });
});

describe("resolveThread", () => {
  it("resolves a thread that has just been answered", async () => {
    const runner = fakeRunner(resolved());

    const result = await resolveThread(runner, {
      cwd: WORKTREE,
      reply: receipt(),
      timeoutMs: 60_000,
    });

    expect(result).toEqual({ outcome: "resolved" });
    expect(runner.calls[0]).toContain(`threadId=${THREAD_ID}`);
  });

  it.each([
    ["no comment URL", receipt({ commentUrl: "" })],
    ["no thread id", receipt({ threadId: "" })],
  ])("refuses a receipt with %s", async (_case, reply) => {
    const runner = fakeRunner(resolved());

    const result = await resolveThread(runner, { cwd: WORKTREE, reply, timeoutMs: 60_000 });

    // The type already makes a bare thread id unusable here. This is the same
    // rule at runtime, for a caller that hand-built the receipt to get around it.
    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("with an answer attached");
    expect(runner.calls).toEqual([]);
  });

  it("does not report a thread resolved when GitHub says it is still open", async () => {
    const runner = fakeRunner(resolved(false));

    const result = await resolveThread(runner, {
      cwd: WORKTREE,
      reply: receipt(),
      timeoutMs: 60_000,
    });

    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("still open");
  });

  it("fails when gh fails", async () => {
    const runner = fakeRunner({ "api graphql": { exitCode: 1, stderr: "Bad credentials" } });

    const result = await resolveThread(runner, {
      cwd: WORKTREE,
      reply: receipt(),
      timeoutMs: 60_000,
    });

    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("Bad credentials");
  });
});

const MARKER_BODY = "bot: iteration count 1\nLast read: 2026-09-05T10:00:00Z";

/** The two-step reply table `postComment` needs: node id, then the comment. */
const posts = (commentId = "IC_9"): Record<string, Partial<CommandResult>> => ({
  "pullRequest(number:$number){ id }": {
    stdout: JSON.stringify({ data: { repository: { pullRequest: { id: "PR_1" } } } }),
  },
  addComment: {
    stdout: JSON.stringify({ data: { addComment: { commentEdge: { node: { id: commentId } } } } }),
  },
});

describe("postComment", () => {
  const request = { cwd: WORKTREE, repo: REPO, number: 42, body: MARKER_BODY, timeoutMs: 60_000 };

  it("reads the pull request's node id and hands back the comment's", async () => {
    // The returned id is the point of using addComment over `gh pr comment`:
    // without it, the next round has to find the marker again by prefix, and a
    // round that cannot find what it just wrote posts a second one.
    const runner = fakeRunner(posts());

    const result = await postComment(runner, request);

    expect(result).toEqual({ outcome: "written", commentId: "IC_9" });
  });

  it("passes the number typed and the body raw", async () => {
    // `-F` turns 42 into an Int, which the query's `Int!` requires. It also
    // reads a value beginning with `@` out of a file, so a body nobody here
    // wrote never goes through it.
    const runner = fakeRunner(posts());

    await postComment(runner, request);

    expect(runner.calls[0]).toContain("-F");
    expect(runner.calls[0]).toContain("number=42");
    const post = runner.calls[1] ?? [];
    expect(post).toContain(`body=${MARKER_BODY}`);
    expect(post[post.indexOf(`body=${MARKER_BODY}`) - 1]).toBe("-f");
  });

  it("refuses an empty body before running anything", async () => {
    const runner = fakeRunner(posts());

    const result = await postComment(runner, { ...request, body: "   " });

    expect(result.outcome).toBe("failed");
    expect(runner.calls).toEqual([]);
  });

  it("refuses a repo that is not owner/name", async () => {
    const runner = fakeRunner(posts());

    const result = await postComment(runner, { ...request, repo: "advisor" });

    expect(reason(result)).toContain("owner/name");
    expect(runner.calls).toEqual([]);
  });

  it("does not comment when the pull request has no node id", async () => {
    const runner = fakeRunner({
      "pullRequest(number:$number){ id }": { stdout: JSON.stringify({ data: {} }) },
    });

    const result = await postComment(runner, request);

    expect(reason(result)).toContain("without a node id");
    expect(runner.calls).toHaveLength(1);
  });

  it("fails when the comment came back without an id, so no round could edit it", async () => {
    const runner = fakeRunner({
      ...posts(),
      addComment: { stdout: JSON.stringify({ data: { addComment: {} } }) },
    });

    const result = await postComment(runner, request);

    expect(reason(result)).toContain("no later round could edit it");
  });
});

/** Reply table for the one `updateIssueComment` call `editComment` makes. */
const edits = (id = "IC_9"): Record<string, Partial<CommandResult>> => ({
  updateIssueComment: {
    stdout: JSON.stringify({ data: { updateIssueComment: { issueComment: { id } } } }),
  },
});

describe("editComment", () => {
  const request = { cwd: WORKTREE, commentId: "IC_9", body: MARKER_BODY, timeoutMs: 60_000 };

  it("rewrites the comment named by its node id", async () => {
    const runner = fakeRunner(edits());

    const result = await editComment(runner, request);

    expect(result).toEqual({ outcome: "written", commentId: "IC_9" });
    expect(runner.calls[0]).toContain("id=IC_9");
  });

  it("never reaches for --edit-last", async () => {
    // That flag edits the last comment of the *current user*, and the current
    // user is the operator. A round running after a human commented would
    // overwrite that person's words with machine state.
    const runner = fakeRunner(edits());

    await editComment(runner, request);

    expect(runner.calls.flat()).not.toContain("--edit-last");
  });

  it("refuses to edit a comment with no id", async () => {
    const runner = fakeRunner(edits());

    const result = await editComment(runner, { ...request, commentId: "" });

    expect(result.outcome).toBe("failed");
    expect(runner.calls).toEqual([]);
  });

  it("refuses to blank a comment", async () => {
    const runner = fakeRunner(edits());

    const result = await editComment(runner, { ...request, body: "\n  " });

    expect(reason(result)).toContain("blank");
    expect(runner.calls).toEqual([]);
  });

  it("does not report an edit that came back empty as written", async () => {
    const runner = fakeRunner({
      updateIssueComment: { stdout: JSON.stringify({ data: { updateIssueComment: {} } }) },
    });

    const result = await editComment(runner, request);

    expect(reason(result)).toContain("nothing proves it took");
  });
});

describe("markReady", () => {
  it("undrafts the pull request by number and repo", async () => {
    const runner = fakeRunner();

    const result = await markReady(runner, readyRequest());

    expect(result).toEqual({ outcome: "ready" });
    expect(runner.calls[0]).toEqual(["gh", "pr", "ready", "42", "--repo", REPO]);
  });

  it("fails without claiming the pull request was undrafted", async () => {
    const runner = fakeRunner({ "pr ready": { exitCode: 1, stderr: "not a draft" } });

    const result = await markReady(runner, readyRequest());

    expect(result.outcome).toBe("failed");
    expect(reason(result)).toContain("not a draft");
  });
});

describe("formatReviewFeedback", () => {
  it("says so plainly when there is nothing to feed back", () => {
    expect(formatReviewFeedback([])).toBe("No review comments.");
  });

  it("renders each comment with its author and position", () => {
    const block = formatReviewFeedback([comment("first thing"), comment("second thing", "human")]);

    expect(block).toContain("Review feedback (2 comments):");
    expect(block).toContain("--- comment 1 of 2, by copilot ---\nfirst thing");
    expect(block).toContain("--- comment 2 of 2, by human ---\nsecond thing");
  });

  it("uses the singular for one comment", () => {
    expect(formatReviewFeedback([comment("just the one")])).toContain("(1 comment):");
  });

  it("stays inside the cap and says that it truncated", () => {
    const long = Array.from({ length: 200 }, (_unused, index) =>
      comment(`${String(index)} `.repeat(400)),
    );

    const block = formatReviewFeedback(long);

    // The notice is inside the budget rather than added to it — a cap the
    // truncation notice can push you past is not a cap.
    expect(block.length).toBeLessThanOrEqual(MAX_FEEDBACK_CHARS);
    expect(block).toContain("truncated");
    expect(block).toContain(String(MAX_FEEDBACK_CHARS));
  });

  it("leaves a block that fits exactly as it is", () => {
    const block = formatReviewFeedback([comment("short")]);

    expect(block.length).toBeLessThan(MAX_FEEDBACK_CHARS);
    expect(block).not.toContain("truncated");
  });
});

const inlineThread = (overrides: Partial<ReviewThread> = {}): ReviewThread => ({
  id: "PRRT_1",
  isResolved: false,
  isOutdated: false,
  path: "src/setNonProductionFavicon.ts",
  line: 19,
  comments: [{ author: "copilot", body: "this is not idempotent", createdAt: "", origin: "reviewer" }],
  ...overrides,
});

describe("formatThreads", () => {
  it("says so plainly when there are no threads", () => {
    expect(formatThreads([])).toBe("No inline review threads.");
  });

  it("quotes the id the answer has to name back", () => {
    // The id is how a reply reaches the thread. Rendered anywhere it can be
    // paraphrased or abbreviated, the round answers a conversation that does
    // not exist and the reviewer sees nothing at all.
    expect(formatThreads([inlineThread()])).toContain("id PRRT_1");
  });

  it("gives the location a reader can go to", () => {
    expect(formatThreads([inlineThread()])).toContain("src/setNonProductionFavicon.ts:19");
  });

  it("says the diff moved rather than inventing a line", () => {
    // `null` is what GitHub returns once the lines under a thread change.
    // Rendering it as a number would point the round at line zero of a file.
    const block = formatThreads([inlineThread({ line: null, isOutdated: true })]);

    expect(block).toContain("the diff has moved; no line");
    expect(block).not.toContain(":null");
  });

  it("includes our own earlier replies, not only the reviewer's words", () => {
    // Deliberate, and the opposite of what `reviewerComments` does to the issue
    // comments. Seeing its own answer is how a round knows the point is already
    // made in public and declines to make it twice.
    const block = formatThreads([
      inlineThread({
        comments: [
          { author: "copilot", body: "this is not idempotent", createdAt: "", origin: "reviewer" },
          { author: "rull3211", body: "bot: appended only when absent", createdAt: "", origin: "human" },
        ],
      }),
    ]);

    expect(block).toContain("bot: appended only when absent");
  });

  it("stays inside the same cap the review feedback does", () => {
    const long = Array.from({ length: 200 }, (_unused, index) =>
      inlineThread({
        id: `PRRT_${String(index)}`,
        comments: [{ author: "copilot", body: `${String(index)} `.repeat(400), createdAt: "", origin: "reviewer" }],
      }),
    );

    const block = formatThreads(long);

    expect(block.length).toBeLessThanOrEqual(MAX_FEEDBACK_CHARS);
    expect(block).toContain("truncated");
  });
});

describe("findPullRequest", () => {
  const find = (rows: unknown) =>
    findPullRequest(fakeRunner({ "pr list": { stdout: JSON.stringify(rows) } }), {
      cwd: "/repos/buy-insurance-advisor-web",
      repo: REPO,
      branch: BRANCH,
      timeoutMs: 30_000,
    });

  it("asks gh for the branch, in every state", async () => {
    const runner = fakeRunner({ "pr list": { stdout: "[]" } });

    await findPullRequest(runner, {
      cwd: "/repos/buy-insurance-advisor-web",
      repo: REPO,
      branch: BRANCH,
      timeoutMs: 30_000,
    });

    const argv = runner.calls[0] ?? [];
    expect(argv).toContain("--head");
    expect(argv).toContain(BRANCH);
    // `--state all` is the load-bearing one. Restricted to open pull requests,
    // a merged one comes back as "none" and the caller reads that as "nothing
    // published yet" at the exact moment the loop is meant to stop.
    expect(argv.join(" ")).toContain("--state all");
  });

  it("finds the open pull request", async () => {
    expect(await find([{ number: 12, state: "OPEN", isDraft: true }])).toEqual({
      outcome: "found",
      number: 12,
      state: "OPEN",
      isDraft: true,
    });
  });

  it("reports a merged pull request rather than an absence", async () => {
    expect(await find([{ number: 12, state: "MERGED", isDraft: false }])).toMatchObject({
      outcome: "found",
      state: "MERGED",
    });
  });

  it("prefers the open one when a closed attempt shares the branch", async () => {
    // The ordinary shape of a reused branch: someone closed the first attempt.
    // Both orderings, because gh does not document the order it returns rows in
    // and a rule that depends on it would pass here and fail in production.
    for (const rows of [
      [
        { number: 9, state: "CLOSED", isDraft: false },
        { number: 12, state: "OPEN", isDraft: true },
      ],
      [
        { number: 12, state: "OPEN", isDraft: true },
        { number: 9, state: "CLOSED", isDraft: false },
      ],
    ]) {
      expect(await find(rows)).toMatchObject({ outcome: "found", number: 12 });
    }
  });

  it("reports a merge whichever row carried it", async () => {
    for (const rows of [
      [
        { number: 9, state: "CLOSED", isDraft: false },
        { number: 12, state: "MERGED", isDraft: false },
      ],
      [
        { number: 12, state: "MERGED", isDraft: false },
        { number: 9, state: "CLOSED", isDraft: false },
      ],
    ]) {
      expect(await find(rows)).toMatchObject({ outcome: "found", number: 12, state: "MERGED" });
    }
  });

  it("refuses to choose between two open pull requests", async () => {
    const result = await find([
      { number: 12, state: "OPEN", isDraft: false },
      { number: 13, state: "OPEN", isDraft: true },
    ]);

    expect(result).toMatchObject({ outcome: "failed" });
    // Both numbers named: the recovery is a person looking, so the message has
    // to be enough to look with.
    expect(result.outcome === "failed" ? result.reason : "").toContain("#12, #13");
  });

  it("says none when the branch has no pull request", async () => {
    expect(await find([])).toEqual({ outcome: "none" });
  });

  it("fails rather than reading an unreadable row as an absence", async () => {
    // A dropped row is how a merged pull request turns into "none", which is
    // the one wrong answer that lets the loop start work it should not.
    for (const rows of [[{ number: 12 }], [{ state: "OPEN", isDraft: false }], [null], ["12"]]) {
      expect(await find(rows)).toMatchObject({ outcome: "failed" });
    }
  });

  it("fails on output that is not a JSON list", async () => {
    for (const stdout of ["not json", '{"number":12}', "null"]) {
      const result = await findPullRequest(fakeRunner({ "pr list": { stdout } }), {
        cwd: "/repos/x",
        repo: REPO,
        branch: BRANCH,
        timeoutMs: 30_000,
      });
      expect(result).toMatchObject({ outcome: "failed" });
    }
  });

  it("fails when gh does", async () => {
    const result = await findPullRequest(
      fakeRunner({ "pr list": { exitCode: 1, stderr: "gh: no auth" } }),
      { cwd: "/repos/x", repo: REPO, branch: BRANCH, timeoutMs: 30_000 },
    );

    expect(result).toMatchObject({ outcome: "failed" });
  });
});

describe("reviewOrigin", () => {
  it.each([
    "copilot",
    "Copilot",
    "copilot-pull-request-reviewer",
    "copilot-pull-request-reviewer[bot]",
  ])("calls %j the reviewer", (login) => {
    expect(reviewOrigin(login, COPILOT_REVIEWER)).toBe("reviewer");
  });

  it.each(["a-colleague", "rull3211", "dependabot[bot]", "unknown", ""])(
    "calls %j a human",
    (login) => {
      expect(reviewOrigin(login, COPILOT_REVIEWER)).toBe("human");
    },
  );

  it.each(["", "@", "   ", "@ "])(
    "calls everyone the reviewer when the reviewer setting is %j",
    (reviewer) => {
      // The one asymmetry in this function, and the reason it is written as an
      // early return rather than falling through to `matchesReviewer`. Nothing
      // matches an empty name, so the natural reading makes every comment
      // `human` — and `human` is the exemption from `MAX_REVIEW_ITERATIONS`, so
      // a blank setting would lift the spend cap on every open pull request at
      // once. The exemption is something a reviewer name grants; never
      // something its absence does.
      expect(reviewOrigin("a-colleague", reviewer)).toBe("reviewer");
    },
  );
});
