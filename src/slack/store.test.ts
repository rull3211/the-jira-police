import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AUDIT_PROPERTY, newRecord } from "./audit.ts";
import { SlackError } from "./client.ts";
import {
  dryPublisher,
  dryStore,
  loadFromProperty,
  propertyStore,
  slackPublisher,
} from "./store.ts";

const RECORD = newRecord("SSX-1", "Cache", "https://example.atlassian.net/browse/SSX-1");

function reader(value: unknown) {
  return { getIssueProperty: async () => value };
}

describe("loadFromProperty", () => {
  it.each([
    ["absent", null, "absent"],
    ["found", JSON.parse(JSON.stringify(RECORD)) as unknown, "found"],
    ["unreadable", { version: 99 }, "unreadable"],
  ])("reads a property that is %s", async (_name, value, kind) => {
    expect((await loadFromProperty(reader(value), "SSX-1")).kind).toBe(kind);
  });
});

describe("propertyStore", () => {
  it("saves the record as the ticket's audit property", async () => {
    const writes: unknown[][] = [];
    const store = propertyStore({
      getIssueProperty: async () => null,
      setIssueProperty: async (...args: unknown[]) => {
        writes.push(args);
      },
    });

    await store.save("SSX-1", RECORD);

    expect(writes).toEqual([["SSX-1", AUDIT_PROPERTY, RECORD]]);
  });
});

/** A publisher over a Slack whose every edit and delete fails with `code`. */
function failing(code: string) {
  return slackPublisher(
    {
      post: async () => ({ ts: "1", warnings: [] }),
      update: async () => {
        throw new SlackError("chat.update", code, "");
      },
      deleteMessage: async () => {
        throw new SlackError("chat.delete", code, "");
      },
    },
    "C1",
  );
}

describe("slackPublisher", () => {
  const message = { text: "SSX-1: claimed", blocks: [] };
  const thread = { channel: "C1", ts: "1" };

  it("reads a deleted message as gone, so a fresh one can be posted", async () => {
    expect(await failing("message_not_found").update("SSX-1", thread, message)).toBe("gone");
    expect(await failing("message_not_found").remove("SSX-1", thread, "2")).toBe("gone");
  });

  it("does not read any other failure as gone", async () => {
    await expect(failing("not_in_channel").update("SSX-1", thread, message)).rejects.toThrow(
      "not_in_channel",
    );
    await expect(failing("cant_delete_message").remove("SSX-1", thread, "2")).rejects.toThrow(
      "cant_delete_message",
    );
  });

  it("broadcasts into the ticket's own thread, and deletes in the thread's channel", async () => {
    const calls: unknown[] = [];
    const publisher = slackPublisher(
      {
        post: async (args) => {
          calls.push(args);
          return { ts: "9", warnings: [] };
        },
        update: async () => ({ ts: "1", warnings: [] }),
        deleteMessage: async (args) => {
          calls.push(args);
        },
      },
      "C-configured",
    );

    expect(await publisher.broadcast("SSX-1", { channel: "C-thread", ts: "1" }, message)).toBe("9");
    await publisher.remove("SSX-1", { channel: "C-thread", ts: "1" }, "8");

    expect(calls).toEqual([
      { channel: "C-thread", text: "SSX-1: claimed", threadTs: "1", broadcast: true },
      { channel: "C-thread", ts: "8" },
    ]);
  });
});

describe("the dry run", () => {
  it("writes the record and the exact request, and nothing remote", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jp-slack-dry-"));
    const store = dryStore(reader(null), directory);
    const publisher = dryPublisher(directory);

    const thread = await publisher.post("SSX-1", {
      text: "SSX-1: picked up",
      blocks: [{ type: "divider" }],
    });
    await store.save("SSX-1", { ...RECORD, slack: thread });

    const request = JSON.parse(readFileSync(join(directory, "SSX-1.message.json"), "utf8")) as {
      method: string;
      blocks: unknown[];
    };
    const saved = JSON.parse(readFileSync(join(directory, "SSX-1.record.json"), "utf8")) as {
      slack: unknown;
    };
    expect(request.method).toBe("chat.postMessage");
    expect(request.blocks).toEqual([{ type: "divider" }]);
    expect(saved.slack).toEqual({ channel: "dry-run", ts: "dry-run" });
  });
});
