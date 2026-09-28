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
    slack({
      ok: false,
      error: "missing_scope",
      needed: "channels:history",
      provided: "chat:write",
    });

    const error = await caught(new SlackClient({ token: NEEDLE }).history({ channel: "C1" }));

    expect(error.message).toContain("needs scope channels:history");
    expect(error.message).toContain("chat:write");
  });

  it("reports a rate limit with the pause Slack asked for", async () => {
    slack({ ok: false, error: "ratelimited" }, { status: 429, headers: { "retry-after": "7" } });

    const error = await caught(new SlackClient({ token: NEEDLE }).authTest());

    expect(error.code).toBe("ratelimited");
    expect(error.retryAfterSeconds).toBe(7);
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
      warning: "invalid_metadata_format",
      response_metadata: { warnings: ["invalid_metadata_format", "missing_charset"] },
    });

    const result = await new SlackClient({ token: NEEDLE }).post({
      channel: "C1",
      text: "hi",
    });

    expect(result.warnings).toEqual(["invalid_metadata_format", "missing_charset"]);
  });

  it("sends objects as JSON, omits what was not given, and keeps the token in the header only", async () => {
    const mock = slack({ ok: true, ts: "1.2" });

    await new SlackClient({ token: NEEDLE }).update({
      channel: "C1",
      ts: "1.2",
      text: "hi",
      metadata: { event_type: "jira_police.probe", event_payload: { stage: "updated" } },
    });

    const { url, form, init } = sent(mock);
    expect(url).toBe("https://slack.com/api/chat.update");
    expect(JSON.parse(form.get("metadata") ?? "")).toEqual({
      event_type: "jira_police.probe",
      event_payload: { stage: "updated" },
    });
    expect(form.has("blocks")).toBe(false);
    expect(String(init.body)).not.toContain(NEEDLE);
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${NEEDLE}`);
  });

  it("asks history for metadata and reads it back off each message", async () => {
    const mock = slack({
      ok: true,
      messages: [
        {
          ts: "1.2",
          text: "hi",
          bot_id: "B1",
          metadata: { event_type: "jira_police.probe", event_payload: { stage: "posted" } },
        },
        { ts: "1.1", text: "a person" },
      ],
      response_metadata: { next_cursor: "" },
    });

    const page = await new SlackClient({ token: NEEDLE }).history({ channel: "C1", limit: 2 });

    expect(sent(mock).form.get("include_all_metadata")).toBe("true");
    expect(page.nextCursor).toBeNull();
    expect(page.messages).toEqual([
      {
        ts: "1.2",
        text: "hi",
        botId: "B1",
        metadata: { event_type: "jira_police.probe", event_payload: { stage: "posted" } },
      },
      { ts: "1.1", text: "a person", botId: null, metadata: null },
    ]);
  });
});
