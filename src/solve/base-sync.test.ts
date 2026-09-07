/**
 * The guards on merging a base into a branch that is under review.
 *
 * Every assertion here is about something the module must *not* do, which is
 * the shape of the risk: the happy path is one `git merge` and one `git push`,
 * and the interesting cases are all refusals. Three of them protect work that
 * cannot be recovered — a human's uncommitted edits, a conflict resolved by
 * discarding one side, a merge commit pushed under nobody's name — and the
 * rest exist because #2661 proved that a wrong answer here is not a wrong
 * answer, it is seventeen paid rounds of the same one.
 */

import { describe, expect, it } from "vitest";

import { type BaseSyncRequest, attachSynced, syncWithBase } from "./base-sync.ts";
import type { CommandResult, CommandRunner } from "./worktree.ts";

const OK: CommandResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
const FAIL: CommandResult = { exitCode: 1, stdout: "", stderr: "fatal: nope", timedOut: false };

const out = (stdout: string): CommandResult => ({ ...OK, stdout });

/**
 * Replies by matching the argv, not by counting calls.
 *
 * A positional script would pass a mutation that skipped a command and shifted
 * every later reply onto the wrong one, which is exactly the class of edit
 * these tests exist to catch. Matching on the argv means a test that expected
 * a `push` reply and got no `push` at all fails rather than silently reading
 * somebody else's answer.
 */
function fakeGit(replies: Readonly<Record<string, CommandResult>> = {}): CommandRunner & {
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    run: (argv) => {
      calls.push([...argv]);
      const line = argv.join(" ");
      const key = Object.keys(replies).find((match) => line.includes(match));
      return Promise.resolve(key === undefined ? OK : (replies[key] ?? OK));
    },
  };
}

/** Every argv the runner saw, one string per command, for `toContain` reads. */
const lines = (runner: { calls: string[][] }): string[] =>
  runner.calls.map((argv) => argv.join(" "));

/** Whether any command matched — the "did it do the dangerous thing" question. */
const ran = (runner: { calls: string[][] }, match: string): boolean =>
  lines(runner).some((line) => line.includes(match));

const request = (overrides: Partial<BaseSyncRequest> = {}): BaseSyncRequest => ({
  issueKey: "SSX-3833",
  branch: "fix/ssx-3833-date-of-birth",
  worktreePath: "/tmp/solve/SSX-3833",
  baseRef: "origin/main",
  identity: { name: "jira-police", email: "jira-police@example.invalid" },
  timeoutMs: 60_000,
  ...overrides,
});

/** A repository seven commits ahead of the branch, and everything else fine. */
const BEHIND_SEVEN = { "rev-list --count": out("7\n") };

const reason = (result: Awaited<ReturnType<typeof syncWithBase>>): string =>
  result.outcome === "refused" ? result.reason : "";

