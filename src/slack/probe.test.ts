import { describe, expect, it } from "vitest";

import { MAX_PROPERTY_CHARS } from "../jira/client.ts";
import { SlackError } from "./client.ts";
import {
  EXIT,
  PROBE_PROPERTY,
  type ProbeJira,
  type ProbeSlack,
  type ProbeTarget,
  exitCodeFor,
  formatReport,
  runProbe,
  sampleRecord,
} from "./probe.ts";

const TARGET: ProbeTarget = {
  channel: "C1",
  operator: null,
  issueKey: "SSX-1",
  keep: false,
  nonce: "n-1",
  now: new Date("2026-09-28T10:00:00Z"),
};

/** A post to a member ID lands in the bot's conversation with them, `D1`, as Slack answers it. */
function slack(behaviour: { readonly failAuth?: boolean; readonly failDirect?: string } = {}): {
  readonly client: ProbeSlack;
  readonly deleted: string[];
} {
  const deleted: string[] = [];
  return {
    deleted,
    client: {
      authTest: async () => {
        if (behaviour.failAuth === true) {
          throw new SlackError("auth.test", "invalid_auth", "");
        }
        return { userId: "U1", botId: "B1", team: "Storebrand" };
      },
      post: async (args) => {
        if (!args.channel.startsWith("U")) {
          return { ts: "100.1", channel: args.channel, warnings: [] };
        }
        if (behaviour.failDirect !== undefined) {
          throw new SlackError("chat.postMessage", behaviour.failDirect, "");
        }
        return { ts: "200.1", channel: "D1", warnings: [] };
      },
      update: async (args) => ({ ts: args.ts, warnings: [] }),
      deleteMessage: async (args) => {
        deleted.push(`${args.channel}/${args.ts}`);
      },
    },
  };
}

/** A ticket's properties, with a knob for a Jira that hands back less than it was given. */
function jira(
  behaviour: { readonly dropTimeline?: boolean; readonly lostOnDelete?: boolean } = {},
): {
  readonly client: ProbeJira;
  readonly stored: Map<string, unknown>;
} {
  const stored = new Map<string, unknown>();
  return {
    stored,
    client: {
      setIssueProperty: async (key, property, value) => {
        stored.set(`${key}/${property}`, structuredClone(value));
      },
      getIssueProperty: async (key, property) => {
        const value = stored.get(`${key}/${property}`) ?? null;
        if (value !== null && behaviour.dropTimeline === true) {
          const { timeline: _dropped, ...rest } = value as Record<string, unknown>;
          return rest;
        }
        return value;
      },
      deleteIssueProperty: async (key, property) => {
        const had = stored.delete(`${key}/${property}`);
        return behaviour.lostOnDelete === true ? false : had;
      },
    },
  };
}

describe("runProbe", () => {
  it("passes both halves and leaves nothing behind", async () => {
    const chat = slack();
    const ticket = jira();

    const result = await runProbe(chat.client, ticket.client, TARGET);

    expect(result.steps.map((step) => [step.name, step.ok])).toEqual([
      ["auth.test", true],
      ["chat.postMessage", true],
      ["chat.update", true],
      ["chat.delete", true],
      ["property write", true],
      ["property read back", true],
      ["property delete", true],
      ["property gone", true],
    ]);
    expect(chat.deleted).toEqual(["C1/100.1"]);
    expect(ticket.stored.size).toBe(0);
    expect(exitCodeFor(result)).toBe(EXIT.ok);
  });

  it("with an operator named, sends them a direct message and deletes it where Slack put it", async () => {
    const chat = slack();

    const result = await runProbe(chat.client, jira().client, { ...TARGET, operator: "U0123ABCD" });

    expect(result.steps.map((step) => [step.name, step.ok]).slice(0, 6)).toEqual([
      ["auth.test", true],
      ["chat.postMessage", true],
      ["chat.update", true],
      ["chat.delete", true],
      ["direct message", true],
      ["direct message delete", true],
    ]);
    // Deleted in the conversation Slack answered with, never by the member ID it was posted to.
    expect(chat.deleted).toEqual(["C1/100.1", "D1/200.1"]);
    expect(result.directLeft).toBeNull();
    expect(exitCodeFor(result)).toBe(EXIT.ok);
  });

  it("fails on a refused direct message with Slack's reason, and still measures the Jira half", async () => {
    const result = await runProbe(slack({ failDirect: "missing_scope" }).client, jira().client, {
      ...TARGET,
      operator: "U0123ABCD",
    });

    const direct = result.steps.find((step) => step.name === "direct message");
    expect(direct?.ok).toBe(false);
    expect(direct?.detail).toContain("missing_scope");
    expect(result.steps.at(-1)).toEqual({
      name: "property gone",
      ok: true,
      detail: "reads as absent",
    });
    expect(exitCodeFor(result)).toBe(EXIT.failed);
  });

  it("sends no direct message when Slack refused the token", async () => {
    const result = await runProbe(slack({ failAuth: true }).client, jira().client, {
      ...TARGET,
      operator: "U0123ABCD",
    });

    expect(result.steps.some((step) => step.name.startsWith("direct message"))).toBe(false);
  });

  it("leaves the direct message under --keep, and the report says where", async () => {
    const kept = { ...TARGET, operator: "U0123ABCD", keep: true };
    const chat = slack();

    const result = await runProbe(chat.client, jira().client, kept);

    expect(chat.deleted).toEqual([]);
    expect(result.directLeft).toEqual({ channel: "D1", ts: "200.1" });
    expect(formatReport(result, kept)).toContain("still with U0123ABCD: D1, ts 200.1");
  });

  it("fails when Jira hands back the record without its timeline, the shape Slack could not hold", async () => {
    const result = await runProbe(slack().client, jira({ dropTimeline: true }).client, TARGET);

    expect(result.steps.find((step) => step.name === "property read back")?.ok).toBe(false);
    expect(exitCodeFor(result)).toBe(EXIT.failed);
  });

  it("still measures the Jira half when Slack refuses the token", async () => {
    const result = await runProbe(slack({ failAuth: true }).client, jira().client, TARGET);

    expect(result.steps.map((step) => [step.name, step.ok])).toEqual([
      ["auth.test", false],
      ["property write", true],
      ["property read back", true],
      ["property delete", true],
      ["property gone", true],
    ]);
  });

  it("fails a delete Jira says found nothing, rather than taking it as done", async () => {
    const result = await runProbe(slack().client, jira({ lostOnDelete: true }).client, TARGET);

    expect(result.steps.find((step) => step.name === "property delete")?.ok).toBe(false);
  });

  it("leaves both behind under --keep, and the report says where", async () => {
    const chat = slack();
    const ticket = jira();
    const kept = { ...TARGET, keep: true };

    const result = await runProbe(chat.client, ticket.client, kept);

    expect(chat.deleted).toEqual([]);
    expect(ticket.stored.has(`SSX-1/${PROBE_PROPERTY}`)).toBe(true);
    const report = formatReport(result, kept);
    expect(report).toContain("still in the channel: ts 100.1");
    expect(report).toContain(`${PROBE_PROPERTY} is still on SSX-1`);
  });
});

describe("sampleRecord", () => {
  it("is big enough to measure a full record and small enough to fit Jira's limit", () => {
    const chars = JSON.stringify(sampleRecord(TARGET, "100.1")).length;

    expect(chars).toBeGreaterThan(10_000);
    expect(chars).toBeLessThan(MAX_PROPERTY_CHARS);
  });
});
