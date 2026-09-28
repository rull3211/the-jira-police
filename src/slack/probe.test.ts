import { describe, expect, it } from "vitest";

import type { SlackMessage, SlackMetadata } from "./client.ts";
import { SlackError } from "./client.ts";
import { EXIT, type ProbeClient, exitCodeFor, formatReport, runProbe } from "./probe.ts";

const NOW = new Date("2026-09-28T10:00:00Z");
const OPTIONS = { keep: false, nonce: "n-1", now: NOW } as const;

interface FakeChannel {
  readonly client: ProbeClient;
  readonly deleted: string[];
}

/**
 * A channel that stores what it is sent, with two knobs for the two ways Slack could lose metadata:
 * dropping it on the post, and keeping the old copy through an edit.
 */
function channel(
  behaviour: {
    readonly dropOnPost?: boolean;
    readonly ignoreOnUpdate?: boolean;
    readonly failAuth?: boolean;
    readonly failDelete?: boolean;
  } = {},
): FakeChannel {
  let stored: SlackMessage | null = null;
  const deleted: string[] = [];
  const client: ProbeClient = {
    authTest: async () => {
      if (behaviour.failAuth === true) {
        throw new SlackError("auth.test", "invalid_auth", "");
      }
      return { userId: "U1", botId: "B1", team: "Storebrand" };
    },
    post: async (args) => {
      stored = {
        ts: "100.1",
        text: args.text,
        botId: "B1",
        metadata: behaviour.dropOnPost === true ? null : (args.metadata ?? null),
      };
      return { ts: "100.1", warnings: behaviour.dropOnPost === true ? ["invalid_metadata"] : [] };
    },
    update: async (args) => {
      if (stored === null) {
        throw new SlackError("chat.update", "message_not_found", "");
      }
      const metadata: SlackMetadata | null =
        behaviour.ignoreOnUpdate === true ? stored.metadata : (args.metadata ?? stored.metadata);
      stored = { ...stored, text: args.text, metadata };
      return { ts: args.ts, warnings: [] };
    },
    history: async () => ({ messages: stored === null ? [] : [stored], nextCursor: null }),
    deleteMessage: async (args) => {
      if (behaviour.failDelete === true) {
        throw new SlackError("chat.delete", "cant_delete_message", "");
      }
      deleted.push(args.ts);
    },
  };
  return { client, deleted };
}

describe("runProbe", () => {
  it("passes every step when metadata survives the post and the edit, and cleans up", async () => {
    const fake = channel();

    const result = await runProbe(fake.client, "C1", OPTIONS);

    expect(result.steps.map((step) => [step.name, step.ok])).toEqual([
      ["auth.test", true],
      ["chat.postMessage", true],
      ["metadata after post", true],
      ["chat.update", true],
      ["metadata after update", true],
      ["chat.delete", true],
    ]);
    expect(fake.deleted).toEqual(["100.1"]);
    expect(result.leftBehind).toBeNull();
    expect(exitCodeFor(result)).toBe(EXIT.ok);
  });

  it("fails when an edit keeps the old metadata, which is the case the whole store depends on", async () => {
    const result = await runProbe(channel({ ignoreOnUpdate: true }).client, "C1", OPTIONS);

    const step = result.steps.find((candidate) => candidate.name === "metadata after update");
    expect(step?.ok).toBe(false);
    expect(exitCodeFor(result)).toBe(EXIT.failed);
  });

  it("fails when the post drops metadata, and shows the warning Slack gave for it", async () => {
    const result = await runProbe(channel({ dropOnPost: true }).client, "C1", OPTIONS);

    const post = result.steps.find((candidate) => candidate.name === "chat.postMessage");
    const read = result.steps.find((candidate) => candidate.name === "metadata after post");
    expect(post?.detail).toContain("invalid_metadata");
    expect(read?.ok).toBe(false);
    expect(exitCodeFor(result)).toBe(EXIT.failed);
  });

  it("stops at a failed auth.test without posting anything", async () => {
    const result = await runProbe(channel({ failAuth: true }).client, "C1", OPTIONS);

    expect(result.steps).toEqual([
      { name: "auth.test", ok: false, detail: "Slack auth.test failed: invalid_auth" },
    ]);
  });

  it("leaves the message and says so under --keep", async () => {
    const fake = channel();

    const result = await runProbe(fake.client, "C1", { ...OPTIONS, keep: true });

    expect(fake.deleted).toEqual([]);
    expect(result.leftBehind).toBe("100.1");
    expect(formatReport(result, "C1", NOW)).toContain("still in the channel: ts 100.1");
  });

  it("reports a message it failed to delete as left behind", async () => {
    const result = await runProbe(channel({ failDelete: true }).client, "C1", OPTIONS);

    expect(result.leftBehind).toBe("100.1");
    expect(exitCodeFor(result)).toBe(EXIT.failed);
  });
});
