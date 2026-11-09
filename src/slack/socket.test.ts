import { describe, expect, it, vi } from "vitest";

import { SlackError } from "./client.ts";
import type { SlashCommand } from "./roster.ts";
import type { Mention } from "./start.ts";
import {
  type Click,
  LATE_REPLY,
  type ListenDeps,
  type SocketHandlers,
  listen,
  parseFrame,
} from "./socket.ts";

interface FakeSocket {
  readonly url: string;
  readonly on: SocketHandlers;
  readonly sent: string[];
  closed: boolean;
}

/** `opens` is what each `apps.connections.open` returns in turn; running out stops the listener. */
function harness(
  handle: (command: SlashCommand) => Promise<string>,
  opens: (string | Error)[],
  mention: (mention: Mention) => Promise<void> = async () => undefined,
  click: (click: Click) => Promise<void> = async () => undefined,
): {
  readonly deps: ListenDeps;
  readonly sockets: FakeSocket[];
  readonly pauses: number[];
  readonly stop: () => void;
} {
  const controller = new AbortController();
  const sockets: FakeSocket[] = [];
  const pauses: number[] = [];
  return {
    sockets,
    pauses,
    stop: () => {
      controller.abort();
    },
    deps: {
      open: async () => {
        const next = opens.shift();
        if (next === undefined) {
          controller.abort();
          return "wss://after-stop";
        }
        if (next instanceof Error) {
          throw next;
        }
        return next;
      },
      connect: (url, on) => {
        const socket: FakeSocket = { url, on, sent: [], closed: false };
        sockets.push(socket);
        return {
          send: (data) => socket.sent.push(data),
          close: () => {
            socket.closed = true;
          },
        };
      },
      handle,
      mention,
      click,
      signal: controller.signal,
      pause: async (ms) => {
        pauses.push(ms);
      },
      ackBudgetMs: 50,
    },
  };
}

/** Every log line written while `run` runs; `vitest.config.ts` silences the logger otherwise. */
async function logged(run: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  const lines: string[] = [];
  const keep = (chunk: unknown): boolean => {
    lines.push(String(chunk));
    return true;
  };
  const level = process.env["LOG_LEVEL"];
  process.env["LOG_LEVEL"] = "info";
  vi.spyOn(process.stdout, "write").mockImplementation(keep);
  vi.spyOn(process.stderr, "write").mockImplementation(keep);
  try {
    await run();
  } finally {
    vi.restoreAllMocks();
    if (level === undefined) {
      delete process.env["LOG_LEVEL"];
    } else {
      process.env["LOG_LEVEL"] = level;
    }
  }
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const HELLO = JSON.stringify({ type: "hello", debug_info: { approximate_connection_time: 3600 } });

function command(envelope: string, text: string, userId = "U0ME"): string {
  return JSON.stringify({
    envelope_id: envelope,
    type: "slash_commands",
    accepts_response_payload: true,
    payload: { user_id: userId, text, command: "/bencebot", response_url: "https://hooks.test/x" },
  });
}

function mentioned(envelope: string, event: Record<string, unknown>): string {
  return JSON.stringify({
    envelope_id: envelope,
    type: "events_api",
    accepts_response_payload: false,
    payload: { type: "event_callback", event: { type: "app_mention", ...event } },
  });
}

const IN_THREAD = {
  user: "U0ME",
  text: "<@U0BOT> start",
  channel: "C0CHAN",
  ts: "1790779745.218229",
  thread_ts: "1790779480.401999",
};

/** The shape Slack documents for a button pressed in a message, as a Socket Mode `interactive` envelope. */
function pressed(envelope: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    envelope_id: envelope,
    type: "interactive",
    accepts_response_payload: false,
    payload: {
      type: "block_actions",
      user: { id: "U0ME", name: "someone" },
      container: { type: "message", message_ts: "1790779999.000100", channel_id: "D0DIRECT" },
      channel: { id: "D0DIRECT" },
      message: { ts: "1790779999.000100", text: "Draft ticket" },
      trigger_id: "t-1",
      actions: [
        {
          action_id: "draft_post",
          block_id: "b-1",
          type: "button",
          value: "d-0123456789abcdef01234567",
          action_ts: "1790780000.000200",
        },
      ],
      ...overrides,
    },
  });
}

async function socketAt(sockets: FakeSocket[], index: number): Promise<FakeSocket> {
  await vi.waitFor(() => {
    expect(sockets.length).toBeGreaterThan(index);
  });
  const socket = sockets[index];
  if (socket === undefined) {
    throw new Error("unreachable");
  }
  return socket;
}

