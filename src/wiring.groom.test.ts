/**
 * Tests the composition itself: analyse → gate → post.
 *
 * Separate from `wiring.test.ts` because it mocks the two subprocess runners and `vi.mock`
 * applies to a whole file. Everything here is about order and conditions, which unit tests of
 * the pieces alone cannot see — a guard is not shipped until a test fails when it's unplugged.
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TicketRef } from "./jira/types.ts";
import { TicketHeldError } from "./solve/hold.ts";
import { FOOTER_SENTINEL } from "./triage/gate.ts";
import type { Mutation, TriagePayload } from "./triage/runner.ts";

const runTriage = vi.hoisted(() => vi.fn());
const runPost = vi.hoisted(() => vi.fn());

vi.mock("./triage/runner.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./triage/runner.ts")>()),
  runTriage,
}));

vi.mock("./triage/poster.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./triage/poster.ts")>()),
  runPost,
}));

const { createGroom } = await import("./wiring.ts");
const { readSettings } = await import("./settings.ts");

const TICKET: TicketRef = {
  key: "SSX-1234",
  summary: "A ticket",
  issueTypeId: "10007",
  issueTypeName: "Oppgave",
  created: "2026-09-02T09:55:34.178+0200",
  updated: "2026-09-02T09:55:34.178+0200",
  statusId: "10165",
  statusName: "Mottatt",
  labels: [],
  url: "https://example.invalid/browse/SSX-1234",
};

function mutation(overrides: Partial<Mutation> = {}): Mutation {
  return {
    commentBody: `# ↩ SEND BACK → needs info · SSX-1234\n\nGaps remain.\n\n${FOOTER_SENTINEL}`,
    labelsAdd: ["dor:gaps"],
    labelsRemove: [],
    component: "",
    links: [],
    commentAction: "create",
    ...overrides,
  };
}

function payload(overrides: Partial<TriagePayload> = {}): TriagePayload {
  return {
    verdict: "needs-info",
    labels: ["dor:gaps", "route:ours"],
    dorPlaceholders: [],
    recommendedNextStep: "Ask the reporter.",
    report: "## report",
    mutation: mutation(),
    agentFitness: {
      solvable: false,
      plausible: false,
      confidence: "low",
      repo: "",
      rationale: "Needs a human.",
      blockers: ["no reproduction steps"],
    },
    ...overrides,
  };
}

/** Shared OUTPUT_DIR for tests without their own: a refusal writes a rejection file, and the default `groomed/` would commit it as a fixture. */
const SCRATCH = await mkdtemp(join(tmpdir(), "groom-"));

/** An accepted ticket with `solvable: false` and populated `blockers` — the note exists to serve exactly this shape, since the blockers are a to-do list a human can often clear cheaply. */
function readyish(overrides: Partial<TriagePayload> = {}): TriagePayload {
  return payload({
    verdict: "ready-ish",
    labels: ["dor:pass", "route:ours"],
    mutation: mutation({ labelsAdd: ["dor:pass"], labelsRemove: ["dor:gaps"] }),
    agentFitness: {
      solvable: false,
      plausible: false,
      confidence: "med",
      repo: "buy-insurance-advisor-web",
      rationale: "The deliverable is a brand asset.",
      blockers: ["needs a real .ico asset"],
    },
    ...overrides,
  });
}

function settings(overrides: Partial<Record<string, string>> = {}) {
  return readSettings({
    JIRA_EMAIL: "a@b.c",
    JIRA_AUTH: "placeholder",
    SKILL_NAME: "intake-triage",
    VAULT_PATH: "/vaults/v",
    OUTPUT_DIR: SCRATCH,
    ...overrides,
  });
}

/** What Jira says the ticket's labels are right now; the real gate reads it through `fetchLabels`, so no network is reached. */
let labelsOnTicket: readonly string[] = [];

