import type { IssueKind, OtherPullRequest } from "./rules.ts";

/** A repository the report knows about; `web` marks the ones with a user interface. */
export interface RepoInfo {
  readonly name: string;
  readonly full: string;
  readonly kind: "web" | "service";
}

export interface PrFact {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly additions: number;
  readonly deletions: number;
  /** `12 Nov`: the day the pull request merged, in UTC. */
  readonly merged: string;
  readonly flags: readonly string[];
}

export interface IssueFacts {
  readonly key: string;
  readonly kind: IssueKind;
  readonly summary: string;
  /** Jira's timestamp, kept as written: its first ten characters are the day the report files it under. */
  readonly resolved: string;
  readonly reporter: string | null;
  readonly links: readonly {
    readonly key: string;
    readonly label: string;
    readonly open: boolean;
  }[];
  readonly statusNote: string | null;
  /** Plain text, cut; its opening paragraph is the line under the title. */
  readonly description: string;
  readonly prs: readonly PrFact[];
  readonly others: readonly OtherPullRequest[];
}

export interface Facts {
  readonly generated: string;
  readonly window: { readonly start: string; readonly end: string; readonly days: number };
  readonly scope: { readonly label: string; readonly summary: string; readonly jql: string };
  readonly jiraBase: string;
  readonly githubBase: string;
  readonly keyPrefixes: readonly string[];
  readonly repos: readonly RepoInfo[];
  readonly issues: readonly IssueFacts[];
  readonly excluded: readonly { readonly key: string; readonly reason: string }[];
}

export interface ProseEntry {
  readonly key: string;
  readonly theme: string;
  readonly title: string;
  readonly what: string;
  readonly why: string;
  readonly notes: readonly string[];
}

/** The sentences a report shows, keyed by issue key and holding nothing the facts already say. */
export interface Prose {
  readonly themes: readonly { readonly id: string; readonly label: string }[];
  readonly entries: readonly ProseEntry[];
  readonly callouts: readonly { readonly title: string; readonly text: string }[];
}

/** The most categorical colours the page has validated slots for. */
export const MAX_THEMES = 4;

/** The longest a title, and the line under it, may be. */
export const LIMITS = { title: 90, what: 400 } as const;
