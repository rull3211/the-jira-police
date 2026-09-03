/**
 * Tests the composition itself: analyse → gate → post.
 *
 * Separate from `wiring.test.ts` because it mocks the two subprocess runners,
 * and `vi.mock` applies to a whole file. The distinction is worth the extra
 * file: everything here is about the ORDER and the CONDITIONS, which is the
 * part that was wrong before the split and the part unit tests of the pieces
 * cannot see.
 *
 * Written after a mutation escaped. Deleting `assertPostable` from `createGroom`
 * left all 264 tests green — the gate was fully tested in isolation and called
 * by nothing that anything asserted on. That is the second time this exact
 * shape of bug has appeared in this service, so the rule it implies is worth
 * stating: a guard is not shipped until a test fails when it is unplugged.
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
      confidence: "low",
      repo: "",
      rationale: "Needs a human.",
      blockers: ["no reproduction steps"],
    },
    ...overrides,
  };
}

/**
 * A scratch OUTPUT_DIR shared by every test that does not name its own.
 *
 * `createGroom` writes a rejection file when the gate refuses, so the refusal
 * tests below have a filesystem side effect. Left on the default `groomed/`
 * they would write `SSX-1234.rejected.md` into the repo on every `pnpm test` —
 * which is how a fixture ends up committed by accident.
 */
const SCRATCH = await mkdtemp(join(tmpdir(), "groom-"));

/**
 * An accepted ticket — the only kind that gets an agent-fitness note.
 *
 * `solvable: false` with a populated `blockers` list is the interesting shape,
 * not an edge case: it is what the first two live runs on SSX-3822 actually
 * produced, and it is the case the note exists to serve, since the blockers are
 * a to-do list a human can often clear cheaply.
 */
