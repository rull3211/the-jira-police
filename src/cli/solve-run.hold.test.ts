/**
 * `solve-run.ts` on a ticket a person has labelled `agent:ignore`, as far as a run goes without a repository.
 * Separate from `solve-run.test.ts` because `solveWithRetry` is mocked here, and `vi.mock` applies to a whole file.
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JiraClient } from "../jira/client.ts";
import type { TicketRef } from "../jira/types.ts";
import { createLogger } from "../logger.ts";
import { readSettings } from "../settings.ts";
import { createAttemptLedger } from "../solve/attempts.ts";
import { TicketHeldError } from "../solve/hold.ts";
import { AGENT_LABELS } from "../solve/labels.ts";
import type { SolveDependencies } from "../solve/orchestrator.ts";
import type { SolveDeps } from "../solve/poller.ts";
import type { CommandRunner } from "../solve/worktree.ts";

const solveWithRetry = vi.hoisted(() => vi.fn());

vi.mock("../solve/orchestrator.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../solve/orchestrator.ts")>()),
  solveWithRetry,
}));

const { runAdvance, runReviewSweep, runSolveClaims, runWriteRungs } =
  await import("./solve-run.ts");

const REPO_LABEL = "svc:allowed-repo";

/** Labels per ticket, as Jira has them right now, read by the claim, the gate and the ticket reader alike. */
let board: Map<string, string[]>;

function labelsOf(key: string): string[] {
  return board.get(key) ?? [];
}

/** The writes a run made to the board, in order. */
let writes: string[];

function client(): JiraClient {
  return {
    fetchDetail: async (key: string) => ({
      key,
      summary: "Cache",
      issueTypeName: "Feil",
      status: "Prioritized",
      labels: [...labelsOf(key)],
      description: undefined,
      comments: [],
      attachments: [],
      url: `https://example.invalid/browse/${key}`,
    }),
    updateLabels: async (
      key: string,
      change: { readonly add?: readonly string[]; readonly remove?: readonly string[] },
    ) => {
      const add = change.add ?? [];
      const remove = change.remove ?? [];
      writes.push(`${key} labels +${add.join(",")} -${remove.join(",")}`);
      board.set(key, [...labelsOf(key).filter((label) => !remove.includes(label)), ...add]);
    },
    moveToInProgress: async () => {
      writes.push("status in");
      return { outcome: "moved", from: "Prioritized" };
    },
    moveBackFromInProgress: async () => {
      writes.push("status back");
      return { outcome: "moved", from: "Under arbeid" };
    },
    search: async () => [],
  } as unknown as JiraClient;
}

/** The gate and the dry audit thread both go to Jira; this is the one answer it gives, and a 404 for anything else. */
function stubJira(): void {
  vi.stubGlobal("fetch", async (url: string | URL) => {
    const asked = String(url);
    const key = /issue\/([A-Z]+-\d+)\?fields=labels/u.exec(asked)?.[1];
    return key === undefined
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify({ key, fields: { labels: labelsOf(key) } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
  });
}

function settingsIn(directory: string, overrides: Partial<Record<string, string>> = {}) {
  return readSettings({
    JIRA_EMAIL: "a@b.c",
    JIRA_AUTH: "placeholder",
    VAULT_PATH: "/vault",
    SOLVE_REPO_ROOT: "/nonexistent",
    SOLVE_REPOS: "allowed-repo",
    SOLVE_GITHUB_OWNER: "acme",
    SOLVE_ENABLED: "true",
    OUTPUT_DIR: directory,
    ...overrides,
  });
}

/** A ticket a run can claim in manual mode: triage's call, a person's go-ahead, and a repository it may touch. */
const CLAIMABLE = [AGENT_LABELS.solvable, AGENT_LABELS.start, REPO_LABEL];

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "solve-run-hold-"));
  board = new Map();
  writes = [];
  solveWithRetry.mockReset();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

