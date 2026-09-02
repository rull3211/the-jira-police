/**
 * Minimal Jira Cloud client — one operation, JQL search.
 *
 * Uses `/rest/api/3/search/jql`, the token-paginated replacement for the
 * removed `/rest/api/3/search`. Pagination is by opaque `nextPageToken`; there
 * is no total count and no numeric offset.
 *
 * Authentication is HTTP Basic with an Atlassian API credential as the password
 * half. The header is built once and never logged; error paths below are
 * written to describe failures without echoing it.
 */

import { logger } from "../logger.ts";
import { type JiraIssue, type JiraSearchResponse, type TicketRef, toTicketRef } from "./types.ts";

/** Only the fields the pipeline actually reads. */
const FIELDS = [
  "summary",
  "issuetype",
  "created",
  "status",
  "priority",
  "labels",
  "components",
  "reporter",
] as const;

const MAX_RESULTS_PER_PAGE = 50;

/** Guard against an unbounded loop if the API keeps handing back page tokens. */
const MAX_PAGES = 10;

export class JiraError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "JiraError";
    this.status = status;
  }
}

export interface JiraClientOptions {
  readonly baseUrl: string;
  readonly email: string;
  /** Atlassian API credential for the account above. */
  readonly auth: string;
  readonly timeoutMs?: number;
}

export class JiraClient {
  readonly #baseUrl: string;
  readonly #authHeader: string;
  readonly #timeoutMs: number;

  constructor(options: JiraClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#authHeader = `Basic ${Buffer.from(`${options.email}:${options.auth}`).toString("base64")}`;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: this.#authHeader,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      // Network-level failure: no status to report.
      throw new JiraError(0, `Request to ${path} failed: ${(error as Error).message}`);
    }

    if (response.ok) {
      return await response.json();
    }

    // Read the body for context, but never include the request headers.
    const detail = (await response.text().catch(() => "")).slice(0, 300);

    if (response.status === 401 || response.status === 403) {
      throw new JiraError(
        response.status,
        `Jira rejected the credentials (${response.status}). Check JIRA_EMAIL and JIRA_AUTH; API credentials are revoked when the account password changes.`,
      );
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after") ?? "unknown";
      throw new JiraError(429, `Rate limited by Jira; retry-after=${retryAfter}`);
    }

    throw new JiraError(response.status, `Jira returned ${response.status}: ${detail}`);
  }

  /** Runs a JQL search, following pagination, and normalises the results. */
  async search(jql: string): Promise<readonly TicketRef[]> {
    const collected: TicketRef[] = [];
    let nextPageToken: string | undefined;
    let page = 0;

    do {
      const payload = (await this.#post("/rest/api/3/search/jql", {
        jql,
        fields: FIELDS,
        maxResults: MAX_RESULTS_PER_PAGE,
        ...(nextPageToken === undefined ? {} : { nextPageToken }),
      })) as JiraSearchResponse;

      for (const issue of payload.issues ?? []) {
        collected.push(toTicketRef(issue as JiraIssue, this.#baseUrl));
      }

      nextPageToken = payload.isLast === true ? undefined : payload.nextPageToken;
      page += 1;

      if (page >= MAX_PAGES && nextPageToken !== undefined) {
        logger.warn("jira.pagination_truncated", { pages: page, jql });
        break;
      }
    } while (nextPageToken !== undefined);

    logger.debug("jira.search_complete", { found: collected.length, pages: page });
    return collected;
  }
}
