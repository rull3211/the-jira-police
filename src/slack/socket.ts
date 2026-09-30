/**
 * A Socket Mode connection held until shutdown, each slash command answered in its envelope's
 * acknowledgement and each mention of the bot handed on after its own. The daemon has no public
 * URL, so this is the only way Slack can reach it.
 */

import { createLogger } from "../logger.ts";
import type { SlashCommand } from "./roster.ts";
import type { Mention } from "./start.ts";

const log = createLogger("slack");

/** Inside Slack's three seconds for a slash command, with room for the acknowledgement to travel. */
export const ACK_BUDGET_MS = 2500;
export const LATE_REPLY =
  "Still working on it; `/bencebot` in a moment says whether it went through.";
const BACKOFF_CAP_MS = 60_000;

export interface SocketHandlers {
  message(data: string): void;
  closed(): void;
}

export interface SocketHandle {
  send(data: string): void;
  close(): void;
}

export interface ListenDeps {
  /** `apps.connections.open`, called once per connection. */
  readonly open: () => Promise<string>;
  readonly connect: (url: string, on: SocketHandlers) => SocketHandle;
  readonly handle: (command: SlashCommand) => Promise<string>;
  /** A mention's envelope takes no reply payload, so whatever this says, it says out of band. */
  readonly mention: (mention: Mention) => Promise<void>;
  readonly signal: AbortSignal;
  readonly pause?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly ackBudgetMs?: number;
}

export interface ListenSummary {
  readonly connections: number;
  readonly commands: number;
  readonly mentions: number;
}

export type Frame =
  | { readonly kind: "hello"; readonly seconds: number | null }
  | { readonly kind: "disconnect"; readonly reason: string }
  | {
      readonly kind: "command";
      readonly envelope: string;
      readonly respond: boolean;
      readonly command: SlashCommand;
    }
  | { readonly kind: "mention"; readonly envelope: string; readonly mention: Mention }
  | { readonly kind: "other"; readonly envelope: string; readonly type: string }
  | { readonly kind: "unreadable" };

/** The person is whoever Slack names — a command's `user_id`, a mention's `user` — and the text only picks the verb. */
export function parseFrame(data: string): Frame {
  let frame: Record<string, unknown>;
  try {
    frame = record(JSON.parse(data));
  } catch {
    return { kind: "unreadable" };
  }
  const type = typeof frame["type"] === "string" ? frame["type"] : "";
  if (type === "hello") {
    const seconds = record(frame["debug_info"])["approximate_connection_time"];
    return { kind: "hello", seconds: typeof seconds === "number" ? seconds : null };
  }
  if (type === "disconnect") {
    return { kind: "disconnect", reason: String(frame["reason"] ?? "unknown") };
  }
  const envelope = frame["envelope_id"];
  if (typeof envelope !== "string" || envelope === "") {
    return { kind: "unreadable" };
  }
  const payload = record(frame["payload"]);
  if (type === "events_api") {
    const event = record(payload["event"]);
    if (event["type"] !== "app_mention") {
      return { kind: "other", envelope, type: `events_api/${String(event["type"] ?? "none")}` };
    }
    const threadTs = event["thread_ts"];
    return {
      kind: "mention",
      envelope,
      mention: {
        userId: stringOf(event["user"]),
        text: stringOf(event["text"]),
        channel: stringOf(event["channel"]),
        ts: stringOf(event["ts"]),
        threadTs: typeof threadTs === "string" && threadTs !== "" ? threadTs : null,
      },
    };
  }
  if (type !== "slash_commands") {
    return { kind: "other", envelope, type };
  }
  return {
    kind: "command",
    envelope,
    respond: frame["accepts_response_payload"] === true,
    command: {
      userId: typeof payload["user_id"] === "string" ? payload["user_id"] : "",
      text: typeof payload["text"] === "string" ? payload["text"] : "",
    },
  };
}

type SessionEnd = "refresh" | "dropped" | "stopped";