const exitCode = process.exitCode;
afterEach(() => {
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The crash the dry audit thread recorded for the ticket: `null` when it recorded none, `"no record"` when it wrote nothing at all. */
function recordedCrash(key: string): unknown {
  const file = join(directory, "slack", `${key}.record.json`);
  return existsSync(file)
    ? ((JSON.parse(readFileSync(file, "utf8")) as { crash: unknown }).crash ?? null)
    : "no record";
}

const held = () => new TicketHeldError("SSX-1", "after the fix pass");

describe("runWriteRungs when the ticket is held mid-solve", () => {
  it("rethrows the hold and releases the claim, which is its own bookkeeping and not work", async () => {
    stubJira();
    board.set("SSX-1", [...CLAIMABLE]);
    solveWithRetry.mockRejectedValue(held());

    await expect(
      runWriteRungs(settingsIn(directory), client(), "SSX-1", "solve", null, "manual", false),
    ).rejects.toBeInstanceOf(TicketHeldError);

    // Claimed, moved in, and then put back exactly as found: `agent:start` restored, the status returned.
    expect(writes).toEqual([
      `SSX-1 labels +${AGENT_LABELS.solving} -${AGENT_LABELS.start}`,
      "status in",
      `SSX-1 labels +${AGENT_LABELS.start} -${AGENT_LABELS.solving}`,
      "status back",
    ]);
  });

  it("leaves the person's label on the ticket when it releases the claim", async () => {
    // The release writes a delta, so a label that arrived during the run is a bystander and not part of the restore point.
    stubJira();
    board.set("SSX-1", [...CLAIMABLE]);
    solveWithRetry.mockImplementation(async () => {
      board.set("SSX-1", [...labelsOf("SSX-1"), AGENT_LABELS.ignore]);
      throw held();
    });

    await expect(
      runWriteRungs(settingsIn(directory), client(), "SSX-1", "solve", null, "manual", false),
    ).rejects.toBeInstanceOf(TicketHeldError);

    expect(labelsOf("SSX-1")).toContain(AGENT_LABELS.ignore);
    expect(labelsOf("SSX-1")).not.toContain(AGENT_LABELS.solving);
  });

  it("says nothing on the ticket's audit thread, where a crash would", async () => {
    stubJira();
    board.set("SSX-1", [...CLAIMABLE]);
    solveWithRetry.mockRejectedValue(held());

    await expect(
      runWriteRungs(
        settingsIn(directory, { SLACK_MODE: "dry" }),
        client(),
        "SSX-1",
        "solve",
        null,
        "manual",
        false,
      ),
    ).rejects.toBeInstanceOf(TicketHeldError);

    // Unplug the early rethrow in `runWriteRungs` and the thread records a crash. `null` and not
    // "no record": the claim was posted, so the thread exists, and it holds no crash.
    expect(recordedCrash("SSX-1")).toBeNull();
  });

  it("does say so when an ordinary failure ends the run", async () => {
    // The control: the audit thread is wired and does record a crash, so its silence above means something.
    stubJira();
    board.set("SSX-1", [...CLAIMABLE]);
    solveWithRetry.mockRejectedValue(new Error("the session fell over"));

    await expect(
      runWriteRungs(
        settingsIn(directory, { SLACK_MODE: "dry" }),
        client(),
        "SSX-1",
        "solve",
        null,
        "manual",
        false,
      ),
    ).rejects.toThrow("the session fell over");

    expect(recordedCrash("SSX-1")).toMatchObject({
      where: "solve",
      message: "the session fell over",
    });
  });
});

describe("runSolveClaims when a ticket is held", () => {
  function queueOf(...keys: readonly string[]): SolveDeps {
    return {
      enabled: true,
      mode: "manual",
      allowedRepos: ["allowed-repo"],
      maxConcurrent: 5,
      fetchQueue: async () =>
        keys.map((key) => ({
          key,
          summary: "Cache",
          url: `https://example.invalid/browse/${key}`,
          labels: [...CLAIMABLE],
          updated: "2026-09-05T09:00:00Z",
        })),
      countInFlight: async () => 0,
    };
  }

  it("logs a drop as information, not as a failed claim, and carries on to the next ticket", async () => {
    stubJira();
    board.set("SSX-1", [...CLAIMABLE]);
    board.set("SSX-2", [...CLAIMABLE]);
    solveWithRetry.mockImplementation(
      async (_deps: SolveDependencies, request: { issueKey: string }) => {
        throw new TicketHeldError(request.issueKey, "after the fix pass");
      },
    );
    const info = vi.spyOn(createLogger("solve"), "info");
    const error = vi.spyOn(createLogger("solve"), "error");

    const outcome = await runSolveClaims(
      settingsIn(directory),
      queueOf("SSX-1", "SSX-2"),
      client(),
      createAttemptLedger(3),
      false,
    );

    // Both were reached: the first drop did not end the tick.
    expect(solveWithRetry).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenCalledWith("solve.claim.dropped", {
      key: "SSX-1",
      where: "after the fix pass",
    });
    expect(info).toHaveBeenCalledWith("solve.claim.dropped", {
      key: "SSX-2",
      where: "after the fix pass",
    });
    expect(error).not.toHaveBeenCalledWith("solve.claim.failed", expect.anything());
    expect(outcome).toMatchObject({ started: 0 });
  });

  it("still logs an ordinary failure as one", async () => {
    stubJira();
    board.set("SSX-1", [...CLAIMABLE]);
    solveWithRetry.mockRejectedValue(new Error("the session fell over"));
    const error = vi.spyOn(createLogger("solve"), "error");

    await runSolveClaims(
      settingsIn(directory),
      queueOf("SSX-1"),
      client(),
      createAttemptLedger(3),
      false,
    );

    expect(error).toHaveBeenCalledWith(
      "solve.claim.failed",
      expect.objectContaining({ key: "SSX-1" }),
    );
  });
});

const WATCHED: TicketRef = {
  key: "SSX-3",
  summary: "Cache",
  issueTypeId: "10007",
  issueTypeName: "Feil",
  created: "2026-09-02T09:55:34.178+0200",
  updated: "2026-09-05T09:00:00.000+0200",
  statusId: "10165",
  statusName: "Under arbeid",
  labels: [AGENT_LABELS.reviewing],
  url: "https://example.invalid/browse/SSX-3",
};

/** Deps whose `gh` answers "no pull request" and records every call, and whose passes must never run. */
function sweepHarness(): { readonly runDeps: SolveDependencies; readonly ran: string[][] } {
  const ran: string[][] = [];
  const commands: CommandRunner = {
    run: async (argv) => {
      ran.push([...argv]);
      return { exitCode: 1, stdout: "", stderr: "no pull request", timedOut: false };
    },
  };
  return {
    ran,
    runDeps: {
      commands,
      passes: {
        run: () => {
          throw new Error("a pass ran on a ticket the sweep should not have looked at");
        },
      },
      gate: async () => true,
    },
  };
}

describe("runReviewSweep when a ticket is held", () => {
  const watching = (): JiraClient =>
    ({ ...client(), search: async () => [WATCHED] }) as unknown as JiraClient;

  it("reports it unlooked, with the reason, and reads nothing from GitHub", async () => {
    // Unplug the check in `createReviewLook` and the survey runs: `gh` is called, and the survey can undraft.
    board.set("SSX-3", [AGENT_LABELS.reviewing, REPO_LABEL, AGENT_LABELS.ignore]);
    const { runDeps, ran } = sweepHarness();

    const outcome = await runReviewSweep(settingsIn(directory), watching(), runDeps, null, false);

    expect(outcome.unlooked).toEqual([
      {
        issueKey: "SSX-3",
        reason: expect.stringContaining("is held at looking at the pull request"),
      },
    ]);
    expect(ran).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("holds on the label as it is typed by hand", async () => {
    board.set("SSX-3", [AGENT_LABELS.reviewing, REPO_LABEL, "Agent:Ignore"]);
    const { runDeps, ran } = sweepHarness();

    const outcome = await runReviewSweep(settingsIn(directory), watching(), runDeps, null, false);

    expect(outcome.unlooked).toHaveLength(1);
    expect(ran).toEqual([]);
  });

  it("looks at the pull request when nothing holds the ticket", async () => {
    // The control: the same ticket without the label reaches GitHub, so the silence above is the check and nothing else.
    board.set("SSX-3", [AGENT_LABELS.reviewing, REPO_LABEL]);
    const { runDeps, ran } = sweepHarness();

    await runReviewSweep(settingsIn(directory), watching(), runDeps, null, false);

    expect(ran.length).toBeGreaterThan(0);
  });
});

describe("runAdvance on a held ticket", () => {
  it("refuses, says why, and writes nothing", async () => {
    board.set("SSX-3", [AGENT_LABELS.reviewing, REPO_LABEL, AGENT_LABELS.ignore]);
    const stderr = vi.spyOn(process.stderr, "write");

    const outcome = await runAdvance(settingsIn(directory), client(), "SSX-3", false);

    expect(outcome).toBeNull();
    expect(process.exitCode).toBe(3);
    expect(stderr.mock.calls.map(([text]) => String(text)).join("")).toContain("agent:ignore");
    expect(writes).toEqual([]);
  });
});
