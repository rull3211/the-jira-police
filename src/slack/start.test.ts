import { describe, expect, it } from "vitest";

import { AGENT_LABELS, type LabelEdit, SOLVE_QUEUE_EXCLUDED_LABELS } from "../solve/labels.ts";
import { applyEvent, newRecord } from "./audit.ts";
import { renderRecord } from "./render.ts";
import {
  MENTION_USAGE,
  type Mention,
  type RootMessage,
  type ThreadDeps,
  createMentionHandler,
  decide,
  describeThreadOutcome,
  parseMentionVerb,
  parseThreadLink,
  recordNamesThread,
  runThreadCommand,
  ticketOfRoot,
} from "./start.ts";
import type { Loaded } from "./store.ts";

const BOT = "B0BENCEBOT";
const CHANNEL = "C0C4WAHKCA2";
const THREAD = "1790779480.401999";
const ISSUE = "SSX-4003";
const ALLOWED = "U0ALLOWED";

/** The text `renderRecord` gives the thread's top message, so a change to its fallback fails here. */
function rootMessage(overrides: Partial<RootMessage> = {}): RootMessage {
  return {
    ts: THREAD,
    text: renderRecord(newRecord(ISSUE, "Beløp på forsikring vises feil", "https://x")).text,
    botId: BOT,
    ...overrides,
  };
}

function found(thread: { channel: string; ts: string } | null): Loaded {
  return { kind: "found", record: { ...newRecord(ISSUE, "summary", "https://x"), slack: thread } };
}

interface Fake {
  readonly deps: ThreadDeps;
  readonly calls: string[];
  readonly applied: LabelEdit[];
}

/** `reads` is what each label read returns in turn: the one before the write, then the read-back. */
function fake(options: {
  readonly root?: RootMessage | null;
  readonly record?: Loaded;
  readonly reads?: (readonly string[])[];
  readonly dry?: boolean;
}): Fake {
  const calls: string[] = [];
  const applied: LabelEdit[] = [];
  const reads = [...(options.reads ?? [[AGENT_LABELS.solvable]])];
  return {
    calls,
    applied,
    deps: {
      botId: async () => {
        calls.push("botId");
        return BOT;
      },
      root: async (channel, ts) => {
        calls.push(`root ${channel} ${ts}`);
        return options.root === undefined ? rootMessage() : options.root;
      },
      record: async (key) => {
        calls.push(`record ${key}`);
        return options.record ?? found({ channel: CHANNEL, ts: THREAD });
      },
      labels: {
        dry: options.dry ?? false,
        read: async (key) => {
          calls.push(`read ${key}`);
          const next = reads.shift();
          if (next === undefined) {
            throw new Error("read more times than the test expected");
          }
          return next;
        },
        apply: async (key, edit) => {
          calls.push(`apply ${key}`);
          applied.push(edit);
        },
      },
    },
  };
}

function mention(overrides: Partial<Mention> = {}): Mention {
  return {
    userId: ALLOWED,
    text: "<@U0BENCEBOT> start",
    channel: CHANNEL,
    ts: "1790779745.218229",
    threadTs: THREAD,
    ...overrides,
  };
}

async function replyTo(
  handled: Mention,
  deps: ThreadDeps,
  allowed: readonly string[] = [ALLOWED],
): Promise<string[]> {
  const replies: string[] = [];
  await createMentionHandler({
    allowed,
    deps,
    reply: async (_mention, text) => {
      replies.push(text);
    },
  })(handled);
  return replies;
}

describe("parseMentionVerb", () => {
  it("reads the one word left once every mention is taken out, wherever the mention sits", () => {
    expect(parseMentionVerb("<@U0BENCEBOT> start")).toBe("start");
    expect(parseMentionVerb("<@U0BENCEBOT|bencebot>   Clear ")).toBe("clear");
    expect(parseMentionVerb("start <@U0BENCEBOT>")).toBe("start");
  });

  it("is null for a bare mention, an extra word, or a word it does not know", () => {
    expect(parseMentionVerb("<@U0BENCEBOT>")).toBeNull();
    expect(parseMentionVerb("<@U0BENCEBOT> start now")).toBeNull();
    expect(parseMentionVerb("<@U0BENCEBOT> subscribe")).toBeNull();
    expect(parseMentionVerb("thanks <@U0BENCEBOT>")).toBeNull();
  });
});

