import { type CommandRunner, failed, why } from "../solve/worktree.ts";
import type { PullRequest } from "./rules.ts";

export class GithubLookupError extends Error {}

export interface GithubOptions {
  readonly org: string;
  /** Display name to repository name; a repository not listed shows under its own name. */
  readonly repos: readonly { readonly name: string; readonly full: string }[];
  readonly cwd: string;
  readonly timeoutMs: number;
}

export interface PullRequestSource {
  /** Pull requests whose text mentions the key anywhere, read in full. */
  search: (key: string) => Promise<readonly PullRequest[]>;
  /** Pull requests merged in one repository on or after `since` (a date), for a key that only a branch name carries. */
  mergedSince: (repoFull: string, since: string) => Promise<readonly PullRequest[]>;
}

/** A result that reaches its limit may have been cut, and a report built on a cut list looks complete. */
const SEARCH_LIMIT = 30;
const LIST_LIMIT = 200;
const VIEW_FIELDS = "number,title,headRefName,state,mergedAt,additions,deletions";
const KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/u;
const REPO = /^[A-Za-z0-9._-]+$/u;
const SINCE = /^\d{4}-\d{2}-\d{2}$/u;

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GithubLookupError(`${what}: expected an object`);
  }
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

function stateOf(value: unknown, what: string): PullRequest["state"] {
  const state = text(value).toLowerCase();
  if (state === "merged" || state === "open" || state === "closed") {
    return state;
  }
  throw new GithubLookupError(
    `${what}: unknown pull request state ${JSON.stringify(text(value).slice(0, 20))}`,
  );
}

export function createGithubSource(
  runner: CommandRunner,
  options: GithubOptions,
): PullRequestSource {
  const aliasOf = (full: string): string =>
    options.repos.find((repo) => repo.full === full)?.name ?? full;

  const gh = async (argv: readonly string[], what: string): Promise<unknown> => {
    const result = await runner.run(["gh", ...argv], {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
    });
    if (failed(result)) {
      throw new GithubLookupError(`${what} failed: ${why(result)}`);
    }
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      throw new GithubLookupError(
        `${what} printed something that is not JSON: ${result.stdout.slice(0, 120)}`,
      );
    }
  };

  const list = (value: unknown, limit: number, what: string): readonly unknown[] => {
    if (!Array.isArray(value)) {
      throw new GithubLookupError(`${what}: expected a list`);
    }
    if (value.length >= limit) {
      throw new GithubLookupError(
        `${what} returned the ${String(limit)} it was limited to, so it may have been cut`,
      );
    }
    return value;
  };

  const read = (value: unknown, repoFull: string, what: string): PullRequest => {
    const pr = record(value, what);
    return {
      repo: aliasOf(repoFull),
      number: count(pr["number"]),
      title: text(pr["title"]),
      branch: text(pr["headRefName"]),
      state: stateOf(pr["state"], what),
      additions: count(pr["additions"]),
      deletions: count(pr["deletions"]),
      mergedAt: text(pr["mergedAt"]) === "" ? null : text(pr["mergedAt"]),
    };
  };

  return {
    search: async (key) => {
      // A key that starts with a dash would be read by gh as a flag.
      if (!KEY.test(key)) {
        throw new GithubLookupError(`not an issue key: ${JSON.stringify(key.slice(0, 20))}`);
      }
      const what = `searching pull requests for ${key}`;
      const hits = list(
        await gh(
          [
            "search",
            "prs",
            key,
            "--owner",
            options.org,
            "--limit",
            String(SEARCH_LIMIT),
            "--json",
            "number,repository",
          ],
          what,
        ),
        SEARCH_LIMIT,
        what,
      );
      const seen = new Set<string>();
      const found: PullRequest[] = [];
      for (const hit of hits) {
        const entry = record(hit, `a search hit for ${key}`);
        const repoFull = text(record(entry["repository"], `a search hit for ${key}`)["name"]);
        const number = count(entry["number"]);
        const id = `${repoFull}#${String(number)}`;
        if (!REPO.test(repoFull) || number < 1 || seen.has(id)) {
          continue;
        }
        seen.add(id);
        const view = await gh(
          [
            "pr",
            "view",
            String(number),
            "--repo",
            `${options.org}/${repoFull}`,
            "--json",
            VIEW_FIELDS,
          ],
          `reading ${id}`,
        );
        found.push(read(view, repoFull, `reading ${id}`));
      }
      return found;
    },

    mergedSince: async (repoFull, since) => {
      if (!REPO.test(repoFull) || !SINCE.test(since)) {
        throw new GithubLookupError(
          `unusable repository or date: ${JSON.stringify(repoFull.slice(0, 40))} ${JSON.stringify(since.slice(0, 20))}`,
        );
      }
      const what = `listing pull requests merged in ${repoFull}`;
      const listed = list(
        await gh(
          [
            "pr",
            "list",
            "--repo",
            `${options.org}/${repoFull}`,
            "--state",
            "merged",
            "--search",
            `merged:>=${since}`,
            "--limit",
            String(LIST_LIMIT),
            "--json",
            VIEW_FIELDS,
          ],
          what,
        ),
        LIST_LIMIT,
        what,
      );
      return listed.map((entry) => read(entry, repoFull, `a merged pull request in ${repoFull}`));
    },
  };
}
