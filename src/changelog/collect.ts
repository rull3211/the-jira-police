import type { IssueDetail } from "../jira/client.ts";
import { renderAdf } from "../jira/adf.ts";
import { buildChangelogJql } from "../jira/jql.ts";
import type { JiraIssue } from "../jira/types.ts";
import { oneLine, shorten } from "../text.ts";
import type { FoundPullRequest, PullRequestSource } from "./github.ts";
import { type ExclusionRules, issueKind, judge, judgePullRequests, names } from "./rules.ts";
import type { Facts, IssueFacts, PrFact, RepoInfo } from "./types.ts";

export interface ChangelogSettings {
  readonly project: string;
  readonly component: string | null;
  readonly teamId: string | null;
  /** The name the report carries, usually the team's. */
  readonly label: string;
  /** `https://<site>/browse/`. */
  readonly jiraBase: string;
  readonly org: string;
  readonly repos: readonly RepoInfo[];
  readonly exclusions: ExclusionRules;
}

export interface CollectDeps {
  readonly jira: {
    searchFields: (jql: string, fields: readonly string[]) => Promise<readonly JiraIssue[]>;
    fetchDetail: (key: string) => Promise<IssueDetail>;
  };
  readonly github: PullRequestSource;
  readonly now: () => Date;
}

/** What the search asks for; the payload is read defensively since it is Jira's to change. */
export const SEARCH_FIELDS = [
  "summary",
  "issuetype",
  "status",
  "resolution",
  "resolutiondate",
  "reporter",
  "parent",
  "issuelinks",
] as const;

const DESCRIPTION_CHARS = 1500;
const COMMENT_CHARS = 400;
const COMMENTS_KEPT = 8;
/** A pull request can merge well before its issue is closed, so the branch search looks further back than the window. */
const BRANCH_LOOKBACK_DAYS = 14;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const obj = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const pad = (n: number): string => String(n).padStart(2, "0");

/** A local calendar day, which is the zone a Jira user's timestamps are written in. */
function dayString(date: Date): string {
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const daysBefore = (date: Date, days: number): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() - days);