describe("parseThreadLink", () => {
  it("takes the thread from a reply's thread_ts, not from the reply", () => {
    expect(
      parseThreadLink(
        "https://storebrand.slack.com/archives/C0C4WAHKCA2/p1790779745218229?thread_ts=1790779480.401999&cid=C0C4WAHKCA2",
      ),
    ).toEqual({ channel: "C0C4WAHKCA2", threadTs: "1790779480.401999" });
  });

  it("takes a link to the top message itself as the thread", () => {
    expect(
      parseThreadLink("https://storebrand.slack.com/archives/C0C4WAHKCA2/p1790779480401999"),
    ).toEqual({
      channel: "C0C4WAHKCA2",
      threadTs: "1790779480.401999",
    });
  });

  it("is null for a direct message, another host, plain http, or a malformed thread_ts", () => {
    expect(
      parseThreadLink("https://storebrand.slack.com/archives/D0DIRECT1/p1790779480401999"),
    ).toBeNull();
    expect(
      parseThreadLink("https://slack.com.evil.test/archives/C0C4WAHKCA2/p1790779480401999"),
    ).toBeNull();
    expect(
      parseThreadLink("http://storebrand.slack.com/archives/C0C4WAHKCA2/p1790779480401999"),
    ).toBeNull();
    expect(
      parseThreadLink(
        "https://storebrand.slack.com/archives/C0C4WAHKCA2/p1790779745218229?thread_ts=1.2",
      ),
    ).toBeNull();
    expect(parseThreadLink("SSX-4003")).toBeNull();
  });
});

describe("ticketOfRoot", () => {
  it("takes the ticket from the bot's own top message, before and after it gains a major entry", () => {
    const triaged = applyEvent(
      newRecord(ISSUE, "summary", "https://x"),
      {
        kind: "triage-verdict",
        verdict: "ready-ish",
        solvable: true,
        confidence: "high",
        posted: true,
      },
      new Date("2026-09-30T20:00:00Z"),
    );

    expect(ticketOfRoot(rootMessage(), THREAD, BOT)).toEqual({ kind: "ticket", key: ISSUE });
    expect(ticketOfRoot(rootMessage({ text: renderRecord(triaged).text }), THREAD, BOT)).toEqual({
      kind: "ticket",
      key: ISSUE,
    });
  });

  it("refuses a top message somebody else posted, however much it looks like the bot's", () => {
    expect(ticketOfRoot(rootMessage({ botId: null }), THREAD, BOT).kind).toBe("none");
    expect(ticketOfRoot(rootMessage({ botId: "B0OTHERAPP" }), THREAD, BOT).kind).toBe("none");
  });

  it("refuses a message that is not the thread's top, and a top message naming no ticket", () => {
    expect(ticketOfRoot(rootMessage({ ts: "1790779745.218229" }), THREAD, BOT).kind).toBe("none");
    expect(ticketOfRoot(null, THREAD, BOT).kind).toBe("none");
    expect(ticketOfRoot(rootMessage({ text: "picked up SSX-4003" }), THREAD, BOT).kind).toBe(
      "none",
    );
  });
});

describe("recordNamesThread", () => {
  it("is null only when the ticket's record names this channel and this thread", () => {
    expect(recordNamesThread(found({ channel: CHANNEL, ts: THREAD }), ISSUE, CHANNEL, THREAD)).toBe(
      null,
    );
  });

  it("refuses a record naming the same ts in another channel, and another ts in this one", () => {
    expect(
      recordNamesThread(found({ channel: "C0ELSEWHERE", ts: THREAD }), ISSUE, CHANNEL, THREAD),
    ).toContain("different thread");
    expect(
      recordNamesThread(
        found({ channel: CHANNEL, ts: "1790000000.000001" }),
        ISSUE,
        CHANNEL,
        THREAD,
      ),
    ).toContain("different thread");
  });

  it("refuses when the ticket has no record, an unreadable one, or one holding no thread", () => {
    expect(recordNamesThread({ kind: "absent" }, ISSUE, CHANNEL, THREAD)).toContain("no ");
    expect(recordNamesThread({ kind: "unreadable" }, ISSUE, CHANNEL, THREAD)).toContain(
      "cannot be read",
    );
    expect(recordNamesThread(found(null), ISSUE, CHANNEL, THREAD)).toContain("different thread");
  });
});

