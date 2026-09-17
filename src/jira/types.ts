/** The slice of the Jira issue payload this service actually uses. */

export interface JiraIssueType {
  readonly id: string;
  readonly name: string;
  readonly subtask: boolean;
}

export interface JiraNamed {
  readonly name: string;
}

/** Its own interface rather than `JiraNamed` since matching a configured status against a real one needs the id, not just the name. */
export interface JiraStatus {
  readonly id: string;
  readonly name: string;
}

export interface JiraUser {
  readonly accountId: string;
  readonly displayName: string;
  readonly emailAddress?: string;
}

export interface JiraIssueFields {
  readonly summary: string;
  readonly issuetype: JiraIssueType;
  /** ISO-8601 with offset, e.g. 2026-09-02T09:55:34.178+0200 */
  readonly created: string;
  /** Same format as `created`. Jira sets it on every edit, including our own. */
  readonly updated?: string;
  readonly status?: JiraStatus;
  readonly priority?: JiraNamed;
  readonly labels?: readonly string[];
  readonly components?: readonly JiraNamed[];
  readonly reporter?: JiraUser;
  readonly description?: unknown;
}

export interface JiraIssue {
  readonly id: string;
  readonly key: string;
  readonly fields: JiraIssueFields;
}

export interface JiraSearchResponse {
  readonly issues?: readonly JiraIssue[];
  readonly nextPageToken?: string;
  readonly isLast?: boolean;
}

/** Carries the union of what both queues need rather than splitting into two types, since two mappers of the same response drift apart. */
export interface TicketRef {
  readonly key: string;
  readonly summary: string;
  readonly issueTypeId: string;
  readonly issueTypeName: string;
  readonly created: string;
  /** Empty, not `created`, when Jira did not return the field: a caller sorting on this fails loudly instead of silently ordering by the wrong instant. */
  readonly updated: string;
  /** Every label live on the issue; the solve queue's entire state — claim, go-ahead, terminal verdicts — is here. */
  readonly labels: readonly string[];
  /** Empty rather than a placeholder when Jira did not return the field, for `updated`'s reason above. */
  readonly statusId: string;
  readonly statusName: string;
  readonly url: string;
}

export function toTicketRef(issue: JiraIssue, baseUrl: string): TicketRef {
  return {
    key: issue.key,
    summary: issue.fields.summary,
    issueTypeId: issue.fields.issuetype.id,
    issueTypeName: issue.fields.issuetype.name,
    created: issue.fields.created,
    updated: issue.fields.updated ?? "",
    labels: issue.fields.labels ?? [],
    statusId: issue.fields.status?.id ?? "",
    statusName: issue.fields.status?.name ?? "",
    url: `${baseUrl}/browse/${issue.key}`,
  };
}
