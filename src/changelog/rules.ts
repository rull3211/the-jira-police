/**
 * What a changelog counts, and which pull requests belong to which issue.
 * Pure: no Jira, no GitHub, no clock. Every rule is one a hand-made report met first.
 */

export const MAX_DAYS = 31;

export class ChangelogArgError extends Error {}

/** `7` or `7d`; absent means a week. Anything else is refused, never rounded into a window. */
export function parseDays(raw: string | undefined, max: number = MAX_DAYS): number {
  const text = (raw ?? "").trim();
  if (text === "") {
    return 7;
  }
  const match = /^(\d{1,3})d?$/iu.exec(text);
  const days = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isInteger(days) || days < 1 || days > max) {
    throw new ChangelogArgError(
      `days must be a whole number from 1 to ${String(max)}, got "${text.slice(0, 20)}"`,
    );
  }
  return days;
}

export type IssueKind = "bug" | "task" | "story" | "sub" | "other";

/** Jira's type names are localised (Feil, Oppgave, Historie), so the subtask flag decides first. */
export function issueKind(type: { readonly name: string; readonly subtask: boolean }): IssueKind {
  if (type.subtask) {
    return "sub";
  }
  if (/\b(bug|feil)\b/iu.test(type.name)) {
    return "bug";
  }
  if (/\b(story|historie)\b/iu.test(type.name)) {
    return "story";
  }
  if (/\b(task|oppgave)\b/iu.test(type.name)) {
    return "task";
  }
  return "other";
}

export interface ExclusionRules {
  readonly statuses: readonly string[];
  readonly resolutions: readonly string[];
}

/** A rejected ticket can carry resolution `Solved`, so status is checked as well as resolution. */
export const DEFAULT_EXCLUSIONS: ExclusionRules = {
  statuses: ["Avvist", "Rejected", "Won't Do", "Cancelled"],
  resolutions: ["Duplikat", "Duplicate", "Won't Do", "Won't Fix", "Cannot Reproduce"],
};

export interface JudgedIssue {
  readonly key: string;
  readonly status: { readonly name: string; readonly category: string };
  readonly resolution: string | null;
  readonly resolved: string | null;
}

export type Verdict =
  | { readonly kind: "counted"; readonly statusStale: boolean }
  | { readonly kind: "excluded"; readonly reason: string };

const sameName = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** An issue with no resolution is excluded rather than counted: the query asked for resolved ones, so one that is not is a surprise. */
export function judge(issue: JudgedIssue, rules: ExclusionRules): Verdict {
  const badStatus = rules.statuses.find((name) => sameName(name, issue.status.name));
  if (badStatus !== undefined) {
    return { kind: "excluded", reason: `status ${issue.status.name}` };
  }
  if (issue.resolution === null || issue.resolved === null) {
    return { kind: "excluded", reason: "no resolution" };
  }
  const badResolution = rules.resolutions.find((name) => sameName(name, issue.resolution ?? ""));
  if (badResolution !== undefined) {
    return { kind: "excluded", reason: `resolution ${issue.resolution}` };
  }
  return { kind: "counted", statusStale: issue.status.category.toLowerCase() !== "done" };
}

/** The day as Jira wrote the timestamp, not converted: a report reads in the zone its readers' Jira shows. */
export function dayOf(timestamp: string): string {
  return timestamp.slice(0, 10);
}

export interface PullRequest {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly branch: string;
  readonly state: "merged" | "open" | "closed";
  readonly additions: number;
  readonly deletions: number;
  readonly mergedAt: string | null;
}

export interface CountedPullRequest extends PullRequest {
  readonly flags: readonly string[];
}

export interface OtherPullRequest {
  readonly repo: string;
  readonly number: number;
  readonly why: string;
}

/** A key as a whole token: `SSX-427` is not in `SSX-4271`, and `ssx-4266-move-button` names `SSX-4266`. */
export function names(key: string, text: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![0-9])`, "iu").test(text);
}

const sameChange = (a: PullRequest, b: PullRequest): boolean =>
  a.repo === b.repo &&
  a.title === b.title &&
  a.additions === b.additions &&
  a.deletions === b.deletions;

/**
 * Splits what a search returned into the pull requests that delivered `key` and the ones that only
 * mention it. Ownership is the key in the title or branch: a body mentions follow-ups and siblings.
 */
export function judgePullRequests(
  key: string,
  candidates: readonly PullRequest[],
): {
  readonly counted: readonly CountedPullRequest[];
  readonly others: readonly OtherPullRequest[];
} {
  const others: OtherPullRequest[] = [];
  const owned: PullRequest[] = [];
  for (const pr of candidates) {
    if (!names(key, pr.title) && !names(key, pr.branch)) {
      others.push({
        repo: pr.repo,
        number: pr.number,
        why: "mentions the issue without being named for it",
      });
    } else if (pr.state === "open") {
      others.push({ repo: pr.repo, number: pr.number, why: "still open" });
    } else if (pr.state === "closed") {
      others.push({ repo: pr.repo, number: pr.number, why: "closed without merging" });
    } else {
      owned.push(pr);
    }
  }
  const byMerge = owned.toSorted(
    (a, b) => (a.mergedAt ?? "").localeCompare(b.mergedAt ?? "") || a.number - b.number,
  );
  const counted: CountedPullRequest[] = [];
  for (const [index, pr] of byMerge.entries()) {
    const flags: string[] = [];
    if (/^revert\b/iu.test(pr.title)) {
      flags.push("revert");
    }
    const first = byMerge.slice(0, index).find((earlier) => sameChange(earlier, pr));
    if (first !== undefined) {
      flags.push(`twin of #${String(first.number)}`);
    }
    counted.push({ ...pr, flags });
  }
  return { counted, others };
}