describe("decide", () => {
  it("adds agent:start to a solvable ticket, and nothing else", () => {
    expect(decide("start", [AGENT_LABELS.solvable, "svc:x"])).toEqual({
      kind: "write",
      edit: { add: [AGENT_LABELS.start], remove: [] },
    });
  });

  it("refuses a start on a ticket triage has not called solvable", () => {
    const decision = decide("start", ["svc:x"]);
    expect(decision.kind).toBe("refused");
  });

  it("refuses a start on every label the solve queue excludes, so a start never waits on a ticket the queue skips", () => {
    for (const label of SOLVE_QUEUE_EXCLUDED_LABELS) {
      const decision = decide("start", [AGENT_LABELS.solvable, label]);
      expect(decision, label).toMatchObject({ kind: "refused" });
    }
  });

  it("points a refused start on a failed ticket at clear", () => {
    const decision = decide("start", [AGENT_LABELS.solvable, AGENT_LABELS.failed]);
    expect(decision.kind === "refused" && decision.reason).toContain("@Bencebot clear");
  });

  it("writes nothing when the ticket is already started", () => {
    expect(decide("start", [AGENT_LABELS.solvable, AGENT_LABELS.start]).kind).toBe("unchanged");
  });

  it("clear takes agent:failed off and adds nothing, not even agent:start", () => {
    expect(decide("clear", [AGENT_LABELS.solvable, AGENT_LABELS.failed])).toEqual({
      kind: "write",
      edit: { add: [], remove: [AGENT_LABELS.failed] },
    });
    expect(decide("clear", [AGENT_LABELS.solvable]).kind).toBe("unchanged");
  });
});

describe("runThreadCommand", () => {
  it("writes the edit and reads it back", async () => {
    const run = fake({
      reads: [[AGENT_LABELS.solvable], [AGENT_LABELS.solvable, AGENT_LABELS.start]],
    });

    const outcome = await runThreadCommand(run.deps, {
      verb: "start",
      channel: CHANNEL,
      threadTs: THREAD,
    });

    expect(outcome).toEqual({
      kind: "written",
      key: ISSUE,
      edit: { add: [AGENT_LABELS.start], remove: [] },
    });
    expect(run.calls.filter((call) => call.startsWith("read"))).toHaveLength(2);
  });

  it("reports a read-back that does not show the edit, rather than a start", async () => {
    const run = fake({ reads: [[AGENT_LABELS.solvable], [AGENT_LABELS.solvable]] });

    const outcome = await runThreadCommand(run.deps, {
      verb: "start",
      channel: CHANNEL,
      threadTs: THREAD,
    });

    expect(outcome.kind).toBe("unverified");
    expect(outcome.kind === "unverified" && outcome.notes.join()).toContain(AGENT_LABELS.start);
  });

  it("reports a clear whose label is still on the ticket afterwards", async () => {
    const failed = [AGENT_LABELS.solvable, AGENT_LABELS.failed];
    const run = fake({ reads: [failed, failed] });

    const outcome = await runThreadCommand(run.deps, {
      verb: "clear",
      channel: CHANNEL,
      threadTs: THREAD,
    });

    expect(outcome.kind).toBe("unverified");
  });

  it("dry, hands the edit to the writer and reads nothing back", async () => {
    const run = fake({ dry: true });

    const outcome = await runThreadCommand(run.deps, {
      verb: "start",
      channel: CHANNEL,
      threadTs: THREAD,
    });

    expect(outcome.kind).toBe("dry");
    expect(run.applied).toEqual([{ add: [AGENT_LABELS.start], remove: [] }]);
    expect(run.calls.filter((call) => call.startsWith("read"))).toHaveLength(1);
  });

  it("reads no label when the ticket's record names another thread", async () => {
    const run = fake({ record: found({ channel: CHANNEL, ts: "1790000000.000001" }) });

    const outcome = await runThreadCommand(run.deps, {
      verb: "start",
      channel: CHANNEL,
      threadTs: THREAD,
    });

    expect(outcome.kind).toBe("no-ticket");
    expect(run.calls.some((call) => call.startsWith("read") || call.startsWith("apply"))).toBe(
      false,
    );
  });

  it("reads neither record nor label when the top message is not the bot's", async () => {
    const run = fake({ root: rootMessage({ botId: "B0OTHERAPP" }) });

    const outcome = await runThreadCommand(run.deps, {
      verb: "start",
      channel: CHANNEL,
      threadTs: THREAD,
    });

    expect(outcome.kind).toBe("no-ticket");
    expect(run.calls.some((call) => call.startsWith("record") || call.startsWith("read"))).toBe(
      false,
    );
  });

  it("writes nothing when the decision is a refusal", async () => {
    const run = fake({ reads: [[AGENT_LABELS.solvable, AGENT_LABELS.failed]] });

    const outcome = await runThreadCommand(run.deps, {
      verb: "start",
      channel: CHANNEL,
      threadTs: THREAD,
    });

    expect(outcome.kind).toBe("refused");
    expect(run.applied).toEqual([]);
  });
});

