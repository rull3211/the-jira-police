/** The slice of the Jira issue payload this service actually uses. */

export interface JiraIssueType {
  readonly id: string;
  readonly name: string;
  readonly subtask: boolean;
}

export interface JiraNamed {
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
  readonly status?: JiraNamed;
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

/** Normalised shape passed to the rest of the pipeline. */
export interface TicketRef {
  readonly key: string;
  readonly summary: string;
  readonly issueTypeId: string;
  readonly issueTypeName: string;
  readonly created: string;
  readonly url: string;
}

export function toTicketRef(issue: JiraIssue, baseUrl: string): TicketRef {
  return {
    key: issue.key,
    summary: issue.fields.summary,
    issueTypeId: issue.fields.issuetype.id,
    issueTypeName: issue.fields.issuetype.name,
    created: issue.fields.created,
    url: `${baseUrl}/browse/${issue.key}`,
  };
}
