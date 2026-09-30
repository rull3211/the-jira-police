import { type Mock, afterEach, describe, expect, it, vi } from "vitest";

import { SlackClient, SlackError } from "./client.ts";

/** Stands in for the token, so a leak assertion has something to look for. */
const NEEDLE = "xoxb-needle-do-not-echo";

type FetchMock = Mock<typeof fetch>;

function slack(body: unknown, init: ResponseInit = {}): FetchMock {
  const mock = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
        ...init,
      }),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

function sent(mock: FetchMock): { url: string; form: URLSearchParams; init: RequestInit } {
  const call = mock.mock.calls[0];
  if (call === undefined) {
    throw new Error("fetch was never called");
  }
  const init = call[1] ?? {};
  return { url: String(call[0]), form: new URLSearchParams(String(init.body)), init };
}

async function caught(promise: Promise<unknown>): Promise<SlackError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SlackError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a SlackError, and the call succeeded");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SlackClient", () => {
  it("throws on ok:false even though Slack answered HTTP 200", async () => {
    slack({ ok: false, error: "not_in_channel" });

    const error = await caught(
      new SlackClient({ token: NEEDLE }).post({ channel: "C1", text: "hi" }),
    );

    expect(error.code).toBe("not_in_channel");
    expect(error.method).toBe("chat.postMessage");
  });

  it("names the scope a missing_scope failure wanted, so the first run says what to grant", async () => {
    slack({ ok: false, error: "missing_scope", needed: "chat:write", provided: "users:read" });

    const error = await caught(
      new SlackClient({ token: NEEDLE }).post({ channel: "C1", text: "hi" }),
    );

    expect(error.message).toContain("needs scope chat:write");
    expect(error.message).toContain("users:read");
  });

  it("reports a rate limit with the pause Slack asked for", async () => {
    slack({ ok: false, error: "ratelimited" }, { status: 429, headers: { "retry-after": "7" } });

    const error = await caught(new SlackClient({ token: NEEDLE }).authTest());

    expect(error.code).toBe("ratelimited");
    expect(error.retryAfterSeconds).toBe(7);
    // The message is all `slack.audit_failed` logs, so the pause has to be in it to reach anyone.
    expect(error.message).toContain("pause of 7s");
  });

  it("reports a network failure as its own kind", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const error = await caught(new SlackClient({ token: NEEDLE }).authTest());

    expect(error.code).toBe("network");
  });

  it("hands back the warnings of a successful call, which is where a dropped field shows", async () => {
    slack({
      ok: true,
      ts: "1.2",
      warning: "superfluous_charset,invalid_metadata_schema",
      response_metadata: { warnings: ["superfluous_charset", "invalid_metadata_schema"] },
    });

    const result = await new SlackClient({ token: NEEDLE }).post({
      channel: "C1",
      text: "hi",
    });

    expect(result.warnings).toEqual(["superfluous_charset", "invalid_metadata_schema"]);
  });

  it("hands back the conversation Slack answers with, which for a member ID is not the ID posted to", async () => {
    slack({ ok: true, ts: "1.2", channel: "D0123ABCD" });

    const result = await new SlackClient({ token: NEEDLE }).post({
      channel: "U0123ABCD",
      text: "hi",
    });

    expect(result).toEqual({ ts: "1.2", channel: "D0123ABCD", warnings: [] });
  });

  it("sends objects as JSON, omits what was not given, and keeps the token in the header only", async () => {
    const mock = slack({ ok: true, ts: "1.2" });

    await new SlackClient({ token: NEEDLE }).update({
      channel: "C1",
      ts: "1.2",
      text: "hi",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "hi" } }],
    });

    const { url, form, init } = sent(mock);
    expect(url).toBe("https://slack.com/api/chat.update");
    expect(JSON.parse(form.get("blocks") ?? "")).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "hi" } },
    ]);
    expect(form.has("unfurl_links")).toBe(false);
    expect(String(init.body)).not.toContain(NEEDLE);
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${NEEDLE}`);
  });

  it("broadcasts only a reply, since reply_broadcast means nothing without a thread", async () => {
    const mock = slack({ ok: true, ts: "1.3" });
    const client = new SlackClient({ token: NEEDLE });

    await client.post({ channel: "C1", text: "hi", threadTs: "1.2", broadcast: true });
    await client.post({ channel: "C1", text: "hi", broadcast: true });

    const reply = new URLSearchParams(String(mock.mock.calls[0]?.[1]?.body));
    const top = new URLSearchParams(String(mock.mock.calls[1]?.[1]?.body));
    expect([reply.get("thread_ts"), reply.get("reply_broadcast")]).toEqual(["1.2", "true"]);
    expect([top.has("thread_ts"), top.has("reply_broadcast")]).toEqual([false, false]);
  });

  it("sends a form body with no charset, which Slack answered with superfluous_charset", async () => {
    const mock = slack({ ok: true, ts: "1.2" });

    await new SlackClient({ token: NEEDLE }).post({ channel: "C1", text: "hi" });

    expect(new Headers(sent(mock).init.headers).get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  it("opens a Socket Mode connection with the token in the header, and refuses an answer with no wss URL", async () => {
    const mock = slack({ ok: true, url: "wss://wss.slack.com/link/?ticket=1" });
    const client = new SlackClient({ token: "xapp-needle" });

    expect(await client.openConnection()).toBe("wss://wss.slack.com/link/?ticket=1");
    expect(sent(mock).url).toBe("https://slack.com/api/apps.connections.open");
    expect(sent(mock).form.toString()).toBe("");
    expect(new Headers(sent(mock).init.headers).get("authorization")).toBe("Bearer xapp-needle");

    slack({ ok: true, url: "https://example.test/" });
    expect((await caught(client.openConnection())).code).toBe("no_url");
  });

  it("reads a thread's top message with its bot_id, and null when Slack returns none", async () => {
    const mock = slack({
      ok: true,
      messages: [{ ts: "1.2", text: "SSX-1: picked up", bot_id: "B1", user: "U1" }],
    });
    const client = new SlackClient({ token: NEEDLE });

    expect(await client.threadRoot({ channel: "C1", ts: "1.2" })).toEqual({
      ts: "1.2",
      text: "SSX-1: picked up",
      botId: "B1",
    });
    expect(sent(mock).url).toBe("https://slack.com/api/conversations.replies");
    expect(Object.fromEntries(sent(mock).form)).toEqual({
      channel: "C1",
      ts: "1.2",
      limit: "1",
      inclusive: "true",
    });

    slack({ ok: true, messages: [{ ts: "1.2", text: "hi", user: "U1" }] });
    expect((await client.threadRoot({ channel: "C1", ts: "1.2" }))?.botId).toBeNull();
    slack({ ok: true, messages: [] });
    expect(await client.threadRoot({ channel: "C1", ts: "1.2" })).toBeNull();
  });

  it("posts an ephemeral reply into the thread it names, to the one user", async () => {
    const mock = slack({ ok: true, message_ts: "1.3" });

    await new SlackClient({ token: NEEDLE }).postEphemeral({
      channel: "C1",
      user: "U1",
      text: "hi",
      threadTs: "1.2",
    });

    expect(sent(mock).url).toBe("https://slack.com/api/chat.postEphemeral");
    expect(Object.fromEntries(sent(mock).form)).toEqual({
      channel: "C1",
      user: "U1",
      text: "hi",
      thread_ts: "1.2",
    });
  });
});
