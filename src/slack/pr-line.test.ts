import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SlackError } from "./client.ts";
import { dryDelivery, prLineSender, slackDelivery } from "./pr-line.ts";

const LINE = "<https://github.com/o/r/pull/7|PR-Bencebot> Fiks på cache eviction";

describe("prLineSender", () => {
  it("answers sent, with the message's ts", async () => {
    const sender = prLineSender(async () => "1759140000.000100");

    expect(await sender.send("SSX-1", LINE)).toEqual({ kind: "sent", ts: "1759140000.000100" });
  });

  it("answers failed with Slack's own reason and never throws, since the pull request is already open", async () => {
    const sender = prLineSender(async () => {
      throw new SlackError("chat.postMessage", "missing_scope", "needs scope im:write");
    });

    expect(await sender.send("SSX-1", LINE)).toEqual({
      kind: "failed",
      reason: "Slack chat.postMessage failed: missing_scope — needs scope im:write",
    });
  });
});

describe("slackDelivery", () => {
  it("posts the line to the operator's member ID, not to the audit channel", async () => {
    const posted: object[] = [];
    const deliver = slackDelivery(
      {
        post: async (args) => {
          posted.push(args);
          return { ts: "1759140000.000100", channel: "D0123ABCD", warnings: [] };
        },
      },
      "U0123ABCD",
    );

    expect(await deliver("SSX-1", LINE)).toBe("1759140000.000100");
    expect(posted).toEqual([{ channel: "U0123ABCD", text: LINE }]);
  });
});

describe("dryDelivery", () => {
  it("writes the exact request a live run would send, one file per ticket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-line-"));
    try {
      await dryDelivery(directory, "U0123ABCD")("SSX-7", LINE);

      expect(JSON.parse(await readFile(join(directory, "SSX-7.pr-line.json"), "utf8"))).toEqual({
        method: "chat.postMessage",
        channel: "U0123ABCD",
        text: LINE,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
