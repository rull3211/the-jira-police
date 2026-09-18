import { type Mock, afterEach, describe, expect, it, vi } from "vitest";

import { AGENT_LABELS } from "../solve/labels.ts";
import { JiraClient, JiraError, assertOwnedLabel, isInlineable } from "./client.ts";

/** A value standing in for the credential, so leak assertions have a needle. */
const NEEDLE = "needle-value-do-not-echo";

function client(): JiraClient {
  return new JiraClient({
    baseUrl: "https://example.invalid",
    email: "someone@example.com",
    auth: NEEDLE,
  });
}

function issue(key: string, created: string, fields: Record<string, unknown> = {}): unknown {
  return {
    id: "1",
    key,
    fields: {
      summary: `Summary ${key}`,
      issuetype: { id: "10007", name: "Oppgave", subtask: false },
      created,
      updated: created,
      status: { id: "10165", name: "Mottatt" },
      labels: [],
      ...fields,
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

/** Reads the arguments of a recorded fetch call; fails loudly when the call was never made. */
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
        updated: "2026-09-02T10:00:00Z",
        statusId: "10165",
        statusName: "Mottatt",
        labels: [],
        url: "https://example.invalid/browse/SSX-1",
      },
    ]);

    const { url, init } = callArgs(fetchMock, 0);
    expect(url).toBe("https://example.invalid/rest/api/3/search/jql");
    expect(JSON.parse(init.body as string)).toMatchObject({ jql: "project = SSX" });
  });

  it("leaves the status empty when Jira did not return one", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        issues: [issue("SSX-2", "2026-09-02T10:00:00Z", { status: undefined })],
        isLast: true,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const [ticket] = await client().search("project = SSX");

    expect(ticket?.statusId).toBe("");
    expect(ticket?.statusName).toBe("");
  });

  // The solve queue's entire state is in `labels`, and it orders by `updated`; dropping either makes the queue unfeedable.
  it("carries labels and updated through the normaliser", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        issues: [
          issue("SSX-1", "2026-09-02T10:00:00Z", {
            updated: "2026-09-03T18:30:00Z",
            labels: ["agent:solvable", "agent:start"],
          }),
        ],
        isLast: true,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const [ticket] = await client().search("project = SSX");

    expect(ticket?.labels).toEqual(["agent:solvable", "agent:start"]);
    expect(ticket?.updated).toBe("2026-09-03T18:30:00Z");
    // Distinct from `created`, so a fixture reusing one value could not have
    // made this pass by accident.
    expect(ticket?.created).toBe("2026-09-02T10:00:00Z");
  });

  it("asks Jira for updated, or the field would always normalise to empty", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ issues: [], isLast: true }));
    vi.stubGlobal("fetch", fetchMock);

    await client().search("project = SSX");

    const { init } = callArgs(fetchMock, 0);
    expect(JSON.parse(init.body as string).fields).toContain("updated");
    expect(JSON.parse(init.body as string).fields).toContain("labels");
  });

  it("normalises absent labels to an empty list, not undefined", async () => {
    // The solve queue reads this straight into a Set, and `undefined` there would throw.
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        issues: [
          {
            id: "1",
            key: "SSX-2",
            fields: {
              summary: "x",
              issuetype: { id: "1", name: "Oppgave", subtask: false },
              created: "2026-09-02T10:00:00Z",
            },
          },
        ],
        isLast: true,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const [ticket] = await client().search("project = SSX");

    expect(ticket?.labels).toEqual([]);
    // Empty rather than falling back to `created`, so an absent timestamp fails loudly downstream.
    expect(ticket?.updated).toBe("");
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

/** A ticket payload shaped like the live SSX-3822 response, built from a real fetch rather than invented. */
function detailPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "752401",
    key: "SSX-3822",
    fields: {
      summary: "Distinct favicon for non-production builds",
      issuetype: { id: "10007", name: "Oppgave", subtask: false },
      status: { name: "Mottatt" },
      labels: ["agent:solvable", "svc:buy-insurance-advisor-web"],
      description: { type: "doc", version: 1, content: [] },
      comment: {
        comments: [
          {
            id: "1999252",
            author: { displayName: "Daniel Bence Søke" },
            created: "2026-09-04T15:38:00.831+0200",
            body: { type: "doc", version: 1, content: [] },
          },
        ],
      },
      attachment: [
        {
          id: "742005",
          filename: "svgtest.svg",
          mimeType: "image/svg+xml",
          size: 150,
        },
      ],
      ...overrides,
    },
  };
}

