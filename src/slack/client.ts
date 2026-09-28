/**
 * The Slack Web API over `fetch`, and the only module that holds the bot token.
 *
 * Slack reports failure as HTTP 200 with `ok: false`, so success is decided by that field and never
 * by the status alone. A dropped field arrives as a `warning` on a successful call instead, which is
 * why warnings are logged here and handed back rather than discarded.
 */

import { createLogger } from "../logger.ts";

const log = createLogger("slack");

const API_ROOT = "https://slack.com/api";

export interface SlackClientOptions {
  readonly token: string;
  readonly timeoutMs?: number;
}

/** A message's metadata, in the wire shape Slack both accepts and returns. */
export interface SlackMetadata {
  readonly event_type: string;
  readonly event_payload: Readonly<Record<string, unknown>>;
}

export interface SlackMessage {
  readonly ts: string;
  readonly text: string;
  /** Set on messages a bot posted; a person's message has none. */
  readonly botId: string | null;
  readonly metadata: SlackMetadata | null;
}

export interface SlackWriteResult {
  readonly ts: string;
  /** Slack's own warning codes, e.g. a metadata payload it accepted the call without. */
  readonly warnings: readonly string[];
}

export interface SlackHistoryPage {
  readonly messages: readonly SlackMessage[];
  readonly nextCursor: string | null;
}

export class SlackError extends Error {
  readonly method: string;
  /** Slack's `error` code, `http_<status>` for a non-JSON failure, or `network`. */
  readonly code: string;
  readonly retryAfterSeconds: number | null;

  constructor(
    method: string,
    code: string,
    detail: string,
    retryAfterSeconds: number | null = null,
  ) {
    super(`Slack ${method} failed: ${code}${detail === "" ? "" : ` — ${detail}`}`);
    this.name = "SlackError";
    this.method = method;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

type Params = Readonly<Record<string, string | number | boolean | object | undefined>>;

export class SlackClient {
  readonly #token: string;
  readonly #timeoutMs: number;

  constructor(options: SlackClientOptions) {
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async authTest(): Promise<{
    readonly userId: string;
    readonly botId: string | null;
    readonly team: string;
  }> {
    const body = await this.#call("auth.test", {});
    return {
      userId: str(body["user_id"]),
      botId: optionalStr(body["bot_id"]),
      team: str(body["team"]),
    };
  }

  async post(args: {
    readonly channel: string;
    readonly text: string;
    readonly blocks?: readonly object[];
    readonly metadata?: SlackMetadata;
  }): Promise<SlackWriteResult> {
    const body = await this.#call("chat.postMessage", {
      channel: args.channel,
      text: args.text,
      blocks: args.blocks,
      metadata: args.metadata,
      unfurl_links: false,
      unfurl_media: false,
    });
    return { ts: str(body["ts"]), warnings: warningsOf(body) };
  }

  /** `metadata` omitted keeps the message's existing metadata, which is Slack's rule rather than ours. */
  async update(args: {
    readonly channel: string;
    readonly ts: string;
    readonly text: string;
    readonly blocks?: readonly object[];
    readonly metadata?: SlackMetadata;
  }): Promise<SlackWriteResult> {
    const body = await this.#call("chat.update", {
      channel: args.channel,
      ts: args.ts,
      text: args.text,
      blocks: args.blocks,
      metadata: args.metadata,
    });
    return { ts: str(body["ts"]), warnings: warningsOf(body) };
  }

  async deleteMessage(args: { readonly channel: string; readonly ts: string }): Promise<void> {
    await this.#call("chat.delete", { channel: args.channel, ts: args.ts });
  }

  /** Newest first, as Slack returns it. `latest` and `oldest` are message timestamps. */
  async history(args: {
    readonly channel: string;
    readonly latest?: string;
    readonly oldest?: string;
    readonly inclusive?: boolean;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<SlackHistoryPage> {
    const body = await this.#call("conversations.history", {
      channel: args.channel,
      latest: args.latest,
      oldest: args.oldest,
      inclusive: args.inclusive,
      limit: args.limit,
      cursor: args.cursor,
      include_all_metadata: true,
    });
    const raw = Array.isArray(body["messages"]) ? (body["messages"] as unknown[]) : [];
    const meta = record(body["response_metadata"]);
    const next = optionalStr(meta["next_cursor"]);
    return { messages: raw.map(toMessage), nextCursor: next === "" ? null : next };
  }

  /**
   * Form-encoded for every method, objects as JSON strings: Slack accepts that shape on reads and
   * writes alike, where a JSON body is accepted on writes only.
   */
  async #call(method: string, params: Params): Promise<Readonly<Record<string, unknown>>> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) {
        continue;
      }
      form.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }

    let response: Response;
    try {
      response = await fetch(`${API_ROOT}/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#token}`,
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new SlackError(method, "network", (error as Error).message);
    }

    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      throw new SlackError(
        method,
        "ratelimited",
        "Slack asked for a pause before the next call",
        Number.isFinite(seconds) ? seconds : null,
      );
    }

    let body: Record<string, unknown>;
    try {
      body = record(await response.json());
    } catch {
      throw new SlackError(method, `http_${String(response.status)}`, "the response was not JSON");
    }

    if (body["ok"] !== true) {
      throw new SlackError(
        method,
        optionalStr(body["error"]) ?? "unknown_error",
        scopeDetail(body),
      );
    }

    const warnings = warningsOf(body);
    if (warnings.length > 0) {
      log.warn("slack.api_warning", { method, warnings });
    }
    return body;
  }
}

/** `missing_scope` names the scope it wanted; without it the first failure cannot say what to grant. */
function scopeDetail(body: Readonly<Record<string, unknown>>): string {
  const needed = optionalStr(body["needed"]);
  const provided = optionalStr(body["provided"]);
  if (needed === null) {
    return "";
  }
  return `needs scope ${needed}; the token has ${provided ?? "none reported"}`;
}

function warningsOf(body: Readonly<Record<string, unknown>>): readonly string[] {
  const found = new Set<string>();
  const top = optionalStr(body["warning"]);
  if (top !== null) {
    for (const code of top.split(",")) {
      if (code.trim() !== "") {
        found.add(code.trim());
      }
    }
  }
  const listed = record(body["response_metadata"])["warnings"];
  if (Array.isArray(listed)) {
    for (const code of listed) {
      if (typeof code === "string" && code !== "") {
        found.add(code);
      }
    }
  }
  return [...found];
}

function toMessage(raw: unknown): SlackMessage {
  const message = record(raw);
  const meta = record(message["metadata"]);
  const eventType = optionalStr(meta["event_type"]);
  return {
    ts: str(message["ts"]),
    text: str(message["text"]),
    botId: optionalStr(message["bot_id"]),
    metadata:
      eventType === null
        ? null
        : { event_type: eventType, event_payload: record(meta["event_payload"]) },
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
