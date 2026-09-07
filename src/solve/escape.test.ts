/**
 * The write-escape guard, tested the way it fails.
 *
 * Every assertion here is about the guard going *quiet* when it should not.
 * That is the only failure that matters: a false alarm costs a person one look
 * at a diff, and a false silence is the thing the probes found — a pass writing
 * into a checkout nobody is watching, past a diff gate that only reads the
 * worktree. So the mutations these tests are written against all have the same
 * shape — make a change read as no change — and each is named where it is
 * caught.
 */

import { describe, expect, it } from "vitest";

import { UNREADABLE, describeEscape, escapedRepos, snapshotRepos } from "./escape.ts";
import type { CommandResult, CommandRunner } from "./worktree.ts";

const OK: CommandResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };

/**
 * Replies per directory, keyed on the `-C <path>` argument rather than on call
 * order, so a mutation that skips a directory fails here rather than silently
 * reading the next one's answer.
 */
function fakeGit(replies: Readonly<Record<string, CommandResult>> = {}): CommandRunner & {
  calls: { argv: string[]; cwd: string; timeoutMs: number }[];
} {
  const calls: { argv: string[]; cwd: string; timeoutMs: number }[] = [];
  return {
    calls,
    run: (argv, options) => {
      calls.push({ argv: [...argv], cwd: options.cwd, timeoutMs: options.timeoutMs });
      const path = argv[argv.indexOf("-C") + 1] ?? "";
      return Promise.resolve(replies[path] ?? OK);
    },
  };
}

const state = (path: string, status: string) => ({ path, status });

describe("snapshotRepos", () => {
  it("asks each directory for its whole working tree, untracked files expanded", async () => {
    const git = fakeGit();

    await snapshotRepos(git, ["/repos/one", "/repos/two"], 5_000);

    expect(git.calls.map((call) => call.argv)).toEqual([
      ["git", "-C", "/repos/one", "status", "--porcelain", "-uall"],
      ["git", "-C", "/repos/two", "status", "--porcelain", "-uall"],
    ]);
  });

  it("passes the caller's timeout to every call", async () => {
    const git = fakeGit();

    await snapshotRepos(git, ["/repos/one", "/repos/two"], 1_234);

    expect(git.calls.map((call) => call.timeoutMs)).toEqual([1_234, 1_234]);
  });

  it("records what git reported, verbatim and uninterpreted", async () => {
    const git = fakeGit({
      "/repos/one": { ...OK, stdout: " M src/a.ts\n?? src/b.ts\n" },
    });

    const snapshot = await snapshotRepos(git, ["/repos/one"], 5_000);

    expect(snapshot).toEqual([state("/repos/one", " M src/a.ts\n?? src/b.ts\n")]);
  });

  // Mutation: drop `!result.timedOut`. A killed status call returns "", which
  // compares equal to a clean checkout, so the guard switches itself off at the
  // exact moment the machine is unhealthy enough to kill git.
  it("does not read a timed-out status as a clean working tree", async () => {
    const git = fakeGit({
      "/repos/one": { exitCode: 0, stdout: "", stderr: "", timedOut: true },
    });

    const snapshot = await snapshotRepos(git, ["/repos/one"], 5_000);

    expect(snapshot).toEqual([state("/repos/one", UNREADABLE)]);
  });

  // Mutation: drop the exit-code check. Same failure by a different route — a
  // directory that is not a repository answers non-zero with empty stdout.
  it("does not read a failed status as a clean working tree", async () => {
    const git = fakeGit({
      "/repos/gone": { exitCode: 128, stdout: "", stderr: "not a git repository", timedOut: false },
    });

    const snapshot = await snapshotRepos(git, ["/repos/gone"], 5_000);

    expect(snapshot).toEqual([state("/repos/gone", UNREADABLE)]);
  });

  // Mutation: skip unreadable directories instead of recording a sentinel. The
  // guard then silently stops guarding a mistyped path, which is the one thing
  // it must not do quietly.
  it("keeps an entry for a directory it could not read", async () => {
    const git = fakeGit({
      "/repos/gone": { exitCode: 128, stdout: "", stderr: "nope", timedOut: false },
    });

    const snapshot = await snapshotRepos(git, ["/repos/one", "/repos/gone", "/repos/two"], 5_000);

    expect(snapshot.map((entry) => entry.path)).toEqual([
      "/repos/one",
      "/repos/gone",
      "/repos/two",
    ]);
  });
});

describe("escapedRepos", () => {
  it("is quiet when nothing moved", () => {
    const before = [state("/repos/one", " M src/a.ts\n"), state("/repos/two", "")];

    expect(escapedRepos(before, [...before])).toEqual([]);
  });

  it("is quiet when a checkout was dirty before the run and is dirty the same way after", () => {
    // The common case on this operator's machine: three of five checkouts are
    // dirty and on feature branches. A guard that flagged those would be turned
    // off within a day.
    const dirty = [state("/repos/one", " M src/a.ts\n?? notes.md\n")];

    expect(escapedRepos(dirty, [state("/repos/one", " M src/a.ts\n?? notes.md\n")])).toEqual([]);
  });

  it("names a checkout whose working tree changed under the run", () => {
    const before = [state("/repos/one", ""), state("/repos/two", "")];
    const after = [state("/repos/one", ""), state("/repos/two", "?? stray.ts\n")];

    expect(escapedRepos(before, after)).toEqual(["/repos/two"]);
  });

  // Mutation: compare by index instead of by path. Passes while both snapshots
  // happen to be built from the same list in the same order, and reports every
  // repository the moment one is added, removed, or read out of order.
  it("compares by path, not by position", () => {
    const before = [state("/repos/one", "A"), state("/repos/two", "B")];
    const after = [state("/repos/two", "B"), state("/repos/one", "A")];

    expect(escapedRepos(before, after)).toEqual([]);
  });

  // Mutation: iterate only `before`, or only `after`. An entry that appears or
  // vanishes between the two reads is not "nothing happened".
  it("treats a path present in only one snapshot as changed", () => {
    expect(escapedRepos([], [state("/repos/new", "")])).toEqual(["/repos/new"]);
    expect(escapedRepos([state("/repos/old", "")], [])).toEqual(["/repos/old"]);
  });

  it("becoming unreadable mid-run is a change, and staying unreadable is not", () => {
    expect(escapedRepos([state("/r", "")], [state("/r", UNREADABLE)])).toEqual(["/r"]);
    expect(escapedRepos([state("/r", UNREADABLE)], [state("/r", UNREADABLE)])).toEqual([]);
  });

  // Mutation: drop the sort. The output is read by a person and diffed by
  // tests; an order that depends on `Set` insertion is a flaky report.
  it("reports paths in a stable order", () => {
    const before = [state("/z", ""), state("/a", ""), state("/m", "")];
    const after = [state("/z", "x"), state("/a", "x"), state("/m", "x")];

    expect(escapedRepos(before, after)).toEqual(["/a", "/m", "/z"]);
  });
});

describe("describeEscape", () => {
  it("names every path rather than counting them", () => {
    expect(describeEscape(["/repos/one", "/repos/two"])).toBe(
      "changed outside the worktree during this run: /repos/one, /repos/two",
    );
  });
});