function readyish(overrides: Partial<TriagePayload> = {}): TriagePayload {
  return payload({
    verdict: "ready-ish",
    labels: ["dor:pass", "route:ours"],
    mutation: mutation({ labelsAdd: ["dor:pass"], labelsRemove: ["dor:gaps"] }),
    agentFitness: {
      solvable: false,
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
    // The local report is still worth having, and `parsePayload` already
    // refuses the contradiction this gate exists for. Applying the posting
    // rules to a run that posts nothing would fail tickets for no benefit.
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
    // The property the whole design rests on: the thing checked is the thing
    // posted. If these two could differ, the gate would be checking a draft.
    //
    // This fixture is `needs-info`, which is below the threshold for the
    // fitness note, so the mutation genuinely passes through untouched. The
    // ready-ish case — where the note IS spliced in — is covered below, and
    // the same property holds there because the splice happens before the gate.
    const result = payload();
    runTriage.mockResolvedValue(result);
    await createGroom(on())(TICKET);

    expect(runPost.mock.calls[0]?.[0]).toMatchObject({
      issueKey: "SSX-1234",
      mutation: result.mutation,
    });
  });

  it("posts the agent-fitness note on a ready-ish ticket", async () => {
    // MUTATION TEST. Unplug `withFitnessNote` in `createGroom` and this fails.
    // Without it the blockers stay in a gitignored local file, so the one
    // audience who can actually clear them — the reporter and the Trio — never
    // sees the list.
    runTriage.mockResolvedValue(readyish());
    await createGroom(on())(TICKET);

    const posted = runPost.mock.calls[0]?.[0]?.mutation.commentBody ?? "";

    expect(posted).toContain("🤖 **Agent fitness:**");
    expect(posted).toContain("* needs a real .ico asset");
    expect(posted).toContain("`buy-insurance-advisor-web`");
  });

  it("keeps the footer sentinel last, so a re-run still updates in place", async () => {
    // The poster identifies its own previous comment by that exact trailing
    // line. Splice the note after it and every re-run posts a duplicate.
    runTriage.mockResolvedValue(readyish());
    await createGroom(on())(TICKET);

    const posted = runPost.mock.calls[0]?.[0]?.mutation.commentBody ?? "";

    expect(posted.trimEnd().endsWith(FOOTER_SENTINEL)).toBe(true);
    expect(posted.split(FOOTER_SENTINEL)).toHaveLength(2);
  });

  it("gates the body it will actually post, not the draft before the splice", async () => {
    // The note is added before `assertPostable` runs, so the checked text and
    // the sent text are the same string. Asserting it the other way round —
    // that the analyst's original body is NOT what got posted — is what makes
    // this distinct from the test above.
    const original = readyish();
    runTriage.mockResolvedValue(original);
    await createGroom(on())(TICKET);

    const posted = runPost.mock.calls[0]?.[0]?.mutation.commentBody ?? "";

    expect(posted).not.toBe(original.mutation.commentBody);
    expect(posted).toContain("Gaps remain.");
  });

  it("REFUSES to post when the gate objects", async () => {
    // The mutation test this file was written for. Unplug `assertPostable`
    // from `createGroom` and this is what fails.
    runTriage.mockResolvedValue(payload({ mutation: mutation({ component: "Nonsense" }) }));

    await expect(createGroom(on())(TICKET)).rejects.toThrow(/refusing to post/);
    expect(runPost).not.toHaveBeenCalled();
  });

  it("refuses the SSX-3822 contradiction before anything reaches the board", async () => {
    // The incident that caused all of this. Under the old single-run design the
    // comment was already posted by the time the payload could be inspected;
    // here the refusal happens with the poster still un-dispatched.
    runTriage.mockResolvedValue(
      payload({
        verdict: "ready-ish",
        labels: ["dor:pass", "route:ours"],
        dorPlaceholders: ["[N]"],
        mutation: mutation({ labelsAdd: ["dor:pass"] }),
      }),
    );

    await expect(createGroom(on())(TICKET)).rejects.toThrow(/dor:pass only if 1-9 hold/);
    expect(runPost).not.toHaveBeenCalled();
  });

  it("gates BEFORE posting, not after", async () => {
    // Ordering is the entire fix, so it is asserted directly rather than
    // inferred from the absence of a call.
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
    // Without this the gate destroys the one artifact needed to tell a correct
    // refusal from a false positive — the comment body it objected to. Uses a
    // real temp directory rather than a mock: the thing being tested is that a
    // file an operator can open ends up on disk.
    const directory = await mkdtemp(join(tmpdir(), "groom-reject-"));
    runTriage.mockResolvedValue(
      payload({ dorPlaceholders: ["[N]"], mutation: mutation({ component: "Nonsense" }) }),
    );

    await expect(
      createGroom(settings({ WRITE_BACK: "true", OUTPUT_DIR: directory }))(TICKET),
    ).rejects.toThrow();

    const written = await readFile(join(directory, "SSX-1234.rejected.md"), "utf8");
    expect(written).toContain("Nonsense");
    expect(written).toContain("[N]");
    // The body itself, which is the evidence the whole file exists to preserve.
    expect(written).toContain("Gaps remain.");
  });

  it("writes no rejection file when the gate is content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "groom-ok-"));
    runTriage.mockResolvedValue(payload());

    await createGroom(settings({ WRITE_BACK: "true", OUTPUT_DIR: directory }))(TICKET);

    await expect(readFile(join(directory, "SSX-1234.rejected.md"), "utf8")).rejects.toThrow();
  });

  it("clears a superseded rejection once a later run passes the gate", async () => {
    // Observed on SSX-3822: a refusal file sat next to the successful report
    // for the same key, so the directory claimed both that the ticket had been
    // groomed and that it had been refused.
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
    // The analyst is never re-armed. Posting is a separate session with a
    // separate allowlist; this run could not write if it decided to.
    runTriage.mockResolvedValue(payload());
    await createGroom(on())(TICKET);

    expect(runTriage.mock.calls[0]?.[0]).not.toHaveProperty("noWrite", false);
  });
});
