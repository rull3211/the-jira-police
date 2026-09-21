import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type AttachRequest,
  type CommandResult,
  type CommandRunner,
  type WorktreeRequest,
  attachWorktree,
  branchNameFor,
  createWorktree,
  ensureAgentPathsExcluded,
  removeWorktree,
  slugify,
  worktreeAt,
} from "./worktree.ts";

/** A fresh, real directory standing in for `repoPath` — only the tests in this file that ask for one via `excludeAgentPaths` touch real disk. */
function tempRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), "worktree-exclude-"));
}

const OK: CommandResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
const FAIL: CommandResult = { exitCode: 128, stdout: "", stderr: "fatal: nope", timedOut: false };
const TIMEOUT: CommandResult = { exitCode: 0, stdout: "", stderr: "", timedOut: true };

/** Records every argv it is handed and replies from a script. `calls` holds argv arrays, not joined strings, so adjacent arguments can't hide a concatenation. */
function fakeRunner(replies: readonly CommandResult[] = []): CommandRunner & {
  calls: string[][];
} {
  const calls: string[][] = [];
  let index = 0;
  return {
    calls,
    run: (argv) => {
      calls.push([...argv]);
      const reply = replies[index] ?? OK;
      index += 1;
      return Promise.resolve(reply);
    },
  };
}

/** A runner whose `excludeAgentPaths` records every path it was asked to exclude, rather than touching disk. */
function fakeRunnerWithExclude(replies: readonly CommandResult[] = []): CommandRunner & {
  calls: string[][];
  excluded: string[];
} {
  const base = fakeRunner(replies);
  const excluded: string[] = [];
  return {
    ...base,
    excluded,
    excludeAgentPaths: (repoPath) => {
      excluded.push(repoPath);
      return Promise.resolve();
    },
  };
}

const request = (overrides: Partial<WorktreeRequest> = {}): WorktreeRequest => ({
  issueKey: "SSX-3822",
  summary: "Favicon is missing on the advisor page",
  repoPath: "/repos/buy-insurance-advisor-web",
  parentDirectory: "/tmp/solve",
  baseRef: "origin/main",
  timeoutMs: 60_000,
  ...overrides,
});

/** The reason of a refusal, or "" if it was not refused. */
function refusal(result: Awaited<ReturnType<typeof createWorktree>>): string {
  return result.outcome === "refused" ? result.reason : "";
}

const attach = (overrides: Partial<AttachRequest> = {}): AttachRequest => ({
  issueKey: "SSX-3822",
  branch: "fix/ssx-3822-favicon-is-missing",
  repoPath: "/repos/buy-insurance-advisor-web",
  parentDirectory: "/tmp/solve",
  timeoutMs: 60_000,
  ...overrides,
});

/** The index of the first recorded call whose argv contains every one of `words`. */
function at(runner: { calls: string[][] }, ...words: string[]): number {
  return runner.calls.findIndex((argv) => words.every((word) => argv.includes(word)));
}

/** The reason of an attach refusal, or "" if it was not refused. */
function refused(result: Awaited<ReturnType<typeof attachWorktree>>): string {
  return result.outcome === "refused" ? result.reason : "";
}

