/**
 * Minimal Jira Cloud client — discovery reads, and one narrow write.
 *
 * Four operations: a JQL search, one issue's full detail, one attachment's
 * bytes, and `updateLabels`.
 *
 * ## The rule this file used to state, and what replaced it
 *
 * It said: *"Nothing in this file writes to Jira, and nothing should be added
 * that does"* — the REST credential discovers work, the storecode MCP session
 * performs every mutation, so a credential living in a `.env` file cannot
 * change a ticket even if it leaks. That was true and it is now false in one
 * specific way, so it is rewritten here rather than left to rot into the exact
 * prose/behaviour divergence this project exists to catch.
 *
 * The amendment is `updateLabels`, and it exists because the MCP tool surface
 * cannot express the operation the solve claim needs. `editJiraIssue` takes
 * `fields` — **set** semantics — so adding one label means reading all N,
 * appending, and writing all N back. Any label a human added in between is
 * silently destroyed, and nothing in either party's history explains it. Jira's
 * REST API has supported `update.labels` with atomic `add`/`remove` operations
 * the whole time; the constraint was never Jira's, it was the tool's. So the
 * claim moves here, where the race can be *eliminated* rather than narrowed.
 *
 * Three things keep the amendment narrow, and all three are mechanical:
 *
 * 1. **Labels only.** This is a `labels`-shaped method, not a general issue
 *    edit. There is no way to spend this credential on a status transition, a
 *    field value or a comment.
 * 2. **The `agent:` namespace only.** `assertOwnedLabel` refuses anything else,
 *    so the write cannot touch `triaged`, `svc:*`, `dor:*` or a human's
 *    `next:*` even by accident. That is the same set `gate.ts` calls owned, for
 *    the same reason: these are the labels this service put there.
 * 3. **Comments stay on the MCP path.** Not an oversight — a Jira comment is
 *    ADF, and the MCP tool does the markdown→ADF conversion. Reimplementing
 *    that here to save one round trip would be trading a solved problem for an
 *    unsolved one, and comments have no clobber risk to fix.
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

/**
 * The only namespace this credential may write.
 *
 * Kept here rather than imported from `gate.ts` deliberately. `gate.ts` decides
 * what the *triage bot* may replace in a labels array it is rewriting whole;
 * this decides what a *credential* may touch at all, and the two would drift
 * apart the first time one of them widened for a reason that did not apply to
 * the other. A duplicated four-character string is a cheaper coupling than a
 * shared constant whose two readers mean different things by it.
 */
const WRITABLE_LABEL_PREFIX = "agent:";

/**
 * Jira accepts a label of almost anything without whitespace; this is stricter.
 *
 * The value reaches a JSON body rather than a URL, so this is not injection
 * defence — it is a check that the caller is passing a label and not, say, a
 * whole array stringified by accident. Bounded, because Jira's own limit is 255
 * and a value near it is a bug on this side.
 */
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

/** One changelog entry, flattened to the fields it touched. */
export interface JiraFieldChange {
  /** ISO-8601 with offset. */
  readonly created: string;
  /**
   * Jira's `items[].field` values, as returned and not normalised.
   *
   * Left raw because the capitalisation varies by field type and the consumer
   * folds case; normalising here would put the fold in the layer that cannot be
   * tested against a decision.
   */
  readonly fields: readonly string[];
}

/**
 * What a watched ticket has done since anyone last looked.
 *
 * Deliberately not `IssueDetail` with two more members. That type is what a
 * *solve* needs — description, attachments, issue type — and none of it is read
 * here, while the two things this needs are read nowhere else. Widening it
 * would make every solve pay for a changelog fetch to serve a loop that runs on
 * a cadence of days.
 */
export interface IssueActivity {
  readonly key: string;
  /** Jira's `status.statusCategory.key`: `new`, `indeterminate` or `done`. */
  readonly statusCategoryKey: string;
  /** Every label on the ticket, so a caller can tell a real removal from a no-op. */
  readonly labels: readonly string[];
  readonly comments: readonly JiraComment[];
  readonly changes: readonly JiraFieldChange[];
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

