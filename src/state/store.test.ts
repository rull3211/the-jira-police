import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EMPTY_STATE, MAX_SEEN_KEYS, isUnseen, loadState, recordSeen, saveState } from "./store.ts";

describe("loadState", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jira-police-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns empty state when the file does not exist", async () => {
    await expect(loadState(join(dir, "missing.json"))).resolves.toEqual(EMPTY_STATE);
  });

  it("round-trips through save", async () => {
    const path = join(dir, "nested", "state.json");
    const state = { cursor: "2026-09-02T09:55:34.178+0200", seenKeys: ["SSX-1"] };

    await saveState(path, state);

    await expect(loadState(path)).resolves.toEqual(state);
  });

  it("rejects a malformed state file rather than silently resetting", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, '{"cursor": 42}', "utf8");

    await expect(loadState(path)).rejects.toThrow(/Malformed state file/);
  });

  it("leaves no temp file behind", async () => {
    const path = join(dir, "state.json");
    await saveState(path, EMPTY_STATE);

    await expect(readFile(`${path}.tmp`, "utf8")).rejects.toThrow();
  });
});

describe("recordSeen", () => {
  it("is a no-op for an empty batch", () => {
    const state = { cursor: "a", seenKeys: ["SSX-1"] };
    expect(recordSeen(state, [], "b")).toBe(state);
  });

  it("advances the cursor and appends keys", () => {
    const next = recordSeen(EMPTY_STATE, ["SSX-1", "SSX-2"], "2026-09-02T10:00:00Z");

    expect(next.cursor).toBe("2026-09-02T10:00:00Z");
    expect(next.seenKeys).toEqual(["SSX-1", "SSX-2"]);
  });

  it("does not duplicate keys already recorded", () => {
    const state = { cursor: "a", seenKeys: ["SSX-1"] };

    const next = recordSeen(state, ["SSX-1", "SSX-2"], "b");

    expect(next.seenKeys).toEqual(["SSX-1", "SSX-2"]);
  });

  it("keeps the existing cursor when no newer timestamp is supplied", () => {
    const state = { cursor: "keep-me", seenKeys: [] };

    expect(recordSeen(state, ["SSX-1"], null).cursor).toBe("keep-me");
  });

  it("caps retained keys, discarding the oldest", () => {
    const many = Array.from({ length: MAX_SEEN_KEYS + 50 }, (_, i) => `SSX-${i}`);

    const next = recordSeen(EMPTY_STATE, many, "x");

    expect(next.seenKeys).toHaveLength(MAX_SEEN_KEYS);
    expect(next.seenKeys.at(0)).toBe("SSX-50");
    expect(next.seenKeys.at(-1)).toBe(`SSX-${MAX_SEEN_KEYS + 49}`);
  });
});

describe("isUnseen", () => {
  it("distinguishes recorded from unrecorded keys", () => {
    const state = { cursor: null, seenKeys: ["SSX-1"] };

    expect(isUnseen(state, "SSX-1")).toBe(false);
    expect(isUnseen(state, "SSX-2")).toBe(true);
  });
});