describe("slugify", () => {
  it("reduces an ordinary summary to a branch fragment", () => {
    expect(slugify("Favicon is missing on the advisor page")).toBe(
      "favicon-is-missing-on-the-advisor-page",
    );
  });

  it("passes through nothing outside the allowlist, whatever it is", () => {
    // Not a list of things to strip — a list of things that must not survive; each means something to git, a shell, or a filesystem.
    for (const hostile of [
      "fix: `rm -rf /` in the handler",
      "crash when path is ../../etc/passwd",
      "branch~1 and HEAD^ and refs:with:colons",
      "glob [a-z]* and question? and star*",
      "back\\slash and 'quote' and \"double\"",
      "at@{brace} and semi;colon && amp",
      "new\nline and \ttab",
    ]) {
      expect(slugify(hostile)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    }
  });

  it("never begins or ends with a separator", () => {
    // A leading `-` makes the branch name look like an option to git; a trailing one is how `.lock` suffixes and empty path components creep in.
    for (const summary of ["   leading spaces", "trailing spaces   ", "--dashes--", "...dots..."]) {
      const slug = slugify(summary);
      expect(slug.startsWith("-")).toBe(false);
      expect(slug.endsWith("-")).toBe(false);
    }
  });

  it("is bounded, and does not leave a trailing separator when it truncates", () => {
    // Truncation mid-separator: cutting `...-x-|-long` at the bar would otherwise end the slug on a dash.
    const slug = slugify(`${"word ".repeat(40)}end`);

    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
  });

  it("returns empty rather than inventing a name it cannot derive", () => {
    for (const summary of ["", "   ", "!!! ???", "。。。", "\u0000\u0001"]) {
      expect(slugify(summary)).toBe("");
    }
  });
});

describe("branchNameFor", () => {
  it("follows the vault convention, lowercased", () => {
    expect(branchNameFor("SSX-3822", "Favicon is missing")).toBe("fix/ssx-3822-favicon-is-missing");
  });

  it("refuses a key this service will not act on", () => {
    for (const key of ["", "ssx-3822", "SSX", "SSX-", "-3822", "SSX-3822-extra", "SSX 3822"]) {
      expect(branchNameFor(key, "a real summary")).toBeNull();
    }
  });

  it("refuses rather than substituting a placeholder for an underivable slug", () => {
    // Two tickets that both fell back to `untitled` would race for one branch.
    expect(branchNameFor("SSX-3822", "!!!")).toBeNull();
  });
});

describe("createWorktree", () => {
  it("excludes agent-owned paths once the worktree is added, when the runner offers it", async () => {
    const runner = fakeRunnerWithExclude();

    await createWorktree(runner, request());

    expect(runner.excluded).toEqual(["/repos/buy-insurance-advisor-web"]);
  });

  it("does not fail the worktree when excludeAgentPaths rejects", async () => {
    const runner = fakeRunner();
    (runner as CommandRunner).excludeAgentPaths = () => Promise.reject(new Error("disk full"));

    const result = await createWorktree(runner, request());

    // A convenience write failing is not a reason to lose the worktree just created; the diff
    // gate is still the backstop this exists to spare it, not the only line of defence.
    expect(result.outcome).toBe("created");
  });

  it("touches nothing when the runner has no excludeAgentPaths, exactly as before this existed", async () => {
    const runner = fakeRunner();

    const result = await createWorktree(runner, request());

    expect(result.outcome).toBe("created");
  });

  it("fetches, checks the base, then adds the worktree — in that order", async () => {
    const runner = fakeRunner();

    const result = await createWorktree(runner, request());

    expect(result).toEqual({
      outcome: "created",
      worktree: {
        issueKey: "SSX-3822",
        path: "/tmp/solve/SSX-3822",
        branch: "fix/ssx-3822-favicon-is-missing-on-the-advisor-page",
        repoPath: "/repos/buy-insurance-advisor-web",
      },
    });
    // Two words, not one: both worktree steps are `git worktree`, so the subcommand alone can't tell list from add.
    expect(runner.calls.map((argv) => argv.slice(3, 5).join(" "))).toEqual([
      "fetch origin",
      "rev-parse --verify",
      "worktree list",
      "worktree add",
    ]);
  });

  it("cuts from the fetched base, on a branch that must not already exist", async () => {
    const runner = fakeRunner();

    await createWorktree(runner, request());

    // `-b` rather than a bare add: a second run for the same ticket must fail rather than reuse a branch that may already carry commits.
    expect(runner.calls[3]).toEqual([
      "git",
      "-C",
      "/repos/buy-insurance-advisor-web",
      "worktree",
      "add",
      "/tmp/solve/SSX-3822",
      "-b",
      "fix/ssx-3822-favicon-is-missing-on-the-advisor-page",
      "origin/main",
    ]);
  });

  it("passes arguments as argv, never as anything a shell would parse", async () => {
    const runner = fakeRunner();

    await createWorktree(runner, request());

    for (const argv of runner.calls) {
      expect(argv[0]).toBe("git");
      // If any single element carried more than one argument, quoting would be load-bearing — and the summary is attacker-controlled text.
      for (const argument of argv) {
        expect(argument).not.toMatch(/\s/u);
      }
    }
  });

  it("touches nothing when the key is not one it will act on", async () => {
    const runner = fakeRunner();

    const result = await createWorktree(runner, request({ issueKey: "../../etc" }));

    expect(refusal(result)).toContain("issue key");
    expect(runner.calls).toEqual([]);
  });

  it("touches nothing when the base ref is malformed", async () => {
    const runner = fakeRunner();

    for (const baseRef of [
      "main",
      "origin/../../x",
      "origin/main;rm -rf /",
      "--upload-pack=evil",
    ]) {
      const result = await createWorktree(runner, request({ baseRef }));
      expect(refusal(result)).toContain("remote-tracking ref");
    }
    expect(runner.calls).toEqual([]);
  });

  it("touches nothing when no branch name can be derived", async () => {
    const runner = fakeRunner();

    const result = await createWorktree(runner, request({ summary: "???" }));

    expect(refusal(result)).toContain("no usable fix/ branch name");
    expect(runner.calls).toEqual([]);
  });

  it("branches as fix/ by default", async () => {
    const runner = fakeRunner();

    const result = await createWorktree(runner, request());

    expect(result).toMatchObject({
      outcome: "created",
      worktree: { branch: expect.stringMatching(/^fix\//u) },
    });
  });

  it("honours a work prefix, so an Oppgave is not branched as a fix", async () => {
    const runner = fakeRunner();

    const result = await createWorktree(runner, request({ branchPrefix: "feat" }));

    expect(result).toMatchObject({
      outcome: "created",
      worktree: { branch: expect.stringMatching(/^feat\//u) },
    });
  });

  it.each(["main", "master", "develop", "release", "hotfix", "origin", "HEAD", ""])(
    "touches nothing when asked to branch as %o",
    async (prefix) => {
      // Never main, never a protected branch: a caller passing one made a mistake that must not resolve into a working branch by default.
      const runner = fakeRunner();

      const result = await createWorktree(runner, request({ branchPrefix: prefix }));

      expect(refusal(result)).toContain("unrecognised prefix");
      expect(runner.calls).toEqual([]);
    },
  );

  it("derives the path from the key, so nothing else can choose where it lands", async () => {
    const runner = fakeRunner();

    const result = await createWorktree(
      runner,
      request({ summary: "../../../escape attempt in the summary" }),
    );

    expect(result.outcome === "created" ? result.worktree.path : "").toBe("/tmp/solve/SSX-3822");
  });

  it("stops at a failed fetch rather than cutting from a stale base", async () => {
    const runner = fakeRunner([FAIL]);

    const result = await createWorktree(runner, request());

    expect(refusal(result)).toContain("fetch origin");
    expect(runner.calls).toHaveLength(1);
  });

  it("stops when the base ref does not resolve, and says so distinctly", async () => {
    // `worktree add` reports a missing base with the same exit code as every other failure, so without this step the reason would be generic.
    const runner = fakeRunner([OK, FAIL]);

    const result = await createWorktree(runner, request());

    expect(refusal(result)).toContain("does not resolve");
    expect(runner.calls).toHaveLength(2);
  });

  it("reports a failed add without claiming a worktree exists", async () => {
    // Four replies, not three: the list sits between the base check and the add, and the failure under test is the add's.
    const runner = fakeRunner([OK, OK, OK, FAIL]);

    const result = await createWorktree(runner, request());

    expect(result.outcome).toBe("refused");
    expect(refusal(result)).toContain("could not create the worktree");
    // Nothing of ours is at the path, so this collision is a bare ref of that name and must still be refused rather than salvaged.
    expect(runner.calls.map((argv) => argv.slice(3, 5).join(" "))).not.toContain("worktree move");
  });

  it("salvages its own predecessor's checkout rather than wedging on it", async () => {
    // A checkout left behind by an earlier run, still holding the branch, must be salvaged rather than making every retry fail identically.
    const branch = "fix/ssx-3822-favicon-is-missing-on-the-advisor-page";
    const runner = fakeRunner([
      OK,
      OK,
      { ...OK, stdout: `worktree /tmp/solve/SSX-3822\nHEAD abc123\nbranch refs/heads/${branch}\n` },
    ]);

    const result = await createWorktree(runner, request());

    expect(result.outcome).toBe("created");

    const verbs = runner.calls.map((argv) => argv.slice(3, 5).join(" "));
    // Moved, never removed: salvage must not become deletion.
    expect(verbs).toContain("worktree move");
    expect(verbs).not.toContain("worktree remove");
    // The cold path then runs as though the machine had never seen this ticket.
    expect(verbs.at(-1)).toBe("worktree add");
  });

  it("treats a timeout as a failure rather than as a zero exit code", async () => {
    // The runner reports a killed command as exit 0 plus `timedOut`, so a check reading only the exit code would read a hung fetch as good.
    const runner = fakeRunner([TIMEOUT]);

    const result = await createWorktree(runner, request());

    expect(refusal(result)).toContain("timed out");
  });

  it("carries git's own complaint into the refusal", async () => {
    const runner = fakeRunner([{ ...FAIL, stderr: "fatal: couldn't find remote ref main" }]);

    expect(refusal(await createWorktree(runner, request()))).toContain("couldn't find remote ref");
  });
});

describe("removeWorktree", () => {
  const worktree = {
    issueKey: "SSX-3822",
    path: "/tmp/solve/SSX-3822",
    branch: "fix/ssx-3822-x",
    repoPath: "/repos/buy-insurance-advisor-web",
  };

  it("removes it after a run that succeeded", async () => {
    const runner = fakeRunner();

    const result = await removeWorktree(runner, worktree, "discard", 30_000);

    expect(result).toEqual({
      outcome: "removed",
      path: "/tmp/solve/SSX-3822",
      branch: { outcome: "deleted" },
    });
    expect(runner.calls[0]).toEqual([
      "git",
      "-C",
      "/repos/buy-insurance-advisor-web",
      "worktree",
      "remove",
      "/tmp/solve/SSX-3822",
    ]);
  });

  it("deletes the branch too, since removing the checkout does not", async () => {
    // Both derived from the issue key, so a ref left behind makes the next run of this same ticket fail at `worktree add -b`.
    const runner = fakeRunner();

    await removeWorktree(runner, worktree, "discard", 30_000);

    expect(runner.calls[1]).toEqual([
      "git",
      "-C",
      "/repos/buy-insurance-advisor-web",
      "branch",
      "-d",
      "fix/ssx-3822-x",
    ]);
  });

  it("never force-deletes the branch", async () => {
    // `-d` refuses when the branch holds commits reachable from nowhere else; `-D` would turn cleanup into data loss on exactly the runs that did work.
    const runner = fakeRunner();

    await removeWorktree(runner, worktree, "discard", 30_000);

    expect(runner.calls[1]).not.toContain("-D");
    expect(runner.calls[1]).not.toContain("--force");
  });

  it("deletes the branch only after the worktree is gone", async () => {
    // git will not delete the branch of a live worktree, so reversed, the delete always fails.
    const runner = fakeRunner();

    await removeWorktree(runner, worktree, "discard", 30_000);

    expect(runner.calls[0]).toContain("worktree");
    expect(runner.calls[1]).toContain("branch");
  });

  it("reports the branch as kept, with git's reason, when git declines", async () => {
    const runner = fakeRunner([
      OK,
      { ...FAIL, exitCode: 1, stderr: "error: the branch 'fix/ssx-3822-x' is not fully merged" },
    ]);

    const result = await removeWorktree(runner, worktree, "discard", 30_000);

    expect(result).toEqual({
      outcome: "removed",
      path: "/tmp/solve/SSX-3822",
      branch: { outcome: "kept", reason: expect.stringContaining("not fully merged") },
    });
  });

  it("still reports the worktree removed when only the branch delete failed", async () => {
    // The checkout really is gone; collapsing that into "kept" would send a human to inspect a directory that no longer exists.
    const runner = fakeRunner([OK, FAIL]);

    expect((await removeWorktree(runner, worktree, "discard", 30_000)).outcome).toBe("removed");
  });

  it("does not claim the branch was deleted when the delete timed out", async () => {
    const runner = fakeRunner([OK, TIMEOUT]);

    const result = await removeWorktree(runner, worktree, "discard", 30_000);

    expect(result.outcome === "removed" && result.branch.outcome).toBe("kept");
  });

  it("does not touch the branch when git would not remove the worktree", async () => {
    // Deleting the branch of a worktree that is still there can strand a checkout with no ref pointing at its commits.
    const runner = fakeRunner([FAIL]);

    await removeWorktree(runner, worktree, "discard", 30_000);

    expect(runner.calls).toHaveLength(1);
  });

  it("keeps the worktree of a failed run, and does not even ask git", async () => {
    // The diff in there is the only record of what the solver did — what a human needs to tell a mis-assessed ticket from a bad fix.
    const runner = fakeRunner();

    const result = await removeWorktree(runner, worktree, "keep-as-evidence", 30_000);

    expect(result.outcome).toBe("kept");
    expect(runner.calls).toEqual([]);
  });

  it("does not force a removal git refused", async () => {
    const runner = fakeRunner([{ ...FAIL, stderr: "fatal: contains modified or untracked files" }]);

    const result = await removeWorktree(runner, worktree, "discard", 30_000);

    expect(result.outcome).toBe("kept");
    expect(runner.calls[0]).not.toContain("--force");
    expect(runner.calls[0]).not.toContain("-f");
  });

  it("keeps it when the removal times out rather than reporting it gone", async () => {
    const runner = fakeRunner([TIMEOUT]);

    expect((await removeWorktree(runner, worktree, "discard", 30_000)).outcome).toBe("kept");
  });
});

describe("attachWorktree", () => {
  it("excludes agent-owned paths once the worktree is added, when the runner offers it", async () => {
    const runner = fakeRunnerWithExclude();

    await attachWorktree(runner, attach());

    expect(runner.excluded).toEqual(["/repos/buy-insurance-advisor-web"]);
  });

  it("checks out the branch the pull request is on", async () => {
    const runner = fakeRunner();

    const result = await attachWorktree(runner, attach());

    expect(result).toEqual({
      outcome: "created",
      worktree: {
        issueKey: "SSX-3822",
        path: "/tmp/solve/SSX-3822",
        branch: "fix/ssx-3822-favicon-is-missing",
        repoPath: "/repos/buy-insurance-advisor-web",
      },
    });
    expect(runner.calls.at(-1)).toEqual([
      "git",
      "-C",
      "/repos/buy-insurance-advisor-web",
      "worktree",
      "add",
      "/tmp/solve/SSX-3822",
      "--track",
      "-b",
      "fix/ssx-3822-favicon-is-missing",
      "origin/fix/ssx-3822-favicon-is-missing",
    ]);
  });

  it("fetches before resolving anything", async () => {
    const runner = fakeRunner();

    await attachWorktree(runner, attach());

    // The branch under review is whatever the reviewer can see; a stale remote-tracking ref would answer on top of the wrong commit.
    expect(runner.calls[0]).toContain("fetch");
  });

  it("resolves the remote branch, not a local one of the same name", async () => {
    const runner = fakeRunner();

    await attachWorktree(runner, attach());

    // Catches dropping the `origin/` prefix: a leftover local branch can be stale or ahead, and resolving it would review the wrong code.
    expect(runner.calls[1]).toContain("origin/fix/ssx-3822-favicon-is-missing^{commit}");
    expect(runner.calls[1]).not.toContain("fix/ssx-3822-favicon-is-missing^{commit}");
  });

  it("refuses a branch that is not an implementation branch", async () => {
    // The whole reason `isWorkBranch` is re-checked here: this name arrives from a pull request, so anyone who can open one picks it.
    for (const hostile of [
      "main",
      "master",
      "origin/main",
      "chore/main",
      "feat/release/2026-09",
      "release/2026-09",
      "refs/heads/main",
      "",
    ]) {
      const runner = fakeRunner();

      const result = await attachWorktree(runner, attach({ branch: hostile }));

      expect(refused(result)).toContain("implementation branch");
      // Nothing ran: a refusal that had already fetched would mean the guard sits after the first side effect.
      expect(runner.calls).toEqual([]);
    }
  });

  it("refuses an issue key it would not act on", async () => {
    const runner = fakeRunner();

    expect(refused(await attachWorktree(runner, attach({ issueKey: "../../etc" })))).toContain(
      "not an issue key",
    );
    expect(runner.calls).toEqual([]);
  });

  it("refuses when the branch is not on the remote", async () => {
    const runner = fakeRunner([OK, FAIL]);

    const result = await attachWorktree(runner, attach());

    expect(refused(result)).toContain("does not resolve to a commit");
    // Refused before `worktree add` — two calls, not three.
    expect(runner.calls).toHaveLength(2);
  });

  it("refuses when git will not create the worktree", async () => {
    // fetch, rev-parse, worktree list, worktree add.
    const runner = fakeRunner([OK, OK, OK, FAIL]);

    expect(refused(await attachWorktree(runner, attach()))).toContain(
      "could not attach a worktree",
    );
  });

  it("refuses when the fetch times out", async () => {
    const runner = fakeRunner([TIMEOUT]);

    expect(refused(await attachWorktree(runner, attach()))).toContain("could not fetch origin");
  });
});

describe("attachWorktree, when the checkout is already there", () => {
  /** The state a successful `--pr` leaves behind: a clean worktree at the derived path, on the branch, level with the remote. */
  const listing = (branch: string | null = "fix/ssx-3822-favicon-is-missing"): CommandResult => ({
    ...OK,
    stdout: [
      "worktree /repos/buy-insurance-advisor-web",
      "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "branch refs/heads/main",
      "",
      "worktree /tmp/solve/SSX-3822",
      "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      branch === null ? "detached" : `branch refs/heads/${branch}`,
      "",
    ].join("\n"),
  });

  const counts = (ahead: number, behind: number): CommandResult => ({
    ...OK,
    stdout: `${String(ahead)}\t${String(behind)}\n`,
  });

  /** fetch, rev-parse, worktree list, status, rev-list — then whatever follows. */
  const upTo = (
    list: CommandResult,
    status: CommandResult = OK,
    ...rest: readonly CommandResult[]
  ): readonly CommandResult[] => [OK, OK, list, status, ...rest];

  it("reuses it instead of trying to build a second one", async () => {
    const runner = fakeRunner(upTo(listing(), OK, counts(0, 0)));

    const result = await attachWorktree(runner, attach());

    expect(result).toEqual({
      outcome: "created",
      worktree: {
        issueKey: "SSX-3822",
        path: "/tmp/solve/SSX-3822",
        branch: "fix/ssx-3822-favicon-is-missing",
        repoPath: "/repos/buy-insurance-advisor-web",
      },
    });
    // Going straight to `worktree add` would refuse every run on the machine that opened the pull request, since publishing keeps its worktree.
    expect(runner.calls.some((argv) => argv.includes("add"))).toBe(false);
  });

  it("fast-forwards a checkout that is behind the remote", async () => {
    const runner = fakeRunner(upTo(listing(), OK, counts(0, 2), OK));

    expect(await attachWorktree(runner, attach())).toMatchObject({ outcome: "created" });
    expect(runner.calls.at(-1)).toEqual([
      "git",
      "-C",
      "/tmp/solve/SSX-3822",
      "merge",
      "--ff-only",
      "origin/fix/ssx-3822-favicon-is-missing",
    ]);
  });

  it("does not merge into a checkout that is already level", async () => {
    const runner = fakeRunner(upTo(listing(), OK, counts(0, 0)));

    await attachWorktree(runner, attach());

    expect(runner.calls.some((argv) => argv.includes("merge"))).toBe(false);
  });

  it("refuses when the worktree listing cannot be read", async () => {
    const runner = fakeRunner([OK, OK, FAIL]);

    expect(refused(await attachWorktree(runner, attach()))).toContain(
      "could not list the repository's worktrees",
    );
  });

  it("refuses when the state of the worktree cannot be read, and moves nothing", async () => {
    // A *read* failure, so it retries: moving a checkout whose contents we couldn't look at would be acting on no information at all.
    const runner = fakeRunner(upTo(listing(), FAIL));

    expect(refused(await attachWorktree(runner, attach()))).toContain(
      "could not read the state of the worktree",
    );
    expect(runner.calls.some((argv) => argv.includes("move"))).toBe(false);
  });

  it("refuses a count it cannot read rather than assuming zero", async () => {
    // Unplug this and an unparseable answer reads as "in sync" — the ahead case wearing a disguise. Still a read failure, so still a refusal.
    const runner = fakeRunner(upTo(listing(), OK, { ...OK, stdout: "warning: no upstream\n" }));

    expect(refused(await attachWorktree(runner, attach()))).toContain("could not read how");
    expect(runner.calls.some((argv) => argv.includes("move"))).toBe(false);
  });
});

/** Each of these states is salvaged rather than refused, since the path is a pure function of the issue key and none clears itself. */
describe("attachWorktree, when the checkout at the path cannot be reused", () => {
  const branch = "fix/ssx-3822-favicon-is-missing";
  const path = "/tmp/solve/SSX-3822";

  const listing = (checkedOut: string | null = branch): CommandResult => ({
    ...OK,
    stdout: [
      `worktree ${path}`,
      "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      checkedOut === null ? "detached" : `branch refs/heads/${checkedOut}`,
      "",
    ].join("\n"),
  });

  const counts = (ahead: number, behind: number): CommandResult => ({
    ...OK,
    stdout: `${String(ahead)}\t${String(behind)}\n`,
  });

  const dirty: CommandResult = { ...OK, stdout: " M src/app/page.tsx\n?? notes.txt\n" };

  /** fetch, rev-parse, worktree list, status, then whatever follows. */
  const upTo = (
    list: CommandResult,
    status: CommandResult = OK,
    ...rest: readonly CommandResult[]
  ): readonly CommandResult[] => [OK, OK, list, status, ...rest];

  it("salvages a dirty checkout instead of stopping the loop on top of it", async () => {
    const runner = fakeRunner(upTo(listing(), dirty));

    expect(await attachWorktree(runner, attach())).toMatchObject({ outcome: "created" });
    expect(at(runner, "worktree", "move")).toBeGreaterThan(-1);
    expect(at(runner, "worktree", "add")).toBeGreaterThan(-1);
  });

  it("moves the dirty checkout aside rather than discarding it", async () => {
    // Uncommitted work is usually not recoverable elsewhere, so it must survive the move intact.
    const runner = fakeRunner(upTo(listing(), dirty));

    await attachWorktree(runner, attach());

    const move = runner.calls[at(runner, "worktree", "move")];
    expect(move?.slice(0, 5)).toEqual([
      "git",
      "-C",
      "/repos/buy-insurance-advisor-web",
      "worktree",
      "move",
    ]);
    expect(move?.[5]).toBe(path);
    expect(move?.[6]).toMatch(/^\/tmp\/solve\/SSX-3822-salvaged-\S+$/u);
    for (const destructive of ["remove", "--force", "-f", "--hard", "clean", "-B"]) {
      expect(runner.calls.some((argv) => argv.includes(destructive))).toBe(false);
    }
  });

  it("frees the branch name in the order git will accept, or not at all", async () => {
    // Git refuses to check out a branch already checked out elsewhere, so detach must precede the rebuild and delete must follow detach.
    const runner = fakeRunner(upTo(listing(), dirty));

    await attachWorktree(runner, attach());

    const detach = at(runner, "checkout", "--detach");
    const move = at(runner, "worktree", "move");
    const remove = at(runner, "branch", "-D");
    const add = at(runner, "worktree", "add");
    expect(detach).toBeGreaterThan(-1);
    expect(runner.calls[detach]?.slice(0, 3)).toEqual(["git", "-C", path]);
    expect(detach).toBeLessThan(move);
    expect(move).toBeLessThan(remove);
    expect(remove).toBeLessThan(add);
  });

  it("salvages a checkout that is ahead, keeping the unreviewed commits reachable", async () => {
    // `branch -D` is safe only because detach happened first: HEAD in the moved worktree still points at the tip, so no history is lost.
    const runner = fakeRunner(upTo(listing(), OK, counts(1, 0)));

    expect(await attachWorktree(runner, attach())).toMatchObject({ outcome: "created" });
    const detach = at(runner, "checkout", "--detach");
    // Asserted present before asserted early: `-1 < anything` is true, so an ordering check alone passes even when the step is missing.
    expect(detach).toBeGreaterThan(-1);
    expect(detach).toBeLessThan(at(runner, "branch", "-D"));
  });

  it("salvages a checkout that cannot be fast-forwarded", async () => {
    const runner = fakeRunner(upTo(listing(), OK, counts(0, 2), FAIL));

    expect(await attachWorktree(runner, attach())).toMatchObject({ outcome: "created" });
    expect(at(runner, "worktree", "move")).toBeGreaterThan(-1);
  });

  it("salvages a checkout on some other branch, and leaves that branch alone", async () => {
    // The name in our way is the one the cold path is about to create; a branch merely checked out here is somebody else's, not ours to touch.
    const runner = fakeRunner(upTo(listing("fix/ssx-9999-something-else")));

    expect(await attachWorktree(runner, attach())).toMatchObject({ outcome: "created" });
    expect(at(runner, "worktree", "move")).toBeGreaterThan(-1);
    expect(at(runner, "checkout", "--detach")).toBe(-1);
    expect(at(runner, "branch", "-D")).toBe(-1);
  });

  it("salvages a detached checkout without deleting a branch it never held", async () => {
    const runner = fakeRunner(upTo(listing(null)));

    expect(await attachWorktree(runner, attach())).toMatchObject({ outcome: "created" });
    expect(at(runner, "worktree", "move")).toBeGreaterThan(-1);
    expect(at(runner, "branch", "-D")).toBe(-1);
  });

  it("checks cleanliness before comparing, so a dirty checkout is never merged into", async () => {
    const runner = fakeRunner(upTo(listing(), dirty));

    await attachWorktree(runner, attach());

    expect(runner.calls.some((argv) => argv.includes("rev-list"))).toBe(false);
    expect(runner.calls.some((argv) => argv.includes("merge"))).toBe(false);
  });

  it("refuses when the checkout cannot be moved aside, rather than building over it", async () => {
    // A half-salvage is worse than the starting state, so the refusal must carry both: what was wrong, and that the repair didn't run.
    const runner = fakeRunner(upTo(listing(), dirty, OK, FAIL));

    const reason = refused(await attachWorktree(runner, attach()));

    expect(reason).toContain("has uncommitted changes");
    expect(reason).toContain("moving the worktree aside failed");
    expect(at(runner, "branch", "-D")).toBe(-1);
    expect(at(runner, "worktree", "add")).toBe(-1);
  });

  it("refuses when the branch cannot be freed, rather than colliding on it", async () => {
    const runner = fakeRunner(upTo(listing(), dirty, FAIL));

    expect(refused(await attachWorktree(runner, attach()))).toContain("detaching HEAD failed");
    expect(at(runner, "worktree", "move")).toBe(-1);
  });

  it("refuses when the stale branch cannot be deleted", async () => {
    const runner = fakeRunner(upTo(listing(), dirty, OK, OK, FAIL));

    expect(refused(await attachWorktree(runner, attach()))).toContain(
      "deleting the local branch failed",
    );
    expect(at(runner, "worktree", "add")).toBe(-1);
  });
});

describe("worktreeAt", () => {
  const porcelain = [
    "worktree /repos/app",
    "HEAD aaaa",
    "branch refs/heads/main",
    "",
    "worktree /tmp/solve/SSX-3822",
    "HEAD bbbb",
    "branch refs/heads/fix/ssx-3822-x",
    "",
  ].join("\n");

  it("finds the branch of the record with the matching path", () => {
    expect(worktreeAt(porcelain, "/tmp/solve/SSX-3822")).toEqual({
      present: true,
      branch: "fix/ssx-3822-x",
    });
  });

  it("reads no branch from a record that is not ours", () => {
    // Drop the path comparison and the first record's branch is returned for every query, so a review round reuses `main`'s checkout.
    expect(worktreeAt(porcelain, "/tmp/solve/SSX-9999")).toEqual({ present: false });
  });

  it("reports a detached record as present with no branch", () => {
    const detached = ["worktree /tmp/solve/SSX-3822", "HEAD bbbb", "detached", ""].join("\n");

    expect(worktreeAt(detached, "/tmp/solve/SSX-3822")).toEqual({ present: true, branch: null });
  });

  it("handles the last record, which has no blank line after it", () => {
    const last = ["worktree /tmp/solve/SSX-3822", "HEAD bbbb", "branch refs/heads/fix/a-1-b"].join(
      "\n",
    );

    expect(worktreeAt(last, "/tmp/solve/SSX-3822")).toEqual({ present: true, branch: "fix/a-1-b" });
  });

  it("does not read the next record's branch when ours names none", () => {
    const bare = [
      "worktree /tmp/solve/SSX-3822",
      "HEAD bbbb",
      "bare",
      "worktree /repos/app",
      "branch refs/heads/main",
    ].join("\n");

    expect(worktreeAt(bare, "/tmp/solve/SSX-3822")).toEqual({ present: true, branch: null });
  });

  it("finds nothing in an empty listing", () => {
    expect(worktreeAt("", "/tmp/solve/SSX-3822")).toEqual({ present: false });
  });
});

describe("ensureAgentPathsExcluded", () => {
  it("writes both agent-owned paths into a fresh repository's exclude file", async () => {
    const repoPath = await tempRepo();

    await ensureAgentPathsExcluded(repoPath);

    const content = await readFile(join(repoPath, ".git", "info", "exclude"), "utf8");
    expect(content).toContain("/.claude/\n");
    expect(content).toContain("/.storecode/\n");
  });

  it("does not disturb lines already in the file", async () => {
    const repoPath = await tempRepo();
    await ensureAgentPathsExcluded(repoPath);

    await ensureAgentPathsExcluded(repoPath);

    const content = await readFile(join(repoPath, ".git", "info", "exclude"), "utf8");
    // A second call must not double the lines — `.git/info/exclude` is shared by every worktree
    // cut from this repo, and `createWorktree` calls this on every single one of them.
    expect(content.split("\n").filter((line) => line === "/.claude/")).toHaveLength(1);
    expect(content.split("\n").filter((line) => line === "/.storecode/")).toHaveLength(1);
  });

  it("appends after whatever a human already put in the file, without disturbing it", async () => {
    const repoPath = await tempRepo();
    await mkdir(join(repoPath, ".git", "info"), { recursive: true });
    await writeFile(join(repoPath, ".git", "info", "exclude"), "*.local\n", "utf8");

    await ensureAgentPathsExcluded(repoPath);

    const content = await readFile(join(repoPath, ".git", "info", "exclude"), "utf8");
    expect(content).toBe("*.local\n/.claude/\n/.storecode/\n");
  });
});