  /**
   * The one verb that changes anything, kept separate from `#post` on purpose.
   *
   * A reader auditing what this credential can do should be able to find every
   * write by grepping for one method name. Folding it into `#post` with a
   * `method` parameter would make that grep return the searches too.
   */
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
    // A successful issue edit is 204 with no body. Reading one would throw.
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
   * The activity on one watched ticket: has it closed, who has said what, and
   * which fields have moved.
   *
   * **This is the second amendment to the discovery-only rule**, authorised
   * 2026-09-06 after `updateLabels`. It is read-only, and it is narrower than
   * `fetchDetail`, which this credential already performs on every solve — the
   * new capability is the changelog, and nothing else. Recorded in
   * `ARCHITECTURE.md` §12 beside the first.
   *
   * **Both lists are paged to completion and a cap is an error, not a
   * truncation.** The obvious implementation is one request with
   * `expand=changelog` and `fields=comment`, which is cheaper and wrong in a way
   * that would never show up in a log: Jira decides how much of each list to
   * return, so the count of our own comments — which is the entire bound on how
   * much this ticket may cost (`MAX_RETRIAGE_PER_TICKET`) — would silently be a
   * count of *some* of them. Undercounting there hands back a free re-triage per
   * tick, which is the runaway `decideWatch` was written to prevent, arriving
   * one layer below it. So a list this method cannot read whole is a refusal:
   * visible, free, and fixable, where a quiet partial read is none of those.
   *
   * At `MAX_PAGES` × `MAX_RESULTS_PER_PAGE` the ceiling is 500 of each. A bug
   * ticket at that volume is a conversation rather than a signal, which is the
   * thing the bound exists to stop watching anyway.
   */
  async fetchActivity(key: string): Promise<IssueActivity> {
    assertIssueKey(key);

    // Labels ride along with the status because the caller that unsubscribes a
    // ticket has to know whether the label is on it. Asking Jira to remove one
    // that is not there is not an error — it is a write that changes nothing
    // and still bumps `updated`, which is the field the solve queue orders by.
    const statusResponse = await this.#get(
      `/rest/api/3/issue/${key}?fields=status,labels`,
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
      // Jira's three category keys are `new`, `indeterminate` and `done`. Only
      // the last is a terminal, and it is compared rather than the status
      // *name*, which is board-configurable and Norwegian on this one.
      statusCategoryKey: categoryKey,
      labels: statusPayload.fields?.labels ?? [],
      comments: comments.map((raw) => ({
        id: String(raw.id ?? ""),
        author: raw.author?.displayName ?? "unknown",
        created: raw.created ?? "",
        body: raw.body,
      })),
      changes: histories.map((raw) => ({
        created: raw.created ?? "",
        fields: (raw.items ?? []).map((item) => item.field ?? ""),
      })),
    };
  }

  /**
   * Reads one of Jira's `startAt`/`total` lists to the end, or refuses.
   *
   * Shared by both halves of `fetchActivity` because the failure they must not
   * have is the same one, and writing it twice is how the two would come to
   * disagree about it.
   */
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
   * Adds and removes labels atomically, touching nothing else on the issue.
   *
   * `update.labels` with per-label `add`/`remove` operations, which is Jira
   * applying a delta on the server rather than this process shipping a
   * replacement array. That is the whole point: the read-modify-write the MCP
   * tool forces has a window in which a human's edit is destroyed, and no
   * amount of reading back afterwards closes it — read-back can catch a racer
   * who wrote *after* us and structurally cannot catch one we overwrote. This
   * has no window to close, because there is no read.
   *
   * Both lists are validated before the request is built, so a rejected label
   * means nothing was sent at all. A partial application would be the worst
   * outcome available: half a claim leaves the ticket in a state no reader of
   * the state machine can name.
   *
   * Overlapping `add` and `remove` is refused rather than resolved. Jira would
   * apply them in order and produce an answer, but which answer depends on
   * argument order, and a caller that has asked for both has a bug that a
   * defined-but-arbitrary result would hide.
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
      // Not an error, and not a request either. Sending an empty `update` would
      // still bump the issue's `updated` timestamp, which the solve queue
      // orders by.
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
    readonly status?: {
      readonly name?: string;
      readonly statusCategory?: { readonly key?: string };
    };
    readonly labels?: readonly string[];
    readonly description?: unknown;
    readonly comment?: { readonly comments?: readonly RawComment[] };
    readonly attachment?: readonly RawAttachment[];
  };
}

interface RawHistory {
  readonly created?: string;
  readonly items?: readonly { readonly field?: string }[];
}

/**
 * The two shapes Jira uses for a paged list, in one type.
 *
 * `/issue/{key}/comment` names its array `comments` and `/issue/{key}/changelog`
 * names its `values`, which is why `#page` takes a reader rather than a key: the
 * pagination is identical and only the noun differs.
 */
interface PagePayload<T> {
  readonly total?: number;
  readonly comments?: readonly T[];
  readonly values?: readonly T[];
}
