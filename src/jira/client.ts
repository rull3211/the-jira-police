/**
 * Minimal Jira Cloud client — discovery reads only.
 *
 * Three operations: a JQL search, one issue's full detail, and one
 * attachment's bytes. All three are reads. **Nothing in this file writes to
 * Jira, and nothing should be added that does** — the standing rule is that
 * this REST credential discovers work and the storecode MCP session performs
 * every mutation, so that the credential which lives in a `.env` file cannot
 * change a ticket even if it leaks.
 *
 * `search` uses `/rest/api/3/search/jql`, the token-paginated replacement for
 * the removed `/rest/api/3/search`. Pagination is by opaque `nextPageToken`;
 * there is no total count and no numeric offset.
 *
 * Authentication is HTTP Basic with an Atlassian API credential as the password
 * half. The header is built once and never logged; error paths below are
 * written to describe failures without echoing it.
 *
 * ## Why detail is a second call rather than more fields on the search
 *
 * `search` deliberately asks for a narrow `FIELDS` list, because it runs over
 * every new ticket on the board on a timer and pays for each field on each of
 * them. `description`, `comment` and `attachment` are the three largest fields
 * an issue has and the poller reads none of them. So they are fetched once, for
 * the single ticket a solve is about to act on, rather than being added to a
 * list that is evaluated dozens of times an hour to be thrown away.
 */

import { logger } from "../logger.ts";
import { type JiraIssue, type JiraSearchResponse, type TicketRef, toTicketRef } from "./types.ts";

/**
 * Issue keys and attachment ids are interpolated into a URL path, so they are
 * validated rather than trusted.
 *
 * The threat is not exotic: an issue key of `../../../rest/api/3/myself` turns
 * a detail fetch into a call to a different endpoint, and an operator typing a
 * key on the command line is the normal way this value arrives. Anchored
 * patterns, and a rejection rather than an escape, because there is no
 * legitimate key this excludes — Jira keys are `PROJECT-123` and nothing else.
 */
const ISSUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const ATTACHMENT_ID_PATTERN = /^\d+$/;

export function assertIssueKey(key: string): void {
  if (!ISSUE_KEY_PATTERN.test(key)) {
    throw new JiraError(0, `Refusing to fetch a malformed issue key: ${JSON.stringify(key)}`);
  }
}

export function assertAttachmentId(id: string): void {
  if (!ATTACHMENT_ID_PATTERN.test(id)) {
    throw new JiraError(0, `Refusing to fetch a malformed attachment id: ${JSON.stringify(id)}`);
  }
}

/** Only the fields the pipeline actually reads. */
const FIELDS = [
  "summary",
  "issuetype",
  "created",
  // Requested for the solve queue, which orders by it. The new-issue poller has
  // no use for it and pays a few bytes a ticket, which is cheaper than a second
  // field list to keep in step with a second normaliser.
  "updated",
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

/** One comment, with its body left as raw ADF for `renderAdf` to deal with. */
export interface JiraComment {
  readonly id: string;
  readonly author: string;
  /** ISO-8601 with offset. */
  readonly created: string;
  /** ADF. Attacker-controlled; rendered as data, never interpreted. */
  readonly body: unknown;
}

export interface JiraAttachment {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
}

/**
 * Everything a solve needs to know about one ticket.
 *
 * `description` and `body` stay as `unknown` on purpose. They are ADF trees
 * whose shape is Atlassian's to change, and typing them here would be a claim
 * about a structure this service does not control; `renderAdf` is written to be
 * total against arbitrary input for the same reason.
 */
export interface IssueDetail {
  readonly key: string;
  readonly summary: string;
  readonly issueTypeName: string;
  readonly status: string;
  readonly labels: readonly string[];
  /** ADF. */
  readonly description: unknown;
  readonly comments: readonly JiraComment[];
  readonly attachments: readonly JiraAttachment[];
  readonly url: string;
}

/**
 * Attachment media types worth inlining into a prompt as text.
 *
 * SVG is the case that motivated this: it is an image by media type and a text
 * file by content, so a naive `startsWith("image/")` check would have hidden
 * exactly the asset a ticket most often supplies. Everything outside this set
 * is listed by name and size and not fetched — a PNG rendered as mojibake helps
 * nobody and costs tokens in proportion to the file.
 */
const INLINEABLE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/svg+xml",
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
]);