export async function listen(deps: ListenDeps): Promise<ListenSummary> {
  const pause = deps.pause ?? abortablePause;
  const budget = deps.ackBudgetMs ?? ACK_BUDGET_MS;
  let connections = 0;
  let commands = 0;
  let mentions = 0;
  let failures = 0;

  // One at a time, so two commands never interleave a read and its write in this process.
  let chain: Promise<unknown> = Promise.resolve();
  const answer = async (command: SlashCommand): Promise<string> => {
    commands += 1;
    const started = Date.now();
    const handled = chain.then(() => deps.handle(command));
    chain = handled.catch(() => undefined);
    void chain.then(() => {
      const ms = Date.now() - started;
      if (ms > budget) {
        log.warn("slack.command_late", {
          ms,
          budgetMs: budget,
          note: "acknowledged with the still-working reply; the command itself ran to the end",
        });
      }
    });
    return withinBudget(handled, budget);
  };
  const hear = (mention: Mention): void => {
    mentions += 1;
    chain = chain.then(() => deps.mention(mention)).catch(() => undefined);
  };

  while (!deps.signal.aborted) {
    let url: string;
    try {
      url = await deps.open();
    } catch (error) {
      failures += 1;
      const wait = backoff(failures, retryAfterMs(error));
      log.warn("slack.listen_open_failed", { reason: reasonOf(error), retryInMs: wait });
      await pause(wait, deps.signal);
      continue;
    }
    connections += 1;
    const { end, greeted } = await session(url, deps, answer, hear);
    if (end === "stopped") {
      break;
    }
    failures = greeted ? 0 : failures + 1;
    if (end === "dropped") {
      const wait = greeted ? 1000 : backoff(failures, null);
      log.warn("slack.listen_dropped", { greeted, retryInMs: wait });
      await pause(wait, deps.signal);
    }
  }
  // A write already begun is finished rather than cut off; a command's reply is lost with the socket.
  await chain;
  return { connections, commands, mentions };
}

function session(
  url: string,
  deps: ListenDeps,
  answer: (command: SlashCommand) => Promise<string>,
  hear: (mention: Mention) => void,
): Promise<{ readonly end: SessionEnd; readonly greeted: boolean }> {
  return new Promise((resolve) => {
    let greeted = false;
    let settled = false;
    let handle: SocketHandle | null = null;
    const finish = (end: SessionEnd): void => {
      if (settled) {
        return;
      }
      settled = true;
      deps.signal.removeEventListener("abort", stop);
      resolve({ end, greeted });
    };
    const stop = (): void => {
      handle?.close();
      finish("stopped");
    };
    const send = (value: object): void => {
      try {
        handle?.send(JSON.stringify(value));
      } catch (error) {
        log.warn("slack.listen_ack_failed", { reason: reasonOf(error) });
      }
    };

    const onMessage = (data: string): void => {
      const frame = parseFrame(data);
      if (frame.kind === "hello") {
        greeted = true;
        log.info("slack.listen_connected", { approximateSeconds: frame.seconds });
      } else if (frame.kind === "disconnect") {
        log.info("slack.listen_disconnect", { reason: frame.reason });
        handle?.close();
        finish("refresh");
      } else if (frame.kind === "command") {
        void answer(frame.command).then((text) => {
          if (!frame.respond) {
            log.warn("slack.listen_reply_dropped", { note: "the envelope takes no reply payload" });
          }
          send(
            frame.respond
              ? { envelope_id: frame.envelope, payload: { response_type: "ephemeral", text } }
              : { envelope_id: frame.envelope },
          );
        });
      } else if (frame.kind === "mention") {
        // Acknowledged before the work, since Slack resends an envelope it has not heard back on.
        send({ envelope_id: frame.envelope });
        hear(frame.mention);
      } else if (frame.kind === "other") {
        send({ envelope_id: frame.envelope });
        log.info("slack.listen_ignored", { type: frame.type });
      } else {
        log.warn("slack.listen_unreadable_frame", { chars: data.length });
      }
    };

    try {
      handle = deps.connect(url, {
        message: onMessage,
        closed: () => {
          finish("dropped");
        },
      });
    } catch (error) {
      log.warn("slack.listen_connect_failed", { reason: reasonOf(error) });
      finish("dropped");
      return;
    }
    deps.signal.addEventListener("abort", stop, { once: true });
    if (deps.signal.aborted) {
      stop();
    }
  });
}

/** Node 24's own `WebSocket`; the one piece a unit test cannot reach, driven by `slack:listen`. */
export function openWebSocket(url: string, on: SocketHandlers): SocketHandle {
  const socket = new WebSocket(url);
  socket.addEventListener("message", (event) => {
    on.message(typeof event.data === "string" ? event.data : "");
  });
  socket.addEventListener("error", () => {
    log.warn("slack.listen_socket_error", { note: "a close follows" });
  });
  socket.addEventListener("close", () => {
    on.closed();
  });
  return {
    send: (data) => {
      socket.send(data);
    },
    close: () => {
      socket.close();
    },
  };
}

async function withinBudget(work: Promise<string>, ms: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      resolve(LATE_REPLY);
    }, ms);
  });
  try {
    return await Promise.race([
      work.catch((error: unknown) => `That did not go through: ${reasonOf(error)}`),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function backoff(failures: number, floorMs: number | null): number {
  const exponential = Math.min(1000 * 2 ** Math.max(0, failures - 1), BACKOFF_CAP_MS);
  return Math.max(exponential, floorMs ?? 0);
}

function retryAfterMs(error: unknown): number | null {
  const seconds = (error as { readonly retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
  return typeof seconds === "number" ? seconds * 1000 : null;
}

function abortablePause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