describe("createMentionHandler", () => {
  it("answers a start from someone on the list with what happened to the ticket", async () => {
    const run = fake({
      reads: [[AGENT_LABELS.solvable], [AGENT_LABELS.solvable, AGENT_LABELS.start]],
    });

    const replies = await replyTo(mention(), run.deps);

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain(`Started ${ISSUE}`);
  });

  it("refuses someone not on the list before reading Slack or Jira", async () => {
    const run = fake({});

    const replies = await replyTo(mention({ userId: "U0STRANGER" }), run.deps);

    expect(replies[0]).toContain("not one of them");
    expect(run.calls).toEqual([]);
    expect(run.applied).toEqual([]);
  });

  it("refuses everyone when the list is empty", async () => {
    const run = fake({});

    const replies = await replyTo(mention(), run.deps, []);

    expect(replies[0]).toContain("not one of them");
    expect(run.calls).toEqual([]);
  });

  it("answers a mention that is not a command with usage, touching nothing", async () => {
    const run = fake({});

    const replies = await replyTo(mention({ text: "thanks <@U0BENCEBOT>" }), run.deps);

    expect(replies).toEqual([MENTION_USAGE]);
    expect(run.calls).toEqual([]);
  });

  it("says a mention outside a thread names no ticket", async () => {
    const run = fake({});

    const replies = await replyTo(mention({ threadTs: null }), run.deps);

    expect(replies[0]).toContain("not a thread");
    expect(run.calls).toEqual([]);
  });

  it("marks every reply of a dry handler, including a refusal", async () => {
    const run = fake({ dry: true });

    const [started] = await replyTo(mention(), run.deps);
    const [stranger] = await replyTo(mention({ userId: "U0STRANGER" }), fake({ dry: true }).deps);

    expect(started).toMatch(/^\(dry run, nothing written\) Would add/u);
    expect(stranger).toMatch(/^\(dry run, nothing written\) /u);
  });

  it("says a failure in the reply and resolves, whatever threw", async () => {
    const run = fake({});
    const broken: ThreadDeps = {
      ...run.deps,
      record: async () => {
        throw new Error("Jira answered 503 <html>");
      },
    };

    const replies = await replyTo(mention(), broken);

    expect(replies[0]).toContain("did not go through");
    expect(replies[0]).toContain("&lt;html&gt;");
  });

  it("resolves when the reply itself cannot be posted", async () => {
    const run = fake({
      reads: [[AGENT_LABELS.solvable], [AGENT_LABELS.solvable, AGENT_LABELS.start]],
    });
    const handler = createMentionHandler({
      allowed: [ALLOWED],
      deps: run.deps,
      reply: async () => {
        throw new Error("channel_not_found");
      },
    });

    await expect(handler(mention())).resolves.toBeUndefined();
    expect(run.applied).toHaveLength(1);
  });
});

describe("describeThreadOutcome", () => {
  it("escapes a reason, which can carry text from Slack or Jira", () => {
    const text = describeThreadOutcome("start", { kind: "no-ticket", reason: "<!channel> & co" });
    expect(text).toContain("&lt;!channel&gt; &amp; co");
  });
});
