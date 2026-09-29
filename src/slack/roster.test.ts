import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  MAX_SUBSCRIBERS,
  ROSTER_PROPERTY,
  type Roster,
  type RosterLoad,
  type RosterStore,
  USAGE_REPLY,
  applyCommand,
  createCommandHandler,
  dryRosterStore,
  loadRoster,
  parseCommand,
  parseRoster,
  propertyRosterStore,
} from "./roster.ts";

const ME = "U0ME";
const OTHER = "U0OTHER";

/** An in-memory property, so read-back sees exactly what the last save wrote. */
function memory(
  initial: RosterLoad = { kind: "found", roster: { subscribers: [] } },
): RosterStore & {
  readonly saved: Roster[];
} {
  let current = initial;
  const saved: Roster[] = [];
  return {
    saved,
    load: async () => current,
    save: async (roster) => {
      saved.push(roster);
      current = { kind: "found", roster };
    },
  };
}

const handler = (store: RosterStore, dry = false): ReturnType<typeof createCommandHandler> =>
  createCommandHandler(store, { dry, where: `${ROSTER_PROPERTY} on SSX` });

describe("parseRoster", () => {
  it("reads a list this version wrote", () => {
    expect(parseRoster({ subscribers: [ME, OTHER] })).toEqual({ subscribers: [ME, OTHER] });
  });

  it.each([
    ["not an object", "U0ME"],
    ["no list", { subscribers: "U0ME" }],
    ["an entry that is not a user ID", { subscribers: [ME, "<!channel>"] }],
    ["a non-string entry", { subscribers: [ME, 7] }],
    ["a duplicate", { subscribers: [ME, ME] }],
    [
      "one over the cap",
      {
        subscribers: Array.from(
          { length: MAX_SUBSCRIBERS + 1 },
          (_, i) => `U${String(i).padStart(3, "0")}`,
        ),
      },
    ],
  ])("refuses the whole list for %s", (_name, value) => {
    expect(parseRoster(value)).toBeNull();
  });
});

describe("parseCommand", () => {
  it.each([
    ["", "status"],
    ["   ", "status"],
    [" Subscribe ", "subscribe"],
    ["unsubscribe", "unsubscribe"],
    ["status", "status"],
    ["subscribe U0OTHER", null],
    ["help", null],
  ])("reads %j as %j", (text, expected) => {
    expect(parseCommand(text)).toBe(expected);
  });
});

function listOf(...subscribers: string[]): Roster {
  return { subscribers };
}

describe("applyCommand", () => {
  it("adds and removes only the one user, and writes nothing when there is nothing to change", () => {
    expect(applyCommand("subscribe", ME, listOf(OTHER)).next).toEqual(listOf(OTHER, ME));
    expect(applyCommand("unsubscribe", ME, listOf(OTHER, ME)).next).toEqual(listOf(OTHER));
    expect(applyCommand("subscribe", ME, listOf(ME)).next).toBeNull();
    expect(applyCommand("unsubscribe", ME, listOf(OTHER)).next).toBeNull();
    expect(applyCommand("status", ME, listOf(ME)).next).toBeNull();
  });

  it("refuses to grow a full list", () => {
    const full = listOf(
      ...Array.from({ length: MAX_SUBSCRIBERS }, (_, i) => `U${String(i).padStart(3, "0")}`),
    );
    const applied = applyCommand("subscribe", ME, full);
    expect(applied.next).toBeNull();
    expect(applied.reply).toContain("full");
  });

  it("says where the asker stands, and how many are on the list", () => {
    expect(applyCommand("status", ME, listOf(ME, OTHER)).reply).toMatch(
      /^You are subscribed, one of 2/u,
    );
    expect(applyCommand("status", ME, listOf(OTHER)).reply).toMatch(
      /^You are not subscribed; 1 person is/u,
    );
  });
});

