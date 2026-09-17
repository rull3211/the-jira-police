/**
 * Minimal Jira Cloud client — discovery reads, and one narrow write (`updateLabels`).
 *
 * `updateLabels` exists because the MCP tool surface only offers `fields` (set semantics), so
 * adding one label means read-all-N/append/write-all-N-back — destroying any label a human added
 * in between. This credential may touch only `agent:`-namespaced labels (`assertOwnedLabel`), never
 * a status, field or comment; comments stay on the MCP path since ADF conversion lives there.
 *
 * `search` uses `/rest/api/3/search/jql`, paginated by opaque `nextPageToken` with no total count
 * or numeric offset, and asks a narrow `FIELDS` list since it runs on a timer over every ticket;
 * `description`/`comment`/`attachment` are fetched only in `fetchDetail`, for the one ticket a solve
 * acts on.
 */

import { logger } from "../logger.ts";
import { type JiraIssue, type JiraSearchResponse, type TicketRef, toTicketRef } from "./types.ts";

/**
 * Issue keys and attachment ids are interpolated into a URL path, so they are validated rather than
 * trusted — a key like `../../../rest/api/3/myself` would otherwise redirect the request entirely.
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

/** The only namespace this credential may write; kept separate from `gate.ts`, which governs a different concern (what the triage bot may replace). */
const WRITABLE_LABEL_PREFIX = "agent:";

/** Jira accepts a label of almost anything without whitespace; this is stricter, to catch a caller bug rather than injection. */
const LABEL_PATTERN = /^agent:[a-z][a-z0-9-]{0,60}$/;

export function assertOwnedLabel(label: string): void {
  if (!label.startsWith(WRITABLE_LABEL_PREFIX)) {
    throw new JiraError(
      0,
      `Refusing to write ${JSON.stringify(label)}: this credential may only touch ${WRITABLE_LABEL_PREFIX}* labels, and everything else on the ticket belongs to somebody else`,
    );
  }
  if (!LABEL_PATTERN.test(label)) {
    throw new JiraError(0, `Refusing to write a malformed label: ${JSON.stringify(label)}`);
  }
}

/** Only the fields the pipeline actually reads. */
const FIELDS = [
  "summary",
  "issuetype",
  "created",
  // Requested for the solve queue, which orders by it; cheaper to pay a few unused bytes than keep two field lists in step.
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
  /**
   * ISO-8601 with offset; equal to `created` on a comment nobody has edited. The triage poster
   * updates its own comment in place, so `created` alone would look pinned at the first triage
   * forever — see `lastSpokeAt`.
   */
  readonly updated: string;
  /** ADF. Attacker-controlled; rendered as data, never interpreted. */
  readonly body: unknown;
}

export interface JiraAttachment {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
}

/** Everything a solve needs to know about one ticket; `description` and `body` stay `unknown` since their ADF shape is Atlassian's to change. */
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

/** One changelog entry, flattened to the fields it touched. */
export interface JiraFieldChange {
  /** ISO-8601 with offset. */
  readonly created: string;
  /** Jira's `items[].field` values, as returned; left raw because capitalisation varies and the consumer folds case. */
  readonly fields: readonly string[];
}

/** What the blocker-clearing fields say *now*; the changelog names which fields moved, this says what they hold. */
export interface IssueContent {
  readonly summary: string;
  /** ADF; `unknown` for the same reason `body` is — Atlassian's shape to change, and `renderAdf`'s to know. */
  readonly description: unknown;
  readonly environment: unknown;
  /** Names, types and sizes — never bytes; a filename answers "attach the HAR" without opening an untrusted-bytes path into a prompt. */
  readonly attachments: readonly JiraAttachment[];
}

/** What a watched ticket has done since anyone last looked; deliberately narrower than `IssueDetail`, which serves a solve instead. */
export interface IssueActivity {
  readonly key: string;
  /** Jira's `status.statusCategory.key`: `new`, `indeterminate` or `done`. */
  readonly statusCategoryKey: string;
  /** Every label on the ticket, so a caller can tell a real removal from a no-op. */
  readonly labels: readonly string[];
  readonly comments: readonly JiraComment[];
  readonly changes: readonly JiraFieldChange[];
  readonly content: IssueContent;
}

