import { oneLine, shorten } from "../text.ts";
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

export interface FoundPullRequest extends PullRequest {
  /** One line and cut: it is read by a model and never rendered. */
  readonly body: string;
}

export interface PullRequestSource {
  /** Pull requests whose text mentions the key anywhere, read in full. */
  search: (key: string) => Promise<readonly FoundPullRequest[]>;
  /** Pull requests merged in one repository on or after `since` (a date), for a key that only a branch name carries. */
  mergedSince: (repoFull: string, since: string) => Promise<readonly FoundPullRequest[]>;
}

const BODY_CHARS = 700;
const VIEW_FIELDS = "number,title,headRefName,state,mergedAt,additions,deletions,body";
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

  const read = (value: unknown, repoFull: string, what: string): FoundPullRequest => {
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
      body: shorten(oneLine(text(pr["body"])), BODY_CHARS),
    };
  };

  return {
    search: async (key) => {
      // A key that starts with a dash would be read by gh as a flag.
      if (!KEY.test(key)) {
        throw new GithubLookupError(`not an issue key: ${JSON.stringify(key.slice(0, 20))}`);
      }
      const hits = await gh(
        [
          "search",
          "prs",
          key,
          "--owner",
          options.org,
          "--limit",
          "30",
          "--json",
          "number,repository",
        ],
        `searching pull requests for ${key}`,
      );
      if (!Array.isArray(hits)) {
        throw new GithubLookupError(`searching pull requests for ${key}: expected a list`);
      }
      const seen = new Set<string>();
      const found: FoundPullRequest[] = [];
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
      const listed = await gh(
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
          "200",
          "--json",
          VIEW_FIELDS,
        ],
        `listing pull requests merged in ${repoFull}`,
      );
      if (!Array.isArray(listed)) {
        throw new GithubLookupError(`listing pull requests merged in ${repoFull}: expected a list`);
      }
      return listed.map((entry) => read(entry, repoFull, `a merged pull request in ${repoFull}`));
    },
  };
}
