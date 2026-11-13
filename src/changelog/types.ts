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
  /** Cut and fenced before a model reads it; never rendered. */
  readonly body: string;
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
  readonly parent: string | null;
  readonly links: readonly {
    readonly key: string;
    readonly label: string;
    readonly open: boolean;
  }[];
  readonly statusNote: string | null;
  /** Plain text, cut. Read by a model; the page shows only what the model wrote from it. */
  readonly description: string;
  readonly comments: readonly {
    readonly author: string;
    readonly created: string;
    readonly text: string;
  }[];
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

/** Everything a model writes: sentences keyed by issue key, and nothing a harness already knows. */
export interface Prose {
  readonly themes: readonly { readonly id: string; readonly label: string }[];
  readonly entries: readonly ProseEntry[];
  readonly callouts: readonly { readonly title: string; readonly text: string }[];
}

/** The most categorical colours the page has validated slots for. */
export const MAX_THEMES = 4;

/** Bounds on what a model may write; the parser enforces them and the schema's descriptions state them. */
export const LIMITS = {
  title: 90,
  what: 400,
  why: 240,
  note: 240,
  notes: 3,
  callouts: 4,
  calloutTitle: 60,
  calloutText: 320,
  themeLabel: 24,
} as const;
