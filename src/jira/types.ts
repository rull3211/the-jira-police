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
  /** Same format as `created`. Jira sets it on every edit, including our own. */
  readonly updated?: string;
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

/**
 * Normalised shape passed to the rest of the pipeline.
 *
 * Carries the union of what both queues need rather than splitting into two
 * types. The new-issue poller ignores `labels` and `updated`; the solve queue
 * ignores `created`. That is a little waste in exchange for one normaliser over
 * one payload — and the alternative was tried on paper and rejected, because two
 * functions mapping the same Jira response are two things that drift, and the
 * drift shows up as a field that is silently empty on one path only.
 */
export interface TicketRef {
  readonly key: string;
  readonly summary: string;
  readonly issueTypeId: string;
  readonly issueTypeName: string;
  readonly created: string;
  /**
   * Last modification, as Jira reports it.
   *
   * Empty when Jira did not return the field. That is not expected — `updated`
   * is a system field present on every issue — but the honest normalisation of
   * an absent value is an absent value, not `created` standing in for it. A
   * caller that sorts on this will fail loudly on the empty string rather than
   * silently ordering a ticket by the wrong instant, which is the behaviour
   * worth having if this ever does go missing.
   */
  readonly updated: string;
  /**
   * Every label live on the issue.
   *
   * The solve queue's entire state is in here — the claim, the human's
   * go-ahead and both terminal verdicts are all labels — so dropping this
   * during normalisation, as this function used to, made the queue unfeedable.
   */
  readonly labels: readonly string[];
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
    url: `${baseUrl}/browse/${issue.key}`,
  };
}