describe("JiraClient.fetchDetail", () => {
  it("asks for the three fields the search deliberately omits", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(detailPayload()));
    vi.stubGlobal("fetch", fetchMock);

    await client().fetchDetail("SSX-3822");

    const { url, init } = callArgs(fetchMock, 0);
    // The whole reason this method exists; a regression here is silent since the solve still runs.
    expect(url).toContain("description");
    expect(url).toContain("comment");
    expect(url).toContain("attachment");
    expect(init.method).toBe("GET");
  });

  it("normalises comments and attachments", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(detailPayload()));

    const detail = await client().fetchDetail("SSX-3822");

    expect(detail.key).toBe("SSX-3822");
    expect(detail.status).toBe("Mottatt");
    expect(detail.issueTypeName).toBe("Oppgave");
    expect(detail.comments).toHaveLength(1);
    expect(detail.comments[0]?.author).toBe("Daniel Bence Søke");
    expect(detail.attachments[0]).toEqual({
      id: "742005",
      filename: "svgtest.svg",
      mimeType: "image/svg+xml",
      size: 150,
    });
    expect(detail.url).toBe("https://example.invalid/browse/SSX-3822");
  });

  it("survives an issue with no description, comments or attachments", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse({ id: "1", key: "SSX-1", fields: { summary: "bare" } }),
    );

    const detail = await client().fetchDetail("SSX-1");

    expect(detail.comments).toEqual([]);
    expect(detail.attachments).toEqual([]);
    expect(detail.labels).toEqual([]);
    expect(detail.description).toBeUndefined();
  });

  it("refuses an issue key that would escape the endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(detailPayload()));
    vi.stubGlobal("fetch", fetchMock);

    for (const bad of [
      "../../../rest/api/3/myself",
      "SSX-3822/../../other",
      "SSX-3822?expand=changelog",
      "SSX 3822",
      "",
      "-1",
    ]) {
      await expect(client().fetchDetail(bad)).rejects.toThrow(JiraError);
    }
    // The guard runs before the fetch, not after it.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("JiraClient.fetchAttachmentText", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32"></svg>';

  it("returns the bytes of a small attachment", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(svg));
    vi.stubGlobal("fetch", fetchMock);

    expect(await client().fetchAttachmentText("742005", 32_768)).toBe(svg);
    expect(callArgs(fetchMock, 0).url).toContain("/rest/api/3/attachment/content/742005");
  });

  it("refuses an oversized attachment by its declared length", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(svg, { headers: { "content-length": "999999" } }),
    );

    expect(await client().fetchAttachmentText("742005", 10)).toBeNull();
  });

  it("refuses an oversized attachment that declared no length at all", async () => {
    // Chunked responses carry no content-length, so the cap must be re-checked on the bytes.
    vi.stubGlobal("fetch", async () => new Response("x".repeat(500)));

    expect(await client().fetchAttachmentText("742005", 10)).toBeNull();
  });

  it("measures the cap in bytes rather than characters", async () => {
    // Ten multi-byte characters are thirty bytes; a `.length` check would blow the budget it enforces.
    vi.stubGlobal("fetch", async () => new Response("🙂".repeat(10)));

    expect(await client().fetchAttachmentText("742005", 20)).toBeNull();
  });

  it("refuses an attachment id that is not an id", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(svg));
    vi.stubGlobal("fetch", fetchMock);

    for (const bad of ["../742005", "742005/..", "abc", ""]) {
      await expect(client().fetchAttachmentText(bad, 100)).rejects.toThrow(JiraError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("JiraClient.fetchAttachmentBytes", () => {
  // A PNG header: every byte here is outside what UTF-8 decoding round-trips.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);

  it("returns the bytes unchanged, whatever they decode to", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(png));
    vi.stubGlobal("fetch", fetchMock);

    const bytes = await client().fetchAttachmentBytes("742005", 32_768);

    expect(bytes).toEqual(png);
    expect(callArgs(fetchMock, 0).url).toContain("/rest/api/3/attachment/content/742005");
  });

  it("asks for any type, because the endpoint serves the file rather than JSON", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(png));
    vi.stubGlobal("fetch", fetchMock);

    await client().fetchAttachmentBytes("742005", 32_768);

    const headers = new Headers(callArgs(fetchMock, 0).init?.headers);
    expect(headers.get("accept")).toBe("*/*");
  });

  it("refuses an oversized attachment by its declared length", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(png, { headers: { "content-length": "999999" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await client().fetchAttachmentBytes("742005", 10)).toBeNull();
  });

  it("refuses an oversized attachment that declared no length at all", async () => {
    vi.stubGlobal("fetch", async () => new Response(Buffer.alloc(500)));

    expect(await client().fetchAttachmentBytes("742005", 10)).toBeNull();
  });

  it("refuses an attachment id that is not an id", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(png));
    vi.stubGlobal("fetch", fetchMock);

    for (const bad of ["../742005", "742005/..", "abc", ""]) {
      await expect(client().fetchAttachmentBytes(bad, 100)).rejects.toThrow(JiraError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("isInlineable", () => {
  it("treats SVG as text, because it is", () => {
    // A `startsWith("image/")` rule would hide exactly the asset tickets most often attach.
    expect(isInlineable("image/svg+xml")).toBe(true);
  });

  it("accepts text types and ignores charset parameters", () => {
    expect(isInlineable("text/plain")).toBe(true);
    expect(isInlineable("text/plain; charset=utf-8")).toBe(true);
    expect(isInlineable("IMAGE/SVG+XML")).toBe(true);
    expect(isInlineable("application/json")).toBe(true);
  });

  it("rejects binary types", () => {
    for (const type of ["image/png", "application/pdf", "application/zip", ""]) {
      expect(isInlineable(type)).toBe(false);
    }
  });
});

/** A 204 with no body, which is what a successful Jira issue edit returns. */
function putMock(status = 204): FetchMock {
  return vi.fn<typeof fetch>(async () => new Response(null, { status }));
}

/** The one write this credential can make, a deliberately-narrow amendment to a discovery-only rule. */
describe("JiraClient.updateLabels", () => {
  it("sends add and remove as a delta, not as a field", async () => {
    // `fields: { labels: [...] }` would clobber anything a human added between the read and this call.
    const fetchMock = putMock();
    vi.stubGlobal("fetch", fetchMock);

    await client().updateLabels("SSX-3822", {
      add: ["agent:solving"],
      remove: ["agent:start"],
    });

    const { url, init } = callArgs(fetchMock, 0);
    expect(url).toBe("https://example.invalid/rest/api/3/issue/SSX-3822");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      update: { labels: [{ add: "agent:solving" }, { remove: "agent:start" }] },
    });
  });

  it("does not read a body from the 204 an issue edit returns", async () => {
    // A `.json()` on an empty body throws, misreporting a write that in fact landed.
    vi.stubGlobal("fetch", putMock());

    await expect(
      client().updateLabels("SSX-3822", { add: ["agent:done"] }),
    ).resolves.toBeUndefined();
  });

  it("refuses every label outside the agent: namespace", async () => {
    const fetchMock = putMock();
    vi.stubGlobal("fetch", fetchMock);

    for (const label of ["triaged", "next:to-trio", "svc:web", "dor:pass", "", "agentx:solving"]) {
      await expect(client().updateLabels("SSX-3822", { add: [label] })).rejects.toThrow(JiraError);
      await expect(client().updateLabels("SSX-3822", { remove: [label] })).rejects.toThrow(
        JiraError,
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a malformed label inside the namespace", async () => {
    // `agent:` is necessary but not sufficient: a quote, space or newline could reach a later JQL clause.
    const fetchMock = putMock();
    vi.stubGlobal("fetch", fetchMock);

    for (const label of [
      "agent:",
      "agent:Solving",
      "agent:sol ving",
      'agent:sol"ving',
      "agent:sol\nving",
      "agent:1solving",
      "agent:-solving",
      // 61 after the prefix is the last accepted length, so 62 is the first rejected one.
      `agent:${"x".repeat(62)}`,
    ]) {
      await expect(client().updateLabels("SSX-3822", { add: [label] })).rejects.toThrow(JiraError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to both add and remove the same label", async () => {
    // Jira applies the operations in order, so the result depends on which came last; refuse instead.
    const fetchMock = putMock();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      client().updateLabels("SSX-3822", { add: ["agent:done"], remove: ["agent:done"] }),
    ).rejects.toThrow(JiraError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an issue key that is not an issue key", async () => {
    // The key goes into the path; a traversal here aims the one write verb at an unreviewed endpoint.
    const fetchMock = putMock();
    vi.stubGlobal("fetch", fetchMock);

    for (const bad of ["../SSX-1", "SSX-1/comment", "SSX", "", "SSX-1 OR 1=1"]) {
      await expect(client().updateLabels(bad, { add: ["agent:done"] })).rejects.toThrow(JiraError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("makes no request at all when there is nothing to change", async () => {
    const fetchMock = putMock();
    vi.stubGlobal("fetch", fetchMock);

    await client().updateLabels("SSX-3822", {});
    await client().updateLabels("SSX-3822", { add: [], remove: [] });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("raises on a rejected write rather than reporting success", async () => {
    vi.stubGlobal("fetch", putMock(403));

    await expect(client().updateLabels("SSX-3822", { add: ["agent:done"] })).rejects.toThrow(
      JiraError,
    );
  });

  it("does not put the credential in the error when the write fails", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error(`connect ECONNREFUSED ${NEEDLE}`);
    });

    await expect(client().updateLabels("SSX-3822", { add: ["agent:done"] })).rejects.toThrow(
      JiraError,
    );
  });
});

describe("assertOwnedLabel", () => {
  it("accepts every label the state machine can write", () => {
    // Read off AGENT_LABELS rather than copied out of it, so a new label here can't silently rot.
    for (const label of Object.values(AGENT_LABELS)) {
      expect(() => {
        assertOwnedLabel(label);
      }).not.toThrow();
    }
  });

  it("says which rule refused, because the two mean different things", () => {
    // "not ours" is a caller aiming at somebody else's label; "malformed" is ours, got wrong.
    expect(() => {
      assertOwnedLabel("triaged");
    }).toThrow(/may only touch agent:\*/);
    expect(() => {
      assertOwnedLabel("agent:Solving");
    }).toThrow(/malformed/);
  });
});
