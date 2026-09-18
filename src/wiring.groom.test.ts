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

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TicketRef } from "./jira/types.ts";
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
    commentBody: `## Triage of SSX-1234\n\nGaps remain.\n\n${FOOTER_SENTINEL}`,
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

beforeEach(() => {
  runTriage.mockReset();
  runPost.mockReset();
  runPost.mockResolvedValue({
    commentAction: "created",
    labelsWritten: [],
    linksCreated: [],
    problems: [],
  });
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

  it("keeps the footer sentinel last, so a re-run still updates in place", async () => {
    // The poster identifies its own previous comment by this trailing line; splicing the note after it would duplicate on every re-run.
    runTriage.mockResolvedValue(readyish());
    await createGroom(on())(TICKET);

    const posted = runPost.mock.calls[0]?.[0]?.mutation.commentBody ?? "";

    expect(posted.trimEnd().endsWith(FOOTER_SENTINEL)).toBe(true);
    expect(posted.split(FOOTER_SENTINEL)).toHaveLength(2);
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
