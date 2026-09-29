/**
 * The Slack Web API over `fetch`, and the only module that holds a Slack token, bot or app-level.
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

export interface SlackWriteResult {
  readonly ts: string;
  /** Slack's own warning codes, such as a field it accepted the call without. */
  readonly warnings: readonly string[];
}

export interface SlackPostResult extends SlackWriteResult {
  /** The conversation it landed in: for a post to a user's ID, their direct message with the bot. */
  readonly channel: string;
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

  /** `threadTs` makes it a reply; `broadcast` also shows that reply at the bottom of the channel. */
  async post(args: {
    readonly channel: string;
    readonly text: string;
    readonly blocks?: readonly object[];
    readonly threadTs?: string;
    readonly broadcast?: boolean;
  }): Promise<SlackPostResult> {
    const body = await this.#call("chat.postMessage", {
      channel: args.channel,
      text: args.text,
      blocks: args.blocks,
      thread_ts: args.threadTs,
      reply_broadcast: args.threadTs === undefined ? undefined : args.broadcast,
      unfurl_links: false,
      unfurl_media: false,
    });
    return { ts: str(body["ts"]), channel: str(body["channel"]), warnings: warningsOf(body) };
  }

  async update(args: {
    readonly channel: string;
    readonly ts: string;
    readonly text: string;
    readonly blocks?: readonly object[];
  }): Promise<SlackWriteResult> {
    const body = await this.#call("chat.update", {
      channel: args.channel,
      ts: args.ts,
      text: args.text,
      blocks: args.blocks,
    });
    return { ts: str(body["ts"]), warnings: warningsOf(body) };
  }

  async deleteMessage(args: { readonly channel: string; readonly ts: string }): Promise<void> {
    await this.#call("chat.delete", { channel: args.channel, ts: args.ts });
  }

  /** Only an app-level `xapp-` token may call it, and Slack generates the URL per call, so one per connect. */
  async openConnection(): Promise<string> {
    const body = await this.#call("apps.connections.open", {});
    const url = str(body["url"]);
    if (!url.startsWith("wss://")) {
      throw new SlackError("apps.connections.open", "no_url", "the answer held no wss:// URL");
    }
    return url;
  }

  /** Form-encoded, objects as JSON strings: the one body shape every Slack method accepts. */
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
          // No charset: Slack answers one on a form body with `superfluous_charset`, measured.
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new SlackError(method, "network", (error as Error).message);
    }

    if (response.status === 429) {
      const header = response.headers.get("retry-after");
      const seconds = header === null ? Number.NaN : Number(header);
      const known = Number.isFinite(seconds);
      throw new SlackError(
        method,
        "ratelimited",
        `Slack asked for a pause${known ? ` of ${String(seconds)}s` : ""} before the next call`,
        known ? seconds : null,
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
