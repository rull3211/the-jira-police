/** The guards on merging a base into a branch under review; the happy path is one merge and one push, and the interesting cases are all refusals. */

import { describe, expect, it } from "vitest";

import { type BaseSyncRequest, attachSynced, syncWithBase } from "./base-sync.ts";
import type { CommandResult, CommandRunner } from "./worktree.ts";

const OK: CommandResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
const FAIL: CommandResult = { exitCode: 1, stdout: "", stderr: "fatal: nope", timedOut: false };

const out = (stdout: string): CommandResult => ({ ...OK, stdout });

/** Replies by matching the argv, not by counting calls, so a skipped command fails the test instead of silently shifting replies. */
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

/** Seven commits behind the base, everything else fine. */
const BEHIND_SEVEN = { "rev-list --count": out("7\n") };

const reason = (result: Awaited<ReturnType<typeof syncWithBase>>): string =>
  result.outcome === "refused" ? result.reason : "";

describe("syncWithBase", () => {
  it("does nothing at all to a branch that already contains its base", async () => {
    const git = fakeGit({ "rev-list --count": out("0\n") });

    const result = await syncWithBase(git, request());

    expect(result).toEqual({ outcome: "current" });
    // Called on every round with work; a merge commit per round on an already-current branch would be noise on a reviewed PR.
    expect(ran(git, "merge")).toBe(false);
    expect(ran(git, "push")).toBe(false);
  });

  it("merges the base in and pushes it in the same breath", async () => {
    const git = fakeGit(BEHIND_SEVEN);

    const result = await syncWithBase(git, request());

    expect(result).toEqual({ outcome: "merged", behind: 7 });
    // Without the push, the checkout is ahead of `origin`, which `attachWorktree` treats as unusable and salvages on the next tick.
    expect(ran(git, "push origin fix/ssx-3833-date-of-birth")).toBe(true);
  });

  it("puts a name on the merge commit, before the -C git reads it after", async () => {
    const git = fakeGit(BEHIND_SEVEN);

    await syncWithBase(git, request());

    const merge = git.calls.find((argv) => argv.includes("merge")) ?? [];
    // `-c` must precede `-C`, or it's parsed as a `merge` argument and the commit is attributed to whatever global config exists, or nobody.
    expect(merge.indexOf("-c")).toBeLessThan(merge.indexOf("-C"));
    expect(merge).toContain("user.name=jira-police");
    expect(merge).toContain("user.email=jira-police@example.invalid");
  });

  it("refuses a dirty checkout rather than sweeping it into a merge commit", async () => {
    const git = fakeGit({ "status --porcelain": out(" M src/utils/DateUtils.ts\n") });

    const result = await syncWithBase(git, request());

    expect(reason(result)).toContain("uncommitted changes");
    // Unrecoverable if this happened: a merge commits everything it finds.
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
    // A merge left in progress makes the next tick's reuse check salvage the checkout the resolver needed.
    expect(ran(git, "merge --abort")).toBe(true);
    expect(ran(git, "push")).toBe(false);
  });

  it("refuses rather than resolving a merge that failed with no conflicted paths", async () => {
    const git = fakeGit({ ...BEHIND_SEVEN, "merge --no-edit": FAIL });

    const result = await syncWithBase(git, request());

    // No paths in `--diff-filter=U` means the merge failed for some other reason a resolver can't be handed a file list for.
    expect(result.outcome).toBe("refused");
    expect(ran(git, "push")).toBe(false);
  });

  it("undoes the merge when the push fails, so the checkout is not left ahead", async () => {
    const git = fakeGit({ ...BEHIND_SEVEN, "push origin": FAIL });

    const result = await syncWithBase(git, request());

    expect(reason(result)).toContain("could not push");
    // `ORIG_HEAD` names the pre-merge commit, so this discards only our merge commit, not any other work.
    expect(ran(git, "reset --hard ORIG_HEAD")).toBe(true);
  });

  it("refuses an unreadable behind-count instead of reading it as up to date", async () => {
    const git = fakeGit({ "rev-list --count": out("fatal: bad revision") });

    const result = await syncWithBase(git, request());

    // Zero skips the merge, so an unparseable count must not land on it.
    expect(result.outcome).toBe("refused");
    expect(reason(result)).toContain("how far");
  });

  it("will not merge anything into a branch that is not an implementation branch", async () => {
    const git = fakeGit();

    const result = await syncWithBase(git, request({ branch: "main" }));

    // Re-checked rather than assumed of the caller, since this function commits and pushes.
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

  it("hands a conflict back as a third outcome, with the checkout and what git flagged", async () => {
    const git = fakeGit({
      "worktree list": LISTED,
      "rev-list --left-right": out("0\t0\n"),
      "rev-list --count": out("7\n"),
      "merge --no-edit": FAIL,
      "diff --name-only": out("src/utils/DateUtils.ts\n"),
    });

    const result = await attachSynced(git, attachRequest);

    // Not a refusal: the checkout and branch are fine, only the merge failed, and a resolver pass can fix it.
    expect(result.outcome).toBe("conflicted");
    if (result.outcome !== "conflicted") {
      return;
    }
    expect(result.worktree.path).toBe(`${attachRequest.parentDirectory}/${attachRequest.issueKey}`);
    expect(result.worktree.branch).toBe(attachRequest.branch);
    expect(result.behind).toBe(7);
    // Read from `--diff-filter=U`, never from a model: these paths decide what a resolver is allowed to touch.
    expect(result.files).toEqual(["src/utils/DateUtils.ts"]);
    // Aborted before the handover, so the reuse check finds nothing to salvage; `beginMerge` re-cuts the merge.
    expect(ran(git, "merge --abort")).toBe(true);
  });

  it("returns the attach refusal untouched rather than syncing a checkout it has not got", async () => {
    const git = fakeGit({ fetch: FAIL });

    const result = await attachSynced(git, attachRequest);

    expect(result.outcome).toBe("refused");
    expect(result.outcome === "refused" && result.reason).toContain("could not fetch origin");
    expect(ran(git, "merge")).toBe(false);
  });
});