describe("createCommandHandler", () => {
  it("subscribes the user Slack named, writes the list, and confirms it from a read-back", async () => {
    const store = memory();

    const reply = await handler(store)({ userId: ME, text: "subscribe" });

    expect(store.saved).toEqual([{ subscribers: [ME] }]);
    expect(reply).toMatch(/^Subscribed/u);
  });

  it("takes no user from the command's text", async () => {
    const store = memory();

    const reply = await handler(store)({ userId: ME, text: `subscribe ${OTHER}` });

    expect(reply).toBe(USAGE_REPLY);
    expect(store.saved).toEqual([]);
  });

  it("writes nothing over a list it cannot read, and says so", async () => {
    const store = memory({ kind: "unreadable", reason: "not a list this version wrote" });

    const reply = await handler(store)({ userId: ME, text: "subscribe" });

    expect(store.saved).toEqual([]);
    expect(reply).toContain("cannot be read, so it was left as found");
  });

  it("does not claim a change the read-back does not show", async () => {
    const store = memory();
    const lost: RosterStore = { load: store.load, save: async () => undefined };

    const reply = await handler(lost)({ userId: ME, text: "subscribe" });

    expect(reply).toContain("reading it back does not show the change");
  });

  it("answers a failure in the reply instead of throwing, escaped", async () => {
    const broken: RosterStore = {
      load: async () => {
        throw new Error("Jira said <!channel> 503");
      },
      save: vi.fn(),
    };

    const reply = await handler(broken)({ userId: ME, text: "subscribe" });

    expect(reply).toContain("did not go through: Jira said &lt;!channel&gt; 503");
  });

  it("reads nothing for a user ID that is not one", async () => {
    const load = vi.fn<RosterStore["load"]>();

    const reply = await handler({ load, save: vi.fn() })({ userId: "<!here>", text: "subscribe" });

    expect(load).not.toHaveBeenCalled();
    expect(reply).toContain("no user");
  });

  it("logs how long each Jira step took, so a reply that missed Slack's budget says which call was slow", async () => {
    const lines: string[] = [];
    const level = process.env["LOG_LEVEL"];
    process.env["LOG_LEVEL"] = "info";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      await handler(memory())({ userId: ME, text: "subscribe" });
    } finally {
      vi.restoreAllMocks();
      if (level === undefined) {
        delete process.env["LOG_LEVEL"];
      } else {
        process.env["LOG_LEVEL"] = level;
      }
    }

    const line = lines
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .find((entry) => entry["message"] === "slack.command");
    expect(Object.keys(line?.["ms"] as object)).toEqual(["load", "save", "readBack"]);
  });

  it("marks every reply of a dry run as one", async () => {
    expect(await handler(memory(), true)({ userId: ME, text: "subscribe" })).toMatch(
      /^\(dry run, nothing written\) Subscribed/u,
    );
  });
});

describe("the stores", () => {
  it("reads an absent property as the empty list, and anything unparsable as unreadable", async () => {
    const jira = {
      getProjectProperty: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ subscribers: ["<!channel>"] }),
    };

    expect(await loadRoster(jira, "SSX")).toEqual({ kind: "found", roster: { subscribers: [] } });
    expect((await loadRoster(jira, "SSX")).kind).toBe("unreadable");
    expect(jira.getProjectProperty).toHaveBeenCalledWith("SSX", ROSTER_PROPERTY);
  });

  it("writes the list as the project's property", async () => {
    const jira = { getProjectProperty: vi.fn(), setProjectProperty: vi.fn() };

    await propertyRosterStore(jira, "SSX").save({ subscribers: [ME] });

    expect(jira.setProjectProperty).toHaveBeenCalledWith("SSX", ROSTER_PROPERTY, {
      subscribers: [ME],
    });
  });

  it("dry, reads the real list until its first write, then its own file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "roster-"));
    try {
      const jira = { getProjectProperty: vi.fn(async () => ({ subscribers: [OTHER] })) };
      const store = dryRosterStore(jira, "SSX", directory);

      expect(await store.load()).toEqual({ kind: "found", roster: { subscribers: [OTHER] } });
      await store.save({ subscribers: [OTHER, ME] });

      expect(await store.load()).toEqual({ kind: "found", roster: { subscribers: [OTHER, ME] } });
      expect(jira.getProjectProperty).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await readFile(join(directory, "roster.json"), "utf8"))).toEqual({
        project: "SSX",
        property: ROSTER_PROPERTY,
        value: { subscribers: [OTHER, ME] },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
