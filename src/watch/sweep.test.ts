import { describe, expect, it } from "vitest";

import type { IssueActivity, JiraClient } from "../jira/client.ts";
import type { OutputSink } from "../output/sink.ts";
import type { TicketCommenter } from "../solve/feedback.ts";
import { TicketHeldError } from "../solve/hold.ts";
import { FOOTER_TEXT } from "./decide.ts";
import { createWatchMemo } from "./memo.ts";
import type { Relevance, RelevanceChecker } from "./relevance.ts";
import type { RetriageDeps } from "./retriage.ts";
import { type WatchActing, type WatchSweepDeps, runWatchSweep } from "./sweep.ts";

const OURS_AT = "2026-09-01T10:00:00.000+0200";
const THEIRS_AT = "2026-09-02T10:00:00.000+0200";

function adf(text: string): unknown {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

/** A watched ticket somebody has answered: our comment first, then their reply. */
function answered(key: string): IssueActivity {
  return {
    key,
    statusCategoryKey: "new",
    labels: ["agent:watching"],
    comments: [
      {
        id: "1",
        author: "bot",
        created: OURS_AT,
        updated: OURS_AT,
        body: adf(`Send back: add a baseline. ${FOOTER_TEXT}`),
      },
      {
        id: "2",
        author: "reporter",
        created: THEIRS_AT,
        updated: THEIRS_AT,
        body: adf("Baseline added: 42% of carts."),
      },
    ],
    changes: [],
    content: {
      summary: "Carts fail",
      description: adf("Baseline: 42% of carts."),
      environment: null,
      attachments: [],
    },
  };
}

const COMMENTER: TicketCommenter = {
  comment: async () => {},
};

const SINK: OutputSink = {
  name: "test",
  write: async () => {},
};

interface Harness {
  readonly deps: WatchSweepDeps;
  readonly checked: string[];
  readonly lines: string[];
}

/**
 * A sweep wired to fakes, with the paid call counted. `answer` returning
 * `null` makes the check throw, since the sweep swallows a re-triage failure —
 * `checked` is what actually proves nothing paid ran.
 */
function harness(options: {
  readonly memo: WatchSweepDeps["memo"];
  readonly answer: (key: string) => Relevance | null;
  readonly acting?: boolean;
}): Harness {
  const checked: string[] = [];
  const lines: string[] = [];

  const checker: RelevanceChecker = {
    check: async (input) => {
      checked.push(input.key);
      const answer = options.answer(input.key);
      if (answer === null) {
        throw new Error(`nothing should have been checked for ${input.key}`);
      }
      return answer;
    },
  };

  const acting: WatchActing = {
    commenter: COMMENTER,
    sink: SINK,
    retriage: {
      client: { updateLabels: async () => {} } as unknown as Pick<JiraClient, "updateLabels">,
      checker,
      groom: async () => {
        throw new Error("no test here gets as far as a triage run");
      },
      baseUrl: "https://example.atlassian.net",
    } satisfies RetriageDeps,
  };

  return {
    checked,
    lines,
    deps: {
      client: {
        fetchActivity: async (key: string) => answered(key),
      } as unknown as Pick<JiraClient, "fetchActivity">,
      maxRetriage: 3,
      memo: options.memo,
      acting: options.acting === false ? null : acting,
      report: (line) => lines.push(line),
    },
  };
}

describe("what the sweep pays for", () => {
  it("asks the memo before it asks the model", async () => {
    // A memo check placed after `runRetriage` would leave the same outcome
    // counts, having already bought the answer it exists to avoid.
    const memo = { seen: () => true, declined: () => {}, size: () => 0 };
    const { deps, checked } = harness({ memo, answer: () => null });

    const outcome = await runWatchSweep(deps, ["SSX-1234"]);

    expect(checked).toEqual([]);
    expect(outcome.skipped).toBe(1);
    expect(outcome.failed).toBe(0);
    expect(outcome.retriaged).toBe(0);
  });

  it("remembers a refusal, so the second sweep over the same activity is free", async () => {
    // A `no` writes nothing to the ticket, so without `memo.declined` the same
    // trigger would be bought again on every sweep for as long as it's subscribed.
    const memo = createWatchMemo();
    const { deps, checked } = harness({
      memo,
      answer: () => ({ answers: false, reason: "a rank drag, not an answer" }),
    });

    const first = await runWatchSweep(deps, ["SSX-1234"]);
    const second = await runWatchSweep(deps, ["SSX-1234"]);

    expect(checked).toEqual(["SSX-1234"]);
    expect(first.skipped).toBe(0);
    expect(second.skipped).toBe(1);
    expect(memo.size()).toBe(1);
  });

  it("keeps sweeping after one ticket's re-triage throws", async () => {
    // Giving up on the first bad ticket would hide every ticket behind it.
    const memo = createWatchMemo();
    const { deps, checked } = harness({
      memo,
      answer: (key) =>
        key === "SSX-1111" ? null : { answers: false, reason: "somebody groomed the board" },
    });

    const outcome = await runWatchSweep(deps, ["SSX-1111", "SSX-2222"]);

    expect(checked).toEqual(["SSX-1111", "SSX-2222"]);
    expect(outcome.looked).toBe(2);
    expect(outcome.failed).toBe(1);
    // The ticket that threw is not remembered as declined — recording one
    // would make a transient failure permanent silence.
    expect(memo.size()).toBe(1);
  });

  it("cannot spend at all without an acting half", async () => {
    // A dry run holds no writer and no checker; the memo is untouched too, since
    // a look that was never going to cost anything must not count as judged.
    const memo = createWatchMemo();
    const { deps, checked } = harness({ memo, answer: () => null, acting: false });

    const outcome = await runWatchSweep(deps, ["SSX-1234"]);

    expect(checked).toEqual([]);
    expect(memo.size()).toBe(0);
    expect(outcome.retriage).toBe(1);
    expect(outcome.skipped).toBe(0);
    expect(outcome.retriaged).toBe(0);
  });
});

describe("a watched ticket a person has labelled agent:ignore", () => {
  /** The harness, with the board saying what the test needs it to say about one ticket and a spy on every write. */
  function held(
    activity: (key: string) => IssueActivity,
    options: { readonly groom?: RetriageDeps["groom"]; readonly answers?: boolean } = {},
  ) {
    const labelWrites: string[] = [];
    const comments: string[] = [];
    const base = harness({
      memo: createWatchMemo(),
      answer: () => (options.answers === true ? { answers: true, reason: "a baseline" } : null),
    });
    const acting = base.deps.acting;
    if (acting === null) {
      throw new Error("the harness is meant to act");
    }
    return {
      ...base,
      labelWrites,
      comments,
      deps: {
        ...base.deps,
        client: { fetchActivity: async (key: string) => activity(key) } as unknown as Pick<
          JiraClient,
          "fetchActivity"
        >,
        acting: {
          ...acting,
          commenter: { comment: async (_key: string, body: string) => void comments.push(body) },
          retriage: {
            ...acting.retriage,
            client: {
              updateLabels: async (key: string) => void labelWrites.push(key),
            } as unknown as Pick<JiraClient, "updateLabels">,
            ...(options.groom === undefined ? {} : { groom: options.groom }),
          },
        },
      } satisfies WatchSweepDeps,
    };
  }

  const ignored = (key: string): IssueActivity => ({
    ...answered(key),
    labels: ["agent:watching", "agent:ignore"],
  });

  it("is not re-triaged, and the paid relevance check is not bought", async () => {
    const { deps, checked, labelWrites } = held(ignored);

    const outcome = await runWatchSweep(deps, ["SSX-1234"]);

    // Unplug the check after the look and the model is asked about a ticket a person said to leave.
    expect(checked).toEqual([]);
    expect(labelWrites).toEqual([]);
    expect(outcome).toMatchObject({ held: 1, retriage: 0, failed: 0, retriaged: 0 });
  });

  it("is not unsubscribed or commented on when it closes, which is a write too", async () => {
    const { deps, labelWrites, comments } = held((key) => ({
      ...ignored(key),
      statusCategoryKey: "done",
    }));

    const outcome = await runWatchSweep(deps, ["SSX-1234"]);

    expect(labelWrites).toEqual([]);
    expect(comments).toEqual([]);
    expect(outcome).toMatchObject({ held: 1, unsubscribe: 0, ended: 0 });
  });

  it("is unsubscribed when it closes and nothing holds it", async () => {
    // The control: the same closed ticket without the label is ended, so the silence above is the check.
    const { deps, labelWrites } = held((key) => ({ ...answered(key), statusCategoryKey: "done" }));

    const outcome = await runWatchSweep(deps, ["SSX-1234"]);

    expect(labelWrites).toEqual(["SSX-1234"]);
    expect(outcome).toMatchObject({ held: 0, ended: 1 });
  });

  it("goes on to the next ticket", async () => {
    const { deps, checked } = held((key) => (key === "SSX-1111" ? ignored(key) : answered(key)), {
      answers: true,
      groom: async () => {
        throw new Error("no test here gets as far as a triage run");
      },
    });

    const outcome = await runWatchSweep(deps, ["SSX-1111", "SSX-2222"]);

    expect(checked).toEqual(["SSX-2222"]);
    expect(outcome.held).toBe(1);
  });

  it("is counted as held, not failed, when the label arrives after the look and the triage refuses to start", async () => {
    const { deps } = held(answered, {
      answers: true,
      groom: async () => {
        throw new TicketHeldError("SSX-1234", "starting triage");
      },
    });

    const outcome = await runWatchSweep(deps, ["SSX-1234"]);

    expect(outcome).toMatchObject({ held: 1, failed: 0 });
  });

  it("still counts an ordinary triage failure as one", async () => {
    const { deps } = held(answered, {
      answers: true,
      groom: async () => {
        throw new Error("the session fell over");
      },
    });

    const outcome = await runWatchSweep(deps, ["SSX-1234"]);

    expect(outcome).toMatchObject({ held: 0, failed: 1 });
  });
});