beforeEach(() => {
  labelsOnTicket = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ key: "SSX-1234", fields: { labels: labelsOnTicket } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
  runTriage.mockReset();
  runPost.mockReset();
  runPost.mockResolvedValue({
    commentAction: "created",
    labelsWritten: [],
    linksCreated: [],
    problems: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createGroom with WRITE_BACK off", () => {
  it("analyses and stops", () => {
    runTriage.mockResolvedValue(payload());

    return expect(createGroom(settings())(TICKET)).resolves.toMatchObject({
      verdict: "needs-info",
    });
  });

  it("dispatches no poster", async () => {
    runTriage.mockResolvedValue(payload());
    await createGroom(settings())(TICKET);

    expect(runPost).not.toHaveBeenCalled();
  });

  it("does not refuse an incoherent verdict, since nothing is being published", async () => {
    // The posting gate only applies to runs that post; nothing is published here.
    runTriage.mockResolvedValue(payload({ mutation: mutation({ commentBody: "" }) }));

    await expect(createGroom(settings())(TICKET)).resolves.toBeDefined();
  });
});

describe("createGroom with WRITE_BACK on", () => {
  const on = () => settings({ WRITE_BACK: "true" });

  it("posts a coherent verdict", async () => {
    runTriage.mockResolvedValue(payload());
    await createGroom(on())(TICKET);

    expect(runPost).toHaveBeenCalledOnce();
  });

  it("hands the poster the analyst's own mutation, unaltered", async () => {
    // The thing checked must be the thing posted, or the gate is only checking a draft.
    // Covers `needs-info`, below the fitness-note threshold; the ready-ish case, where the
    // note is spliced in before the gate, is covered separately below.
    const result = payload();
    runTriage.mockResolvedValue(result);
    await createGroom(on())(TICKET);

    expect(runPost.mock.calls[0]?.[0]).toMatchObject({
      issueKey: "SSX-1234",
      mutation: result.mutation,
    });
  });

  it("posts the agent-fitness note on a ready-ish ticket", async () => {
    // Unplug `withFitnessNote` in `createGroom` and this fails: without it the blockers stay
    // in a gitignored local file the reporter never sees.
    runTriage.mockResolvedValue(readyish());
    await createGroom(on())(TICKET);

    const posted = runPost.mock.calls[0]?.[0]?.mutation.commentBody ?? "";

    expect(posted).toContain("🤖 **Agent fitness:**");
    expect(posted).toContain("* needs a real .ico asset");
    expect(posted).toContain("`buy-insurance-advisor-web`");
  });

  it("keeps the footer sentinel last, and only one of it", async () => {
    // The skill makes the sentinel the last line, and a second copy would be a second match for a re-run.
    runTriage.mockResolvedValue(readyish());
    await createGroom(on())(TICKET);

    const posted = runPost.mock.calls[0]?.[0]?.mutation.commentBody ?? "";

    expect(posted.trimEnd().endsWith(FOOTER_SENTINEL)).toBe(true);
    expect(posted.split(FOOTER_SENTINEL)).toHaveLength(2);
  });

  it("posts a body whose legend the model put below the sentinel, rather than refusing it", async () => {
    const legend = "_Legend: ✅accept ⛔reject ↪route ↩send-back._";
    runTriage.mockResolvedValue(
      readyish({
        mutation: mutation({
          commentBody: `# ✅ ACCEPT → queue · SSX-1234\n\nThe report.\n\n${FOOTER_SENTINEL}\n${legend}`,
          labelsAdd: ["dor:pass"],
          labelsRemove: ["dor:gaps"],
        }),
      }),
    );
    await createGroom(on())(TICKET);

    const posted = runPost.mock.calls[0]?.[0]?.mutation.commentBody ?? "";

    expect(posted.trimEnd().endsWith(FOOTER_SENTINEL)).toBe(true);
    expect(posted).toContain(legend);
  });

  it("gates the body it will actually post, not the draft before the splice", async () => {
    // The note is added before `assertPostable` runs, so checked and sent text are the same string.
    const original = readyish();
    runTriage.mockResolvedValue(original);
    await createGroom(on())(TICKET);

    const posted = runPost.mock.calls[0]?.[0]?.mutation.commentBody ?? "";

    expect(posted).not.toBe(original.mutation.commentBody);
    expect(posted).toContain("Gaps remain.");
  });

  it("REFUSES to post when the gate objects", async () => {
    // Unplug `assertPostable` from `createGroom` and this is what fails.
    runTriage.mockResolvedValue(payload({ mutation: mutation({ component: "Nonsense" }) }));

    await expect(createGroom(on())(TICKET)).rejects.toThrow(/refusing to post/);
    expect(runPost).not.toHaveBeenCalled();
  });

  it("refuses the SSX-3822 contradiction before anything reaches the board", async () => {
    // The refusal happens with the poster still un-dispatched.
    runTriage.mockResolvedValue(
      payload({
        verdict: "ready-ish",
        labels: ["dor:pass", "route:ours"],
        dorPlaceholders: [{ text: "[N]", row: 3 }],
        mutation: mutation({ labelsAdd: ["dor:pass"] }),
      }),
    );

    await expect(createGroom(on())(TICKET)).rejects.toThrow(/dor:pass only if 1-7 hold/);
    expect(runPost).not.toHaveBeenCalled();
  });

  it("gates BEFORE posting, not after", async () => {
    // Asserted directly rather than inferred from the absence of a call.
    const order: string[] = [];
    runTriage.mockImplementation(() => {
      order.push("analyse");
      return Promise.resolve(payload({ mutation: mutation({ component: "Nonsense" }) }));
    });
    runPost.mockImplementation(() => {
      order.push("post");
      return Promise.resolve({
        commentAction: "created",
        labelsWritten: [],
        linksCreated: [],
        problems: [],
      });
    });

    await expect(createGroom(on())(TICKET)).rejects.toThrow();
    expect(order).toEqual(["analyse"]);
  });

  it("propagates a failed post, so the poller retries the ticket", async () => {
    // A thrown groom leaves the key unrecorded and the cursor behind it. The
    // comment sentinel makes the retry update in place rather than duplicate.
    runTriage.mockResolvedValue(payload());
    runPost.mockRejectedValue(new Error("MCP session expired"));

    await expect(createGroom(on())(TICKET)).rejects.toThrow("MCP session expired");
  });

  it("never posts for a stand-in skill, whatever WRITE_BACK says", async () => {
    runTriage.mockResolvedValue(payload());
    await createGroom(settings({ SKILL_NAME: "mock-triage", WRITE_BACK: "true" }))(TICKET);

    expect(runPost).not.toHaveBeenCalled();
  });

  it("records the refused mutation, so the refusal can be judged afterwards", async () => {
    // Real temp directory rather than a mock: what's tested is that a file an operator can open ends up on disk.
    const directory = await mkdtemp(join(tmpdir(), "groom-reject-"));
    runTriage.mockResolvedValue(
      payload({
        dorPlaceholders: [{ text: "[N]", row: 9 }],
        mutation: mutation({ component: "Nonsense" }),
      }),
    );

    await expect(
      createGroom(settings({ WRITE_BACK: "true", OUTPUT_DIR: directory }))(TICKET),
    ).rejects.toThrow();

    const written = await readFile(join(directory, "SSX-1234.rejected.md"), "utf8");
    expect(written).toContain("Nonsense");
    // The row decides whether a placeholder blocks, so an artifact that omits it can't be judged.
    expect(written).toContain("[N] (row 9)");
    expect(written).toContain("Gaps remain.");
  });

  it("writes no rejection file when the gate is content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "groom-ok-"));
    runTriage.mockResolvedValue(payload());

    await createGroom(settings({ WRITE_BACK: "true", OUTPUT_DIR: directory }))(TICKET);

    await expect(readFile(join(directory, "SSX-1234.rejected.md"), "utf8")).rejects.toThrow();
  });

  it("clears a superseded rejection once a later run passes the gate", async () => {
    // A stale refusal file next to a later success would claim the ticket was both groomed and refused.
    const directory = await mkdtemp(join(tmpdir(), "groom-supersede-"));
    const groom = createGroom(settings({ WRITE_BACK: "true", OUTPUT_DIR: directory }));

    runTriage.mockResolvedValue(payload({ mutation: mutation({ component: "Nonsense" }) }));
    await expect(groom(TICKET)).rejects.toThrow();
    await expect(readFile(join(directory, "SSX-1234.rejected.md"), "utf8")).resolves.toBeDefined();

    runTriage.mockResolvedValue(payload());
    await groom(TICKET);

    await expect(readFile(join(directory, "SSX-1234.rejected.md"), "utf8")).rejects.toThrow();
  });

  it("runs the analyst with --no-write even when it is going to post", async () => {
    // The analyst is never re-armed; posting is a separate session with its own allowlist.
    runTriage.mockResolvedValue(payload());
    await createGroom(on())(TICKET);

    expect(runTriage.mock.calls[0]?.[0]).not.toHaveProperty("noWrite", false);
  });
});

describe("createGroom for a ticket a person has labelled agent:ignore", () => {
  const on = () => settings({ WRITE_BACK: "true" });

  it("starts nothing for a ticket that is already held", async () => {
    // The analysis is the spend: the poller triages one ticket at a time, so this one may have waited out the backlog ahead of it.
    labelsOnTicket = ["agent:ignore"];
    runTriage.mockResolvedValue(payload());

    await expect(createGroom(on())(TICKET)).rejects.toBeInstanceOf(TicketHeldError);

    expect(runTriage).not.toHaveBeenCalled();
    expect(runPost).not.toHaveBeenCalled();
  });

  it("holds with WRITE_BACK off too, since the analysis is paid for either way", async () => {
    labelsOnTicket = ["agent:ignore"];
    runTriage.mockResolvedValue(payload());

    await expect(createGroom(settings())(TICKET)).rejects.toBeInstanceOf(TicketHeldError);

    expect(runTriage).not.toHaveBeenCalled();
  });

  it("drops the verdict when the label arrives while the analysis runs", async () => {
    // Unplug the check before `runPost` and this fails: the first check passed, and only this one can still save the post.
    runTriage.mockImplementation(async () => {
      labelsOnTicket = ["agent:ignore"];
      return payload();
    });

    await expect(createGroom(on())(TICKET)).rejects.toBeInstanceOf(TicketHeldError);

    expect(runTriage).toHaveBeenCalledOnce();
    expect(runPost).not.toHaveBeenCalled();
  });

  it("holds when Jira cannot say what the labels are", async () => {
    vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
    runTriage.mockResolvedValue(payload());

    await expect(createGroom(on())(TICKET)).rejects.toBeInstanceOf(TicketHeldError);

    expect(runTriage).not.toHaveBeenCalled();
    expect(runPost).not.toHaveBeenCalled();
  });

  it("reads the labels of the ticket it was handed", async () => {
    runTriage.mockResolvedValue(payload());
    await createGroom(on())(TICKET);

    const asked = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(asked.every((url) => url.includes("/rest/api/3/issue/SSX-1234?fields=labels"))).toBe(
      true,
    );
    expect(asked.length).toBeGreaterThan(0);
  });

  it("is not recorded on the audit thread as a crash, even if the hold lifts before the record is written", async () => {
    // The notifier asks the gate for itself, so with the label still on it would skip the crash anyway and hide
    // this. Reads, in order: the start, the thread's first post, the check before the post (held), the crash record.
    const directory = await mkdtemp(join(tmpdir(), "groom-held-"));
    const answers: (readonly string[])[] = [[], [], ["agent:ignore"], []];
    let read = 0;
    vi.stubGlobal("fetch", async (url: string | URL) =>
      String(url).includes("fields=labels")
        ? new Response(JSON.stringify({ fields: { labels: answers[read++] ?? [] } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response("not found", { status: 404 }),
    );
    runTriage.mockResolvedValue(payload());

    await expect(
      createGroom(settings({ WRITE_BACK: "true", SLACK_MODE: "dry", OUTPUT_DIR: directory }))(
        TICKET,
      ),
    ).rejects.toBeInstanceOf(TicketHeldError);

    const record = JSON.parse(
      await readFile(join(directory, "slack", "SSX-1234.record.json"), "utf8"),
    ) as { crash: unknown };
    expect(record.crash).toBeNull();
  });

  it("does record an ordinary failure as a crash", async () => {
    // The control for the test above: the same wiring, the same reads, and an error that is not a hold.
    const directory = await mkdtemp(join(tmpdir(), "groom-crash-"));
    vi.stubGlobal("fetch", async (url: string | URL) =>
      String(url).includes("fields=labels")
        ? new Response(JSON.stringify({ fields: { labels: [] } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response("not found", { status: 404 }),
    );
    runTriage.mockRejectedValue(new Error("the session fell over"));

    await expect(
      createGroom(settings({ WRITE_BACK: "true", SLACK_MODE: "dry", OUTPUT_DIR: directory }))(
        TICKET,
      ),
    ).rejects.toThrow("the session fell over");

    const record = JSON.parse(
      await readFile(join(directory, "slack", "SSX-1234.record.json"), "utf8"),
    ) as { crash: unknown };
    expect(record.crash).toMatchObject({ where: "triage", message: "the session fell over" });
  });
});