describe("syncWithBase", () => {
  it("does nothing at all to a branch that already contains its base", async () => {
    const git = fakeGit({ "rev-list --count": out("0\n") });

    const result = await syncWithBase(git, request());

    expect(result).toEqual({ outcome: "current" });
    // The reason this matters beyond tidiness: `advance` calls this on every
    // round that has work, and a merge commit per round on an up-to-date branch
    // would be a wall of noise on a pull request a human has to read.
    expect(ran(git, "merge")).toBe(false);
    expect(ran(git, "push")).toBe(false);
  });

  it("merges the base in and pushes it in the same breath", async () => {
    const git = fakeGit(BEHIND_SEVEN);

    const result = await syncWithBase(git, request());

    expect(result).toEqual({ outcome: "merged", behind: 7 });
    // Drop the push and this is the mutation that survives everything else: the
    // merge is right, the round proceeds, and the checkout is now *ahead* of
    // `origin` — which `attachWorktree` treats as unusable, so the next tick
    // salvages it and rebuilds. One wedged pull request made fifteen
    // `-salvaged-` directories that way.
    expect(ran(git, "push origin fix/ssx-3833-date-of-birth")).toBe(true);
  });

  it("puts a name on the merge commit, before the -C git reads it after", async () => {
    const git = fakeGit(BEHIND_SEVEN);

    await syncWithBase(git, request());

    const merge = git.calls.find((argv) => argv.includes("merge")) ?? [];
    // `-c` is a git option and must precede the subcommand, so the position is
    // load-bearing rather than cosmetic: after `-C` it is parsed as an argument
    // to `merge` and the commit is attributed to whatever global config the
    // machine happens to carry, or to nobody.
    expect(merge.indexOf("-c")).toBeLessThan(merge.indexOf("-C"));
    expect(merge).toContain("user.name=jira-police");
    expect(merge).toContain("user.email=jira-police@example.invalid");
  });

  it("refuses a dirty checkout rather than sweeping it into a merge commit", async () => {
    const git = fakeGit({ "status --porcelain": out(" M src/utils/DateUtils.ts\n") });

    const result = await syncWithBase(git, request());

    expect(reason(result)).toContain("uncommitted changes");
    // The worst thing this module could do, and the only one that is not
    // recoverable: a merge commits everything it finds, and a merge commit is
    // the last place anyone would look for their lost afternoon.
    expect(ran(git, "merge")).toBe(false);
  });

  it("aborts a conflicted merge and reports the files rather than leaving them", async () => {
    const git = fakeGit({
      ...BEHIND_SEVEN,
      "merge --no-edit": FAIL,
      "diff --name-only": out("src/utils/DateUtils.ts\npackage.json\n"),
    });

    const result = await syncWithBase(git, request());

    expect(result).toEqual({
      outcome: "conflicted",
      behind: 7,
      files: ["src/utils/DateUtils.ts", "package.json"],
    });
    // Conflict markers in the working tree are uncommitted changes. Leave the
    // merge in progress and the next tick's reuse check salvages the checkout —
    // the loop tidies away the very state a resolver was meant to look at.
    expect(ran(git, "merge --abort")).toBe(true);
    expect(ran(git, "push")).toBe(false);
  });

  it("refuses rather than resolving a merge that failed with no conflicted paths", async () => {
    const git = fakeGit({ ...BEHIND_SEVEN, "merge --no-edit": FAIL });

    const result = await syncWithBase(git, request());

    // A merge that fails with nothing in `--diff-filter=U` failed for some
    // other reason — a hook, a lock, an index git would not touch — and that is
    // not something a resolver can be handed a file list for.
    expect(result.outcome).toBe("refused");
    expect(ran(git, "push")).toBe(false);
  });

  it("undoes the merge when the push fails, so the checkout is not left ahead", async () => {
    const git = fakeGit({ ...BEHIND_SEVEN, "push origin": FAIL });

    const result = await syncWithBase(git, request());

    expect(reason(result)).toContain("could not push");
    // `ORIG_HEAD` is set by the merge and names the commit the branch was on a
    // moment ago, so this discards our own merge commit and nothing else — the
    // tree was proved clean two commands earlier. Without it the branch is
    // ahead of `origin` with no way to get the commit there, which is the
    // salvage churn again by a different route.
    expect(ran(git, "reset --hard ORIG_HEAD")).toBe(true);
  });

  it("refuses an unreadable behind-count instead of reading it as up to date", async () => {
    const git = fakeGit({ "rev-list --count": out("fatal: bad revision") });

    const result = await syncWithBase(git, request());

    // Zero is the answer that skips the merge, so a count that will not parse
    // must not land on it. That mutation is #2661 exactly: a stale branch
    // declared current, and the round pays a pass to discover otherwise.
    expect(result.outcome).toBe("refused");
    expect(reason(result)).toContain("how far");
  });

  it("will not merge anything into a branch that is not an implementation branch", async () => {
    const git = fakeGit();

    const result = await syncWithBase(git, request({ branch: "main" }));

    // The standing rule, re-checked here rather than assumed of the caller,
    // because this function commits and pushes and the branch name reaches it
    // from a pull request.
    expect(reason(result)).toContain("not an implementation branch");
    expect(git.calls).toEqual([]);
  });

  it("will not take a base ref that is not a remote-tracking ref", async () => {
    const git = fakeGit();

    const result = await syncWithBase(git, request({ baseRef: "main" }));

    expect(reason(result)).toContain("not a remote-tracking ref");
    expect(git.calls).toEqual([]);
  });

  it("refuses when the base does not resolve, without blaming the merge", async () => {
    const git = fakeGit({ "rev-parse": FAIL });

    const result = await syncWithBase(git, request());

    expect(reason(result)).toContain("does not resolve to a commit");
    expect(ran(git, "merge")).toBe(false);
  });
});

const attachRequest = {
  issueKey: "SSX-3833",
  branch: "fix/ssx-3833-date-of-birth",
  repoPath: "/repos/buy-insurance-advisor-web",
  parentDirectory: "/tmp/solve",
  timeoutMs: 60_000,
  baseRef: "origin/main",
  identity: { name: "jira-police", email: "jira-police@example.invalid" },
};

/** `worktree list --porcelain` for a clean checkout on the expected branch. */
const LISTED = out(
  "worktree /tmp/solve/SSX-3833\nHEAD abc\nbranch refs/heads/fix/ssx-3833-date-of-birth\n",
);

describe("attachSynced", () => {
  it("syncs the checkout it attached, so a round never starts on a stale branch", async () => {
    const git = fakeGit({
      "worktree list": LISTED,
      "rev-list --left-right": out("0\t0\n"),
      "rev-list --count": out("7\n"),
    });

    const result = await attachSynced(git, attachRequest);

    expect(result.outcome).toBe("created");
    expect(ran(git, "merge --no-edit origin/main")).toBe(true);
    expect(ran(git, "push origin fix/ssx-3833-date-of-birth")).toBe(true);
  });

  it("hands back a conflict as a refusal, which is a failed start and not a round", async () => {
    const git = fakeGit({
      "worktree list": LISTED,
      "rev-list --left-right": out("0\t0\n"),
      "rev-list --count": out("7\n"),
      "merge --no-edit": FAIL,
      "diff --name-only": out("src/utils/DateUtils.ts\n"),
    });

    const result = await attachSynced(git, attachRequest);

    // A refusal here reaches `recordFailedStart`, bounded at three, rather than
    // the reservation, bounded at twenty and paid for each time. That placement
    // is the whole reason the sync runs in the attach path.
    expect(result.outcome).toBe("refused");
    expect(result.outcome === "refused" && result.reason).toContain("src/utils/DateUtils.ts");
  });

  it("returns the attach refusal untouched rather than syncing a checkout it has not got", async () => {
    const git = fakeGit({ fetch: FAIL });

    const result = await attachSynced(git, attachRequest);

    expect(result.outcome).toBe("refused");
    expect(result.outcome === "refused" && result.reason).toContain("could not fetch origin");
    expect(ran(git, "merge")).toBe(false);
  });
});
