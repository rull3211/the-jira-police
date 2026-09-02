import { type Mock, afterEach, describe, expect, it, vi } from "vitest";

import { JiraClient, JiraError } from "./client.ts";

/** A value standing in for the credential, so leak assertions have a needle. */
const NEEDLE = "needle-value-do-not-echo";

function client(): JiraClient {
  return new JiraClient({
    baseUrl: "https://example.invalid",
    email: "someone@example.com",
    auth: NEEDLE,
  });
}

function issue(key: string, created: string): unknown {
  return {
    id: "1",
    key,
    fields: {
      summary: `Summary ${key}`,
      issuetype: { id: "10007", name: "Oppgave", subtask: false },
      created,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type FetchMock = Mock<typeof fetch>;

/**
 * Reads the arguments of a recorded fetch call.
 *
 * Fails loudly when the call was never made, rather than letting an assertion
 * pass vacuously against undefined.
 */
function callArgs(mock: FetchMock, index: number): { url: string; init: RequestInit } {
  const call = mock.mock.calls[index];
  if (call === undefined) {
    throw new Error(`fetch was not called ${index + 1} time(s)`);
  }
  return { url: String(call[0]), init: call[1] ?? {} };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("JiraClient.search", () => {
  it("sends the JQL and normalises the results", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ issues: [issue("SSX-1", "2026-09-02T10:00:00Z")], isLast: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tickets = await client().search("project = SSX");

    expect(tickets).toEqual([
      {
        key: "SSX-1",
        summary: "Summary SSX-1",
        issueTypeId: "10007",
        issueTypeName: "Oppgave",
        created: "2026-09-02T10:00:00Z",
        url: "https://example.invalid/browse/SSX-1",
      },
    ]);

    const { url, init } = callArgs(fetchMock, 0);
    expect(url).toBe("https://example.invalid/rest/api/3/search/jql");
    expect(JSON.parse(init.body as string)).toMatchObject({ jql: "project = SSX" });
  });

  it("authenticates with Basic and the email as the user half", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ issues: [], isLast: true }));
    vi.stubGlobal("fetch", fetchMock);

    await client().search("project = SSX");

    const { init } = callArgs(fetchMock, 0);
    const header = (init.headers as Record<string, string>)["Authorization"] ?? "";
    expect(header.startsWith("Basic ")).toBe(true);
    expect(Buffer.from(header.slice(6), "base64").toString("utf8")).toBe(
      `someone@example.com:${NEEDLE}`,
    );
  });

  it("strips a trailing slash from the base url", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ issues: [], isLast: true }));
    vi.stubGlobal("fetch", fetchMock);

    await new JiraClient({
      baseUrl: "https://example.invalid/",
      email: "a@b.c",
      auth: NEEDLE,
    }).search("project = SSX");

    expect(callArgs(fetchMock, 0).url).toBe("https://example.invalid/rest/api/3/search/jql");
  });

  it("follows pagination until the last page", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          issues: [issue("SSX-1", "2026-09-02T10:00:00Z")],
          nextPageToken: "page-2",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ issues: [issue("SSX-2", "2026-09-02T10:05:00Z")], isLast: true }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const tickets = await client().search("project = SSX");

    expect(tickets.map((t) => t.key)).toEqual(["SSX-1", "SSX-2"]);
    const { init: second } = callArgs(fetchMock, 1);
    expect(JSON.parse(second.body as string)).toMatchObject({ nextPageToken: "page-2" });
  });

  it("stops when isLast is set even if a token is present", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        issues: [issue("SSX-1", "2026-09-02T10:00:00Z")],
        nextPageToken: "page-2",
        isLast: true,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await client().search("project = SSX");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up rather than looping forever on endless page tokens", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ issues: [issue("SSX-1", "2026-09-02T10:00:00Z")], nextPageToken: "x" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await client().search("project = SSX");

    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it("explains a rejected credential without echoing it", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ message: NEEDLE }, 401));

    const error = await client()
      .search("project = SSX")
      .catch((e: unknown) => e as JiraError);

    expect(error).toBeInstanceOf(JiraError);
    expect((error as JiraError).status).toBe(401);
    expect((error as JiraError).message).not.toContain(NEEDLE);
  });

  it("surfaces the retry-after hint when rate limited", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("slow down", { status: 429, headers: { "retry-after": "42" } }),
    );

    await expect(client().search("project = SSX")).rejects.toThrow(/retry-after=42/);
  });

  it("reports a network failure as status 0", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });

    const error = await client()
      .search("project = SSX")
      .catch((e: unknown) => e as JiraError);

    expect((error as JiraError).status).toBe(0);
  });

  it("never leaks the credential in an unexpected-status message", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ detail: "boom" }, 500));

    const error = await client()
      .search("project = SSX")
      .catch((e: unknown) => e as JiraError);

    expect((error as JiraError).message).not.toContain(NEEDLE);
  });
});
