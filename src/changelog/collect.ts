import type { IssueDetail } from "../jira/client.ts";
import { renderAdf } from "../jira/adf.ts";
import { buildChangelogJql } from "../jira/jql.ts";
import type { JiraIssue } from "../jira/types.ts";
import { shorten } from "../text.ts";
import type { PullRequestSource } from "./github.ts";
import {
  DEFAULT_EXCLUSIONS,
  MONTHS,
  type PullRequest,
  issueKind,
  judge,
  judgePullRequests,
  names,
} from "./rules.ts";
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
  "issuelinks",
] as const;

const DESCRIPTION_CHARS = 1500;
/** A pull request can merge well before its issue is closed, so the branch search looks further back than the window. */
const BRANCH_LOOKBACK_DAYS = 14;

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
  readonly links: IssueFacts["links"];
}

/** The document with every text mark (bold, italic, code, link) removed, so its rendering holds no markup characters. */
const unmarked = (adf: unknown): unknown =>
  JSON.parse(JSON.stringify(adf ?? null), (key, value: unknown) =>
    key === "marks" ? undefined : value,
  );

/** Two link types between one pair of issues are one piece of linked work, listed once. */
function onePerIssue(links: IssueFacts["links"]): IssueFacts["links"] {
  const byKey = new Map<string, { labels: Set<string>; open: boolean }>();
  for (const link of links) {
    const seen = byKey.get(link.key);
    if (seen === undefined) {
      byKey.set(link.key, { labels: new Set([link.label]), open: link.open });
    } else {
      seen.labels.add(link.label);
    }
  }
  return [...byKey].map(([key, one]) => ({
    key,
    label: [...one.labels].join(", "),
    open: one.open,
  }));
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
    links: onePerIssue(links),
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

  const merged = new Map<string, Promise<readonly PullRequest[]>>();
  const mergedIn = (repoFull: string): Promise<readonly PullRequest[]> => {
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
      DEFAULT_EXCLUSIONS,
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
    if (judged.counted.length === 0) {
      // A key only a branch name carries is invisible to the search, so look where the branches are.
      const extra: PullRequest[] = [];
      for (const repo of settings.repos) {
        for (const pr of await mergedIn(repo.full)) {
          const seen = (list: readonly PullRequest[]): boolean =>
            list.some((f) => f.repo === pr.repo && f.number === pr.number);
          if (names(one.key, pr.branch) && !seen(found) && !seen(extra)) {
            extra.push(pr);
          }
        }
      }
      judged = judgePullRequests(one.key, [...found, ...extra]);
    }

    const prs: PrFact[] = judged.counted.map((pr) => ({
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
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
      links: one.links,
      statusNote: verdict.statusStale
        ? `Jira shows ${one.status.name} although the issue was resolved ${one.resolved.slice(0, 16).replace("T", " ")}.`
        : null,
      description: shorten(renderAdf(unmarked(detail.description)), DESCRIPTION_CHARS),
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