export function isInlineable(mimeType: string): boolean {
  // Strip any `; charset=utf-8` parameter before comparing.
  const bare = (mimeType.split(";")[0] ?? "").trim().toLowerCase();
  return bare.startsWith("text/") || INLINEABLE_MIME_TYPES.has(bare);
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

    return await this.#raise(response);
  }

  /**
   * Turns a non-OK response into the most specific error available.
   *
   * Shared by every verb so a 401 reads the same however it was provoked. Reads
   * the body for context and never the request headers — the credential is in
   * those, and an error message is the most likely thing to end up in a log.
   */
  async #raise(response: Response): Promise<never> {
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

  async #get(path: string, accept: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        method: "GET",
        headers: { Authorization: this.#authHeader, Accept: accept },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new JiraError(0, `Request to ${path} failed: ${(error as Error).message}`);
    }

    if (!response.ok) {
      await this.#raise(response);
    }
    return response;
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

  /**
   * Everything one ticket says, for the one ticket a solve is about to act on.
   *
   * Asks for `comment` and `attachment` explicitly. Leaving them out is the
   * mistake this method exists to correct: the solve path was about to be wired
   * to `search`, whose `FIELDS` list has neither, which would have handed the
   * solver a one-line summary and no acceptance criteria — while every comment
   * in the pipeline described it as receiving "the ticket".
   */
  async fetchDetail(key: string): Promise<IssueDetail> {
    assertIssueKey(key);
    const fields = "summary,issuetype,status,labels,description,comment,attachment";
    const response = await this.#get(
      `/rest/api/3/issue/${key}?fields=${fields}`,
      "application/json",
    );
    const payload = (await response.json()) as DetailPayload;
    const f = payload.fields ?? {};

    const comments = (f.comment?.comments ?? []).map((raw) => ({
      id: String(raw.id ?? ""),
      author: raw.author?.displayName ?? "unknown",
      created: raw.created ?? "",
      body: raw.body,
    }));

    const attachments = (f.attachment ?? []).map((raw) => ({
      id: String(raw.id ?? ""),
      filename: raw.filename ?? "",
      mimeType: raw.mimeType ?? "",
      size: raw.size ?? 0,
    }));

    logger.debug("jira.detail_fetched", {
      key,
      comments: comments.length,
      attachments: attachments.length,
    });

    return {
      key: payload.key ?? key,
      summary: f.summary ?? "",
      issueTypeName: f.issuetype?.name ?? "",
      status: f.status?.name ?? "",
      labels: f.labels ?? [],
      description: f.description,
      comments,
      attachments,
      url: `${this.#baseUrl}/browse/${key}`,
    };
  }

  /**
   * One attachment's bytes, as text, or `null` if it is too large.
   *
   * `null` rather than a truncated string, because half an SVG is not a smaller
   * SVG — it is a broken one that a model would nonetheless try to use. A caller
   * that gets `null` can say "attachment too large to inline" and name the file,
   * which is a true statement; handing over the first 32KB would produce a
   * confidently wrong artifact instead.
   *
   * The size is checked twice, before and after the download. `content-length`
   * is absent on chunked responses, so a check that trusted it would be a cap
   * that any sufficiently large file could step around.
   */
  async fetchAttachmentText(id: string, maxBytes: number): Promise<string | null> {
    assertAttachmentId(id);
    const response = await this.#get(`/rest/api/3/attachment/content/${id}`, "*/*");

    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      logger.warn("jira.attachment_too_large", { id, declared, maxBytes });
      return null;
    }

    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      logger.warn("jira.attachment_too_large", { id, bytes: text.length, maxBytes });
      return null;
    }
    return text;
  }
}

interface RawComment {
  readonly id?: string | number;
  readonly author?: { readonly displayName?: string };
  readonly created?: string;
  readonly body?: unknown;
}

interface RawAttachment {
  readonly id?: string | number;
  readonly filename?: string;
  readonly mimeType?: string;
  readonly size?: number;
}

interface DetailPayload {
  readonly key?: string;
  readonly fields?: {
    readonly summary?: string;
    readonly issuetype?: { readonly name?: string };
    readonly status?: { readonly name?: string };
    readonly labels?: readonly string[];
    readonly description?: unknown;
    readonly comment?: { readonly comments?: readonly RawComment[] };
    readonly attachment?: readonly RawAttachment[];
  };
}
