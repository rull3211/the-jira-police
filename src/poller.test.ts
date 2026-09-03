import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type PollDeps, runPollCycle } from "./poller.ts";
import type { OutputSink, TriageResult } from "./output/sink.ts";
import type { TicketRef } from "./jira/types.ts";
import { EMPTY_STATE, loadState } from "./state/store.ts";
import type { TriagePayload } from "./triage/runner.ts";

function ticket(key: string, created: string): TicketRef {
  return {
    key,
    summary: `Summary for ${key}`,
    issueTypeId: "10007",
    issueTypeName: "Oppgave",
    created,
    url: `https://example.invalid/browse/${key}`,
  };
}

const PAYLOAD: TriagePayload = {
  verdict: "ready-ish",
  labels: ["dor:pass"],
  recommendedNextStep: "Refine it.",
  report: "## report",
};

class RecordingSink implements OutputSink {
  readonly name = "recording";
  readonly written: TriageResult[] = [];

  async write(result: TriageResult): Promise<void> {
    this.written.push(result);
  }
}

describe("runPollCycle", () => {
  let dir: string;
  let statePath: string;
  let sink: RecordingSink;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "poller-"));
    statePath = join(dir, "state.json");
    sink = new RecordingSink();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function deps(overrides: Partial<PollDeps> = {}): PollDeps {
    return {
      fetchCandidates: async () => [],
      triage: async () => PAYLOAD,
      sink,
      statePath,
      ...overrides,
    };
  }

  it("does nothing when the board is quiet", async () => {
    const outcome = await runPollCycle(EMPTY_STATE, deps());

    expect(outcome).toMatchObject({ found: 0, triaged: 0, failed: 0 });
    expect(sink.written).toHaveLength(0);
  });

  it("triages unseen issues oldest first", async () => {
    const outcome = await runPollCycle(
      EMPTY_STATE,
      deps({
        fetchCandidates: async () => [
          ticket("SSX-2", "2026-09-02T10:05:00Z"),
          ticket("SSX-1", "2026-09-02T10:00:00Z"),
        ],
      }),
    );

    expect(sink.written.map((r) => r.issueKey)).toEqual(["SSX-1", "SSX-2"]);
    expect(outcome.triaged).toBe(2);
    expect(outcome.state.cursor).toBe("2026-09-02T10:05:00Z");
  });

  it("skips issues already handled", async () => {
    // Jira date filters are minute-precision, so the query window deliberately
    // overlaps and re-returns issues; key dedupe is what prevents rework.
    const seen = { cursor: "2026-09-02T10:00:00Z", seenKeys: ["SSX-1"] };

    const outcome = await runPollCycle(
      seen,
      deps({ fetchCandidates: async () => [ticket("SSX-1", "2026-09-02T10:00:00Z")] }),
    );

    expect(outcome).toMatchObject({ found: 1, skipped: 1, triaged: 0 });
    expect(sink.written).toHaveLength(0);
  });

  it("carries the ticket summary into the report", async () => {
    await runPollCycle(
      EMPTY_STATE,
      deps({ fetchCandidates: async () => [ticket("SSX-1", "2026-09-02T10:00:00Z")] }),
    );

    expect(sink.written[0]).toMatchObject({
      issueKey: "SSX-1",
      summary: "Summary for SSX-1",
      verdict: "ready-ish",
      issueUrl: "https://example.invalid/browse/SSX-1",
    });
  });

  it("keeps going when one issue fails", async () => {
    const outcome = await runPollCycle(
      EMPTY_STATE,
      deps({
        fetchCandidates: async () => [
          ticket("SSX-1", "2026-09-02T10:00:00Z"),
          ticket("SSX-2", "2026-09-02T10:05:00Z"),
        ],
        triage: async (t) => {
          if (t.key === "SSX-1") {
            throw new Error("triage blew up");
          }
          return PAYLOAD;
        },
      }),
    );

    expect(outcome).toMatchObject({ triaged: 1, failed: 1 });
    expect(sink.written.map((r) => r.issueKey)).toEqual(["SSX-2"]);
  });

  it("does not advance the cursor past a failed issue", async () => {
    // Advancing to SSX-2 would strand SSX-1 outside the next query window.
    const outcome = await runPollCycle(
      EMPTY_STATE,
      deps({
        fetchCandidates: async () => [
          ticket("SSX-1", "2026-09-02T10:00:00Z"),
          ticket("SSX-2", "2026-09-02T10:05:00Z"),
        ],
        triage: async (t) => {
          if (t.key === "SSX-1") {
            throw new Error("triage blew up");
          }
          return PAYLOAD;
        },
      }),
    );

    expect(outcome.state.cursor).toBeNull();
    expect(outcome.state.seenKeys).toEqual(["SSX-2"]);
  });

  it("never marks an issue seen when writing its report failed", async () => {
    // Otherwise a disk hiccup drops the ticket permanently.
    const failing: OutputSink = {
      name: "failing",
      write: async () => {
        throw new Error("disk full");
      },
    };

    const outcome = await runPollCycle(
      EMPTY_STATE,
      deps({
        fetchCandidates: async () => [ticket("SSX-1", "2026-09-02T10:00:00Z")],
        sink: failing,
      }),
    );

    expect(outcome).toMatchObject({ triaged: 0, failed: 1 });
    expect(outcome.state.seenKeys).toEqual([]);
    expect(outcome.state.cursor).toBeNull();
  });

  it("persists state so a restart does not re-triage", async () => {
    await runPollCycle(
      EMPTY_STATE,
      deps({ fetchCandidates: async () => [ticket("SSX-1", "2026-09-02T10:00:00Z")] }),
    );

    await expect(loadState(statePath)).resolves.toEqual({
      cursor: "2026-09-02T10:00:00Z",
      seenKeys: ["SSX-1"],
    });
  });

  it("does not touch the state file on a quiet cycle", async () => {
    await runPollCycle(EMPTY_STATE, deps());

    await expect(loadState(statePath)).resolves.toEqual(EMPTY_STATE);
  });

  /**
   * Each triage is a paid model run. Deferring the record of one until the
   * whole cycle finishes means an ill-timed kill buys the same verdict twice.
   */
  describe("durability between issues", () => {
    it("persists after every issue, not once at the end", async () => {
      const seenAtEachStep: (readonly string[])[] = [];

      await runPollCycle(
        EMPTY_STATE,
        deps({
          fetchCandidates: async () => [
            ticket("SSX-1", "2026-09-02T10:00:00Z"),
            ticket("SSX-2", "2026-09-02T10:05:00Z"),
            ticket("SSX-3", "2026-09-02T10:10:00Z"),
          ],
          // Observed from inside the loop: what is already durable on disk by
          // the time the next issue starts.
          triage: async () => {
            seenAtEachStep.push((await loadState(statePath).catch(() => EMPTY_STATE)).seenKeys);
            return PAYLOAD;
          },
        }),
      );

      expect(seenAtEachStep).toEqual([[], ["SSX-1"], ["SSX-1", "SSX-2"]]);
    });

    it("has the cursor durable too, not just the key", async () => {
      // Keys alone would stop the re-triage but leave the window re-scanning
      // from the old cursor on every subsequent run.
      let midCycle = EMPTY_STATE;

      await runPollCycle(
        EMPTY_STATE,
        deps({
          fetchCandidates: async () => [
            ticket("SSX-1", "2026-09-02T10:00:00Z"),
            ticket("SSX-2", "2026-09-02T10:05:00Z"),
          ],
          triage: async (t) => {
            if (t.key === "SSX-2") {
              midCycle = await loadState(statePath);
            }
            return PAYLOAD;
          },
        }),
      );

      expect(midCycle).toEqual({ cursor: "2026-09-02T10:00:00Z", seenKeys: ["SSX-1"] });
    });
  });

  /**
   * A cycle runs one paid subprocess per issue, sequentially. Checking for
   * shutdown only between cycles would mean an operator's stop request is
   * followed by the rest of the backlog.
   */
  describe("shutdown between issues", () => {
    function abortingDeps(controller: AbortController, abortAfter: string) {
      const attempted: string[] = [];
      return {
        attempted,
        deps: deps({
          signal: controller.signal,
          fetchCandidates: async () => [
            ticket("SSX-1", "2026-09-02T10:00:00Z"),
            ticket("SSX-2", "2026-09-02T10:05:00Z"),
            ticket("SSX-3", "2026-09-02T10:10:00Z"),
          ],
          triage: async (t) => {
            attempted.push(t.key);
            if (t.key === abortAfter) {
              controller.abort();
            }
            return PAYLOAD;
          },
        }),
      };
    }

    it("stops after the issue in flight rather than finishing the backlog", async () => {
      const controller = new AbortController();
      const { attempted, deps: aborting } = abortingDeps(controller, "SSX-1");

      const outcome = await runPollCycle(EMPTY_STATE, aborting);

      expect(attempted).toEqual(["SSX-1"]);
      expect(outcome).toMatchObject({ triaged: 1, failed: 0, abandoned: 2 });
    });

    it("finishes the issue in flight rather than discarding it", async () => {
      // Abandoning paid work already in progress would be worse than the wait.
      const controller = new AbortController();
      const { deps: aborting } = abortingDeps(controller, "SSX-1");

      await runPollCycle(EMPTY_STATE, aborting);

      expect(sink.written.map((r) => r.issueKey)).toEqual(["SSX-1"]);
      await expect(loadState(statePath)).resolves.toEqual({
        cursor: "2026-09-02T10:00:00Z",
        seenKeys: ["SSX-1"],
      });
    });

    it("leaves the abandoned issues unseen, so the next cycle takes them", async () => {
      const controller = new AbortController();
      const { deps: aborting } = abortingDeps(controller, "SSX-2");

      const outcome = await runPollCycle(EMPTY_STATE, aborting);

      expect(outcome.state.seenKeys).toEqual(["SSX-1", "SSX-2"]);
      expect(outcome.abandoned).toBe(1);
    });

    it("attempts nothing when shutdown was requested before the cycle began", async () => {
      const controller = new AbortController();
      controller.abort();
      const { attempted, deps: aborting } = abortingDeps(controller, "never");

      const outcome = await runPollCycle(EMPTY_STATE, aborting);

      expect(attempted).toEqual([]);
      expect(outcome).toMatchObject({ found: 3, triaged: 0, abandoned: 3 });
    });

    it("runs the whole backlog when no signal is supplied", async () => {
      // The one-shot CLI passes none; it must not be treated as aborted.
      const outcome = await runPollCycle(
        EMPTY_STATE,
        deps({
          fetchCandidates: async () => [
            ticket("SSX-1", "2026-09-02T10:00:00Z"),
            ticket("SSX-2", "2026-09-02T10:05:00Z"),
          ],
        }),
      );

      expect(outcome).toMatchObject({ triaged: 2, abandoned: 0 });
    });
  });

  it("passes the cursor to the query", async () => {
    const fetchCandidates = vi.fn(async () => []);
    const state = { cursor: "2026-09-02T09:00:00Z", seenKeys: [] };

    await runPollCycle(state, deps({ fetchCandidates }));

    expect(fetchCandidates).toHaveBeenCalledWith("2026-09-02T09:00:00Z");
  });

  /**
   * Jira does not return `Z`. It returns the site's local offset —
   * `2026-09-02T09:55:34.178+0200`, verified against the live SSX board — and
   * that offset changes at the DST boundary. Ordering these as strings is
   * wrong, and wrong here means a dropped ticket.
   */
  describe("ordering across a DST change", () => {
    // 2026-10-25 is when Norway falls back from +0200 to +0100.
    const EARLIER = ticket("SSX-2", "2026-10-25T02:30:00.000+0200"); // 00:30Z
    const LATER = ticket("SSX-1", "2026-10-25T02:00:00.000+0100"); // 01:00Z

    it("orders by instant, not by the printed string", async () => {
      await runPollCycle(EMPTY_STATE, deps({ fetchCandidates: async () => [LATER, EARLIER] }));

      // Lexicographically "02:00…+0100" < "02:30…+0200", so a string sort
      // would process SSX-1 first. Chronologically SSX-2 comes first.
      expect(sink.written.map((r) => r.issueKey)).toEqual(["SSX-2", "SSX-1"]);
    });

    it("leaves the cursor at the latest instant, not the largest string", async () => {
      await runPollCycle(EMPTY_STATE, deps({ fetchCandidates: async () => [LATER, EARLIER] }));

      const state = await loadState(statePath);
      expect(state.cursor).toBe("2026-10-25T02:00:00.000+0100");
    });
  });

  it("orders equal timestamps deterministically, so a resume point is stable", async () => {
    const same = "2026-09-02T10:00:00.000+0200";
    const candidates = [ticket("SSX-3", same), ticket("SSX-1", same), ticket("SSX-2", same)];

    await runPollCycle(EMPTY_STATE, deps({ fetchCandidates: async () => candidates }));

    expect(sink.written.map((r) => r.issueKey)).toEqual(["SSX-1", "SSX-2", "SSX-3"]);
  });

  it("refuses to guess at an unparseable timestamp", async () => {
    const candidates = [ticket("SSX-1", "2026-09-02T10:00:00.000+0200"), ticket("SSX-2", "soon")];

    await expect(
      runPollCycle(EMPTY_STATE, deps({ fetchCandidates: async () => candidates })),
    ).rejects.toThrow(/SSX-2 has an unparseable created timestamp/);
  });
});