function mergedDay(mergedAt: string | null): string {
  const day = (mergedAt ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/u.test(day)
    ? `${String(Number(day.slice(8, 10)))} ${MONTHS[Number(day.slice(5, 7)) - 1] ?? "?"}`
    : "unknown";
}

/** A repository that delivered a counted change but is not configured still gets a filter chip, as a service. */
function unconfigured(configured: readonly RepoInfo[], issues: readonly IssueFacts[]): RepoInfo[] {
  const known = new Set(configured.map((repo) => repo.name));
  const extra = new Set(
    issues.flatMap((issue) => issue.prs.map((pr) => pr.repo)).filter((name) => !known.has(name)),
  );
  return [...extra].map((name) => ({ name, full: name, kind: "service" }));
}

interface Read {
  readonly key: string;
  readonly summary: string;
  readonly type: { readonly name: string; readonly subtask: boolean };
  readonly status: { readonly name: string; readonly category: string };
  readonly resolution: string | null;
  readonly resolved: string | null;
  readonly reporter: string | null;
  readonly parent: string | null;
  readonly links: IssueFacts["links"];
}

function read(raw: JiraIssue): Read {
  const fields = obj(raw.fields);
  const status = obj(fields["status"]);
  const type = obj(fields["issuetype"]);
  const links = (
    Array.isArray(fields["issuelinks"]) ? (fields["issuelinks"] as unknown[]) : []
  ).flatMap((entry) => {
    const link = obj(entry);
    const kind = obj(link["type"]);
    const outward = obj(link["outwardIssue"]);
    const other = str(outward["key"]) === null ? obj(link["inwardIssue"]) : outward;
    const key = str(other["key"]);
    if (key === null) {
      return [];
    }
    const label = str(outward["key"]) === null ? str(kind["inward"]) : str(kind["outward"]);
    const category = str(obj(obj(obj(other["fields"])["status"])["statusCategory"])["key"]);
    return [{ key, label: label ?? str(kind["name"]) ?? "linked", open: category !== "done" }];
  });
  return {
    key: raw.key,
    summary: str(fields["summary"]) ?? raw.key,
    type: { name: str(type["name"]) ?? "", subtask: type["subtask"] === true },
    status: {
      name: str(status["name"]) ?? "unknown",
      category: str(obj(status["statusCategory"])["key"]) ?? "unknown",
    },
    resolution: str(obj(fields["resolution"])["name"]),
    resolved: str(fields["resolutiondate"]),
    reporter: str(obj(fields["reporter"])["displayName"]),
    parent: str(obj(fields["parent"])["key"]),
    links,
  };
}

/**
 * Everything a changelog states as fact, read from Jira and GitHub and classified by the rules in
 * `rules.ts`. Reads only. `queryKeys` is what Jira answered, kept for the gate to compare against.
 */
export async function collectFacts(
  deps: CollectDeps,
  settings: ChangelogSettings,
  days: number,
): Promise<{ readonly facts: Facts; readonly queryKeys: readonly string[] }> {
  const now = deps.now();
  const end = dayString(now);
  const start = dayString(daysBefore(now, days));
  const jql = buildChangelogJql({
    project: settings.project,
    component: settings.component,
    teamId: settings.teamId,
    days,
  });

  const raw = await deps.jira.searchFields(jql, SEARCH_FIELDS);
  const queryKeys = raw.map((issue) => issue.key);

  const merged = new Map<string, Promise<readonly FoundPullRequest[]>>();
  const mergedIn = (repoFull: string): Promise<readonly FoundPullRequest[]> => {
    const cached =
      merged.get(repoFull) ??
      deps.github.mergedSince(repoFull, dayString(daysBefore(now, days + BRANCH_LOOKBACK_DAYS)));
    merged.set(repoFull, cached);
    return cached;
  };

  const issues: IssueFacts[] = [];
  const excluded: { key: string; reason: string }[] = [];

  for (const issue of raw) {
    const one = read(issue);
    const verdict = judge(
      { key: one.key, status: one.status, resolution: one.resolution, resolved: one.resolved },
      settings.exclusions,
    );
    if (verdict.kind === "excluded" || one.resolved === null) {
      excluded.push({
        key: one.key,
        reason: verdict.kind === "excluded" ? verdict.reason : "no resolution",
      });
      continue;
    }

    const detail = await deps.jira.fetchDetail(one.key);
    const found = await deps.github.search(one.key);
    let judged = judgePullRequests(one.key, found);
    let bodies = new Map(found.map((pr) => [`${pr.repo}#${String(pr.number)}`, pr.body] as const));
    if (judged.counted.length === 0) {
      // A key only a branch name carries is invisible to the search, so look where the branches are.
      const extra: FoundPullRequest[] = [];
      for (const repo of settings.repos) {
        for (const pr of await mergedIn(repo.full)) {
          const seen = (list: readonly FoundPullRequest[]): boolean =>
            list.some((f) => f.repo === pr.repo && f.number === pr.number);
          if (names(one.key, pr.branch) && !seen(found) && !seen(extra)) {
            extra.push(pr);
          }
        }
      }
      judged = judgePullRequests(one.key, [...found, ...extra]);
      bodies = new Map([
        ...bodies,
        ...extra.map((pr) => [`${pr.repo}#${String(pr.number)}`, pr.body] as const),
      ]);
    }

    const prs: PrFact[] = judged.counted.map((pr) => ({
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      body: bodies.get(`${pr.repo}#${String(pr.number)}`) ?? "",
      additions: pr.additions,
      deletions: pr.deletions,
      merged: mergedDay(pr.mergedAt),
      flags: pr.flags,
    }));

    issues.push({
      key: one.key,
      kind: issueKind(one.type),
      summary: one.summary,
      resolved: one.resolved,
      reporter: one.reporter,
      parent: one.parent,
      links: one.links,
      statusNote: verdict.statusStale
        ? `Jira shows ${one.status.name} although the issue was resolved ${one.resolved.slice(0, 16).replace("T", " ")}.`
        : null,
      description: shorten(renderAdf(detail.description), DESCRIPTION_CHARS),
      comments: detail.comments.slice(-COMMENTS_KEPT).map((comment) => ({
        author: comment.author,
        created: comment.created,
        text: shorten(oneLine(renderAdf(comment.body)), COMMENT_CHARS),
      })),
      prs,
      others: judged.others,
    });
  }

  const scope = [
    settings.component === null ? null : `component ${settings.component}`,
    settings.teamId === null ? null : `team ${settings.label}`,
  ].filter((part) => part !== null);
  const facts: Facts = {
    generated: end,
    window: { start, end, days },
    scope: {
      label: settings.label,
      summary: `project ${settings.project}, ${scope.join(" or ")}, resolved in the window.`,
      jql,
    },
    jiraBase: settings.jiraBase,
    githubBase: `https://github.com/${settings.org}/`,
    keyPrefixes: [
      ...new Set(
        [
          settings.project,
          ...issues.flatMap((issue) => issue.links.map((link) => link.key.split("-")[0] ?? "")),
        ].filter((prefix) => prefix !== ""),
      ),
    ],
    repos: [...settings.repos, ...unconfigured(settings.repos, issues)],
    issues,
    excluded,
  };
  return { facts, queryKeys };
}
