import { describe, expect, it } from "vitest";

import type { CommandResult, CommandRunner } from "../solve/worktree.ts";
import { GithubLookupError, createGithubSource } from "./github.ts";

const OPTIONS = {
  org: "acme",
  repos: [{ name: "advisor", full: "repo-a" }],
  cwd: "/tmp",
  timeoutMs: 1000,
};

const ok = (value: unknown): CommandResult => ({
  exitCode: 0,
  stdout: JSON.stringify(value),
  stderr: "",
  timedOut: false,
});

function fake(reply: (argv: readonly string[]) => CommandResult): {
  runner: CommandRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      run: async (argv) => {
        calls.push([...argv]);
        return reply(argv);
      },
    },
  };
}

const view = (over: Record<string, unknown> = {}) => ({
  number: 5,
  title: "feat(SSX-1): a change",
  headRefName: "feat/ssx-1",
  state: "MERGED",
  mergedAt: "2026-11-10T10:00:00Z",
  additions: 12,
  deletions: 3,
  body: "line one\n\n\nline   two",
  ...over,
});

describe("createGithubSource.search", () => {
  it("searches once, reads each distinct pull request once, and names a repository by its alias", async () => {
    const { runner, calls } = fake((argv) => {
      if (argv[1] === "search") {
        return ok([
          { number: 5, repository: { name: "repo-a" } },
          { number: 5, repository: { name: "repo-a" } },
          { number: 7, repository: { name: "repo-b" } },
        ]);
      }
      return ok(view({ number: Number(argv[3]) }));
    });

    const found = await createGithubSource(runner, OPTIONS).search("SSX-1");

    expect(found.map((pr) => [pr.repo, pr.number])).toEqual([
      ["advisor", 5],
      ["repo-b", 7],
    ]);
    expect(found[0]).toMatchObject({
      state: "merged",
      mergedAt: "2026-11-10T10:00:00Z",
      additions: 12,
      deletions: 3,
      branch: "feat/ssx-1",
    });
    // The duplicate hit must not be read twice: a loop without the `seen` set makes three views.
    expect(calls.filter((call) => call[1] === "pr" && call[2] === "view")).toHaveLength(2);
    expect(calls[0]).toEqual([
      "gh",
      "search",
      "prs",
      "SSX-1",
      "--owner",
      "acme",
      "--limit",
      "30",
      "--json",
      "number,repository",
    ]);
    expect(calls[1]).toContain("acme/repo-a");
  });

  it("puts a body on one line and cuts it", async () => {
    const { runner } = fake((argv) =>
      argv[1] === "search"
        ? ok([{ number: 5, repository: { name: "repo-a" } }])
        : ok(view({ body: `${"word ".repeat(300)}\n\nmore` })),
    );
    const [pr] = await createGithubSource(runner, OPTIONS).search("SSX-1");
    expect(pr?.body).not.toContain("\n");
    expect(pr?.body.length).toBeLessThanOrEqual(701);
    expect(pr?.body.endsWith("…")).toBe(true);
  });

  it("reads a pull request that was never merged as having no merge time", async () => {
    const { runner } = fake((argv) =>
      argv[1] === "search"
        ? ok([{ number: 5, repository: { name: "repo-a" } }])
        : ok(view({ state: "CLOSED", mergedAt: null })),
    );
    expect((await createGithubSource(runner, OPTIONS).search("SSX-1"))[0]).toMatchObject({
      state: "closed",
      mergedAt: null,
    });
  });

  it("refuses a key that gh would read as a flag, before running anything", async () => {
    const { runner, calls } = fake(() => ok([]));
    await expect(createGithubSource(runner, OPTIONS).search("--json")).rejects.toThrow(
      GithubLookupError,
    );
    expect(calls).toEqual([]);
  });

  it("says which step failed and why when gh exits non-zero", async () => {
    const { runner } = fake(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "HTTP 401: Bad credentials",
      timedOut: false,
    }));
    await expect(createGithubSource(runner, OPTIONS).search("SSX-1")).rejects.toThrow(
      "searching pull requests for SSX-1 failed: exit 1: HTTP 401: Bad credentials",
    );
  });

  it("refuses output that is not JSON, and a state it does not know", async () => {
    const bad = fake(() => ({ exitCode: 0, stdout: "not json", stderr: "", timedOut: false }));
    await expect(createGithubSource(bad.runner, OPTIONS).search("SSX-1")).rejects.toThrow(
      /not JSON/u,
    );

    const odd = fake((argv) =>
      argv[1] === "search"
        ? ok([{ number: 5, repository: { name: "repo-a" } }])
        : ok(view({ state: "DRAFT" })),
    );
    await expect(createGithubSource(odd.runner, OPTIONS).search("SSX-1")).rejects.toThrow(
      /unknown pull request state "DRAFT"/u,
    );
  });
});

describe("createGithubSource.mergedSince", () => {
  it("lists the merged pull requests of one repository from a date", async () => {
    const { runner, calls } = fake(() =>
      ok([view({ number: 9, headRefName: "ssx-4266-move-button" })]),
    );
    const listed = await createGithubSource(runner, OPTIONS).mergedSince("repo-a", "2026-11-05");

    expect(listed.map((pr) => [pr.repo, pr.number, pr.branch])).toEqual([
      ["advisor", 9, "ssx-4266-move-button"],
    ]);
    expect(calls[0]).toEqual([
      "gh",
      "pr",
      "list",
      "--repo",
      "acme/repo-a",
      "--state",
      "merged",
      "--search",
      "merged:>=2026-11-05",
      "--limit",
      "200",
      "--json",
      expect.stringContaining("headRefName"),
    ]);
  });

  it("refuses a repository or date that is not plain", async () => {
    const { runner, calls } = fake(() => ok([]));
    const source = createGithubSource(runner, OPTIONS);
    await expect(source.mergedSince("repo a;rm", "2026-11-05")).rejects.toThrow(GithubLookupError);
    await expect(source.mergedSince("repo-a", "yesterday")).rejects.toThrow(GithubLookupError);
    expect(calls).toEqual([]);
  });
});