/** Attachment media types worth inlining into a prompt as text; SVG is the case that motivated this — an image by MIME type, text by content. */
const INLINEABLE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/svg+xml",
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
]);

export function isInlineable(mimeType: string): boolean {
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
      throw new JiraError(0, `Request to ${path} failed: ${(error as Error).message}`);
    }

    if (response.ok) {
      return await response.json();
    }

    return await this.#raise(response);
  }

  /** Turns a non-OK response into the most specific error available; never reads request headers, since the credential lives there. */
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

  /** The one verb that changes anything, kept separate from `#post` so every write can be found by grepping one method name. */
  async #put(path: string, body: unknown): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        method: "PUT",
        headers: {
          Authorization: this.#authHeader,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new JiraError(0, `Request to ${path} failed: ${(error as Error).message}`);
    }

    if (!response.ok) {
      await this.#raise(response);
    }
    // A successful issue edit is 204 with no body; reading one would throw.
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

  /** Everything one ticket says, for the one ticket a solve is about to act on; asks for `comment` and `attachment` explicitly, unlike `search`'s `FIELDS`. */
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
      // Not defaulted to `created`: an absent `updated` must surface as such, not as a plausible timestamp.
      updated: raw.updated ?? "",
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
   * The activity on one watched ticket: has it closed, who has said what, and which fields have
   * moved — a read-only amendment to the discovery-only rule, narrower than `fetchDetail`, recorded
   * in `ARCHITECTURE.md` §12 beside `updateLabels`.
   *
   * Both lists (`comment`, `changelog`) are paged to completion and a cap is a refusal, not a
   * truncation: `expand=changelog`/`fields=comment` in one request would let Jira silently cap the
   * page, and undercounting a `MAX_RETRIAGE_PER_TICKET` bound is worse than an explicit failure.
   */
  async fetchActivity(key: string): Promise<IssueActivity> {
    assertIssueKey(key);

    // Labels ride along because a caller unsubscribing a ticket must know whether the label is on it.
    // The content fields ride along too: fetching them separately from the changelog is what once
    // left the relevance check judging a field name instead of its value.
    const statusResponse = await this.#get(
      `/rest/api/3/issue/${key}?fields=status,labels,summary,description,environment,attachment`,
      "application/json",
    );
    const statusPayload = (await statusResponse.json()) as DetailPayload;
    const categoryKey = statusPayload.fields?.status?.statusCategory?.key ?? "";

    const comments = await this.#page<RawComment>(
      key,
      (startAt) =>
        `/rest/api/3/issue/${key}/comment?startAt=${startAt}&maxResults=${MAX_RESULTS_PER_PAGE}`,
      (payload) => payload.comments,
      "comments",
    );

    const histories = await this.#page<RawHistory>(
      key,
      (startAt) =>
        `/rest/api/3/issue/${key}/changelog?startAt=${startAt}&maxResults=${MAX_RESULTS_PER_PAGE}`,
      (payload) => payload.values,
      "changelog",
    );

    logger.debug("jira.activity_fetched", {
      key,
      statusCategory: categoryKey,
      comments: comments.length,
      changes: histories.length,
    });

    return {
      key: statusPayload.key ?? key,
      // Compared as the category key (`new`/`indeterminate`/`done`), never the status name, which is board-configurable and Norwegian here.
      statusCategoryKey: categoryKey,
      labels: statusPayload.fields?.labels ?? [],
      comments: comments.map((raw) => ({
        id: String(raw.id ?? ""),
        author: raw.author?.displayName ?? "unknown",
        created: raw.created ?? "",
        updated: raw.updated ?? "",
        body: raw.body,
      })),
      changes: histories.map((raw) => ({
        created: raw.created ?? "",
        fields: (raw.items ?? []).map((item) => item.field ?? ""),
      })),
      content: {
        summary: statusPayload.fields?.summary ?? "",
        description: statusPayload.fields?.description,
        environment: statusPayload.fields?.environment,
        attachments: (statusPayload.fields?.attachment ?? []).map((raw) => ({
          id: String(raw.id ?? ""),
          filename: raw.filename ?? "",
          mimeType: raw.mimeType ?? "",
          size: raw.size ?? 0,
        })),
      },
    };
  }

  /** Reads one of Jira's `startAt`/`total` lists to the end, or refuses; shared so both halves of `fetchActivity` fail the same way. */
  async #page<T>(
    key: string,
    path: (startAt: number) => string,
    read: (payload: PagePayload<T>) => readonly T[] | undefined,
    what: string,
  ): Promise<readonly T[]> {
    const collected: T[] = [];
    let total = 0;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.#get(path(collected.length), "application/json");
      const payload = (await response.json()) as PagePayload<T>;
      const batch = read(payload) ?? [];
      total = payload.total ?? collected.length + batch.length;
      collected.push(...batch);

      if (collected.length >= total || batch.length === 0) {
        return collected;
      }
    }

    throw new JiraError(
      0,
      `${key} has more than ${MAX_PAGES * MAX_RESULTS_PER_PAGE} ${what} (${total}); refusing a partial read, because a count of some of them reads as a count of all of them`,
    );
  }

  /**
   * Adds and removes labels atomically via `update.labels`, so Jira applies the delta server-side
   * rather than this process reading, modifying and writing back a full array — closing the window
   * in which a human's concurrent edit gets clobbered. Both lists are validated before the request is
   * built, so a rejected label sends nothing at all, and overlapping `add`/`remove` is refused rather
   * than resolved, since the result would depend on argument order.
   */
  async updateLabels(
    key: string,
    change: { readonly add?: readonly string[]; readonly remove?: readonly string[] },
  ): Promise<void> {
    assertIssueKey(key);
    const add = change.add ?? [];
    const remove = change.remove ?? [];

    for (const label of [...add, ...remove]) {
      assertOwnedLabel(label);
    }
    const both = add.filter((label) => remove.includes(label));
    if (both.length > 0) {
      throw new JiraError(0, `Asked to both add and remove ${both.join(", ")} on ${key}`);
    }
    if (add.length === 0 && remove.length === 0) {
      // Not an error, and not a request either: an empty `update` would still bump `updated`.
      return;
    }

    await this.#put(`/rest/api/3/issue/${key}`, {
      update: {
        labels: [
          ...add.map((label) => ({ add: label })),
          ...remove.map((label) => ({ remove: label })),
        ],
      },
    });
    logger.info("jira.labels_updated", { key, add, remove });
  }

  /** One attachment decoded as text, or `null` if too large; `null` rather than a truncated string, since half an SVG is a broken one. */
  async fetchAttachmentText(id: string, maxBytes: number): Promise<string | null> {
    const bytes = await this.fetchAttachmentBytes(id, maxBytes);
    return bytes === null ? null : bytes.toString("utf8");
  }

  /**
   * The same download, undecoded, for callers whose attachment is not text (e.g. images written to
   * disk by `attachments/stage.ts`). Size is checked twice, before and after download, since
   * `content-length` is absent on chunked responses and a cap trusting it alone could be stepped
   * around.
   */
  async fetchAttachmentBytes(id: string, maxBytes: number): Promise<Buffer | null> {
    assertAttachmentId(id);
    const response = await this.#get(`/rest/api/3/attachment/content/${id}`, "*/*");

    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      logger.warn("jira.attachment_too_large", { id, declared, maxBytes });
      return null;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      logger.warn("jira.attachment_too_large", { id, bytes: bytes.byteLength, maxBytes });
      return null;
    }
    return bytes;
  }
}

interface RawComment {
  readonly id?: string | number;
  readonly author?: { readonly displayName?: string };
  readonly created?: string;
  readonly updated?: string;
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
    readonly status?: {
      readonly name?: string;
      readonly statusCategory?: { readonly key?: string };
    };
    readonly labels?: readonly string[];
    readonly description?: unknown;
    readonly environment?: unknown;
    readonly comment?: { readonly comments?: readonly RawComment[] };
    readonly attachment?: readonly RawAttachment[];
  };
}

interface RawHistory {
  readonly created?: string;
  readonly items?: readonly { readonly field?: string }[];
}

/** The two shapes Jira uses for a paged list: `comment` names its array `comments`, `changelog` names it `values`. */
interface PagePayload<T> {
  readonly total?: number;
  readonly comments?: readonly T[];
  readonly values?: readonly T[];
}