describe("listen", () => {
  it("answers a slash command in the acknowledgement of its own envelope", async () => {
    const h = harness(async (c) => `saw ${c.userId} ${c.text}`, ["wss://one"]);
    const running = listen(h.deps);
    const socket = await socketAt(h.sockets, 0);

    socket.on.message(HELLO);
    socket.on.message(command("e-1", "subscribe"));
    await vi.waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    expect(JSON.parse(socket.sent[0] ?? "")).toEqual({
      envelope_id: "e-1",
      payload: { response_type: "ephemeral", text: "saw U0ME subscribe" },
    });
    h.stop();
    expect(await running).toEqual({ connections: 1, commands: 1, mentions: 0, clicks: 0 });
    expect(socket.closed).toBe(true);
  });

  it("opens a fresh connection at once when Slack announces a disconnect", async () => {
    const h = harness(async () => "", ["wss://one", "wss://two"]);
    const running = listen(h.deps);
    const first = await socketAt(h.sockets, 0);

    first.on.message(HELLO);
    first.on.message(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }));
    const second = await socketAt(h.sockets, 1);

    expect(first.closed).toBe(true);
    expect(second.url).toBe("wss://two");
    expect(h.pauses).toEqual([]);
    h.stop();
    await running;
  });

  it("acknowledges inside the budget when the work takes longer, and still finishes the work", async () => {
    let finish: (() => void) | undefined;
    const handle = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = () => {
            resolve("done");
          };
        }),
    );
    const h = harness(handle, ["wss://one"]);
    const running = listen(h.deps);
    const socket = await socketAt(h.sockets, 0);

    socket.on.message(command("e-1", "subscribe"));
    await vi.waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    expect(JSON.parse(socket.sent[0] ?? "")).toMatchObject({ payload: { text: LATE_REPLY } });
    h.stop();
    let returned = false;
    void running.then(() => {
      returned = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(returned).toBe(false);
    finish?.();
    await running;
  });

  it("warns when a command outlived the budget, saying how long it took, and is quiet when it did not", async () => {
    const run = async (delayMs: number): Promise<Record<string, unknown>[]> =>
      logged(async () => {
        const h = harness(
          () =>
            new Promise((resolve) => {
              setTimeout(() => {
                resolve("done");
              }, delayMs);
            }),
          ["wss://one"],
        );
        const running = listen(h.deps);
        const socket = await socketAt(h.sockets, 0);
        socket.on.message(command("e-1", "subscribe"));
        await vi.waitFor(() => {
          expect(socket.sent).toHaveLength(1);
        });
        h.stop();
        await running;
      });

    const late = (await run(80)).find((line) => line["message"] === "slack.command_late");
    const quick = (await run(0)).find((line) => line["message"] === "slack.command_late");

    expect(late).toMatchObject({ budgetMs: 50 });
    expect(late?.["ms"]).toBeGreaterThanOrEqual(80);
    expect(quick).toBeUndefined();
  });

  it("runs one command at a time, so two never interleave a read and a write", async () => {
    const order: string[] = [];
    const release: (() => void)[] = [];
    const handle = async (c: SlashCommand): Promise<string> => {
      order.push(`start ${c.text}`);
      await new Promise<void>((resolve) => release.push(resolve));
      order.push(`end ${c.text}`);
      return c.text;
    };
    const h = { ...harness(handle, ["wss://one"]) };
    const deps = { ...h.deps, ackBudgetMs: 5000 };
    const running = listen(deps);
    const socket = await socketAt(h.sockets, 0);

    socket.on.message(command("e-1", "subscribe"));
    socket.on.message(command("e-2", "unsubscribe"));
    await vi.waitFor(() => {
      expect(release).toHaveLength(1);
    });
    release[0]?.();
    await vi.waitFor(() => {
      expect(release).toHaveLength(2);
    });
    release[1]?.();
    await vi.waitFor(() => {
      expect(socket.sent).toHaveLength(2);
    });

    expect(order).toEqual([
      "start subscribe",
      "end subscribe",
      "start unsubscribe",
      "end unsubscribe",
    ]);
    h.stop();
    await running;
  });

  it("acknowledges an envelope it does not handle, so Slack stops resending it", async () => {
    const h = harness(async () => "", ["wss://one"]);
    const running = listen(h.deps);
    const socket = await socketAt(h.sockets, 0);

    socket.on.message(JSON.stringify({ envelope_id: "e-9", type: "events_api", payload: {} }));

    expect(socket.sent.map((data) => JSON.parse(data) as unknown)).toEqual([
      { envelope_id: "e-9" },
    ]);
    h.stop();
    await running;
  });

  it("acknowledges a mention before its work finishes, and hands the work the thread", async () => {
    const work = Promise.withResolvers<void>();
    const heard: Mention[] = [];
    const h = harness(
      async () => "",
      ["wss://one"],
      async (mention) => {
        heard.push(mention);
        await work.promise;
      },
    );
    const running = listen(h.deps);
    const socket = await socketAt(h.sockets, 0);

    socket.on.message(mentioned("e-m", IN_THREAD));

    expect(socket.sent.map((data) => JSON.parse(data) as unknown)).toEqual([
      { envelope_id: "e-m" },
    ]);
    await vi.waitFor(() => {
      expect(heard).toHaveLength(1);
    });
    expect(heard[0]).toEqual({
      userId: "U0ME",
      text: "<@U0BOT> start",
      channel: "C0CHAN",
      ts: "1790779745.218229",
      threadTs: "1790779480.401999",
    });
    work.resolve();
    h.stop();
    expect(await running).toMatchObject({ commands: 0, mentions: 1 });
  });

  it("runs a mention after the command already running, never beside it", async () => {
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();
    const h = harness(
      async () => {
        order.push("command started");
        await gate.promise;
        order.push("command finished");
        return "ok";
      },
      ["wss://one"],
      async () => {
        order.push("mention");
      },
    );
    const running = listen(h.deps);
    const socket = await socketAt(h.sockets, 0);

    socket.on.message(command("e-1", "subscribe"));
    await vi.waitFor(() => {
      expect(order).toEqual(["command started"]);
    });
    socket.on.message(mentioned("e-m", IN_THREAD));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["command started"]);

    gate.resolve();
    await vi.waitFor(() => {
      expect(order).toEqual(["command started", "command finished", "mention"]);
    });
    h.stop();
    await running;
  });

  it("acknowledges a click before its work finishes, and hands the work what was pressed", async () => {
    const work = Promise.withResolvers<void>();
    const pressedOn: Click[] = [];
    const h = harness(
      async () => "",
      ["wss://one"],
      undefined,
      async (click) => {
        pressedOn.push(click);
        await work.promise;
      },
    );
    const running = listen(h.deps);
    const socket = await socketAt(h.sockets, 0);

    socket.on.message(pressed("e-c"));

    expect(socket.sent.map((data) => JSON.parse(data) as unknown)).toEqual([
      { envelope_id: "e-c" },
    ]);
    await vi.waitFor(() => {
      expect(pressedOn).toHaveLength(1);
    });
    expect(pressedOn[0]).toEqual({
      userId: "U0ME",
      channel: "D0DIRECT",
      messageTs: "1790779999.000100",
      threadTs: null,
      actionId: "draft_post",
      value: "d-0123456789abcdef01234567",
    });
    work.resolve();
    h.stop();
    expect(await running).toMatchObject({ commands: 0, mentions: 0, clicks: 1 });
  });

  it("runs a click after the mention already running, never beside it", async () => {
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();
    const h = harness(
      async () => "",
      ["wss://one"],
      async () => {
        order.push("mention started");
        await gate.promise;
        order.push("mention finished");
      },
      async () => {
        order.push("click");
      },
    );
    const running = listen(h.deps);
    const socket = await socketAt(h.sockets, 0);

    socket.on.message(mentioned("e-m", IN_THREAD));
    await vi.waitFor(() => {
      expect(order).toEqual(["mention started"]);
    });
    socket.on.message(pressed("e-c"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["mention started"]);

    gate.resolve();
    await vi.waitFor(() => {
      expect(order).toEqual(["mention started", "mention finished", "click"]);
    });
    h.stop();
    await running;
  });

  it("keeps listening after a click's work throws", async () => {
    const pressedOn: string[] = [];
    const h = harness(
      async () => "",
      ["wss://one"],
      undefined,
      async (click) => {
        pressedOn.push(click.value);
        if (pressedOn.length === 1) {
          throw new Error("the first one fails");
        }
      },
    );
    const running = listen(h.deps);
    const socket = await socketAt(h.sockets, 0);

    socket.on.message(pressed("e-1"));
    socket.on.message(pressed("e-2"));

    await vi.waitFor(() => {
      expect(pressedOn).toHaveLength(2);
    });
    h.stop();
    expect(await running).toMatchObject({ clicks: 2 });
  });

  it("backs off a failing open, at least as long as a rate limit asked", async () => {
    const h = harness(
      async () => "",
      [
        new Error("network"),
        new SlackError("apps.connections.open", "ratelimited", "", 30),
        new Error("network"),
      ],
    );

    await listen(h.deps);

    expect(h.pauses).toEqual([1000, 30_000, 4000]);
  });

  it("backs off a connection that drops before its hello, and resets once one is greeted", async () => {
    const h = harness(async () => "", ["wss://1", "wss://2", "wss://3"]);
    const running = listen(h.deps);

    (await socketAt(h.sockets, 0)).on.closed();
    (await socketAt(h.sockets, 1)).on.closed();
    const third = await socketAt(h.sockets, 2);
    third.on.message(HELLO);
    third.on.closed();
    await running;

    expect(h.pauses).toEqual([1000, 2000, 1000]);
  });
});

describe("parseFrame", () => {
  it("takes the user from the payload's user_id, and the verb from its text", () => {
    expect(parseFrame(command("e-1", "subscribe U0OTHER", "U0ME"))).toEqual({
      kind: "command",
      envelope: "e-1",
      respond: true,
      command: { userId: "U0ME", text: "subscribe U0OTHER" },
    });
  });

  it("takes a mention's person from the event's user, and no thread when it names none", () => {
    const { thread_ts: _dropped, ...topLevel } = IN_THREAD;

    expect(parseFrame(mentioned("e-2", topLevel))).toEqual({
      kind: "mention",
      envelope: "e-2",
      mention: {
        userId: "U0ME",
        text: "<@U0BOT> start",
        channel: "C0CHAN",
        ts: "1790779745.218229",
        threadTs: null,
      },
    });
  });

  it("takes a click's person from the payload's user.id, never from its name", () => {
    expect(parseFrame(pressed("e-4"))).toEqual({
      kind: "click",
      envelope: "e-4",
      click: {
        userId: "U0ME",
        channel: "D0DIRECT",
        messageTs: "1790779999.000100",
        threadTs: null,
        actionId: "draft_post",
        value: "d-0123456789abcdef01234567",
      },
    });
  });

  it("takes the thread a click's message is a reply in from the container", () => {
    const frame = parseFrame(
      pressed("e-6", {
        container: {
          type: "message",
          message_ts: "1790779999.000100",
          channel_id: "D0DIRECT",
          thread_ts: "1790779000.000050",
        },
      }),
    );

    expect(frame).toMatchObject({
      kind: "click",
      click: { messageTs: "1790779999.000100", threadTs: "1790779000.000050" },
    });
  });

  it("falls back to the message's own thread_ts when the container names none", () => {
    const frame = parseFrame(
      pressed("e-7", {
        message: { ts: "1790779999.000100", thread_ts: "1790779000.000050" },
      }),
    );

    expect(frame).toMatchObject({ kind: "click", click: { threadTs: "1790779000.000050" } });
  });

  it("finds a click's channel and message in the container when the payload names neither itself", () => {
    const frame = parseFrame(pressed("e-5", { channel: undefined, message: undefined }));

    expect(frame).toMatchObject({
      kind: "click",
      click: { channel: "D0DIRECT", messageTs: "1790779999.000100" },
    });
  });

  it.each([
    ["a modal's submission", { type: "view_submission" }, "interactive/view_submission"],
    ["a payload with no type", { type: undefined }, "interactive/none"],
    ["a block_actions naming no action", { actions: [] }, "interactive/block_actions"],
    [
      "a block_actions whose action has no id",
      { actions: [{ value: "x" }] },
      "interactive/block_actions",
    ],
  ])("reads %s as an interactive payload to acknowledge and ignore", (_name, overrides, type) => {
    expect(parseFrame(pressed("e-6", overrides))).toEqual({
      kind: "other",
      envelope: "e-6",
      type,
    });
  });

  it("reads an event that is not a mention as one to acknowledge and ignore", () => {
    const message = JSON.stringify({
      envelope_id: "e-3",
      type: "events_api",
      payload: { event: { type: "message", text: "start" } },
    });

    expect(parseFrame(message)).toEqual({
      kind: "other",
      envelope: "e-3",
      type: "events_api/message",
    });
  });

  it.each([
    ["text that is not JSON", "{"],
    ["an envelope with no id", JSON.stringify({ type: "slash_commands", payload: {} })],
  ])("reads %s as unreadable", (_name, data) => {
    expect(parseFrame(data)).toEqual({ kind: "unreadable" });
  });
});
