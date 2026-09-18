import { describe, expect, it } from "vitest";

import { LOG_SOURCES } from "../logger.ts";
import { COMMAND_KEYS, SOURCE_KEY_POOL, assignKeys } from "./keys.ts";

describe("the source key pool", () => {
  it("holds no key that already means something", () => {
    // The collision this prevents is silent: the screen still draws the letter beside the source.
    for (const key of SOURCE_KEY_POOL) {
      expect(`${key}: reserved=${String(COMMAND_KEYS.has(key))}`).toBe(`${key}: reserved=false`);
    }
  });

  it("excludes both cases of a reserved letter, so a slipped shift does nothing unrelated", () => {
    expect(SOURCE_KEY_POOL).not.toContain("F");
    expect(SOURCE_KEY_POOL).not.toContain("Q");
  });

  it("is long enough for every source the logger declares", () => {
    // Fails the day `LOG_SOURCES` outgrows the pool, rather than leaving the overflow to be found
    // as a source on screen with no key beside it.
    expect(
      `${String(LOG_SOURCES.length)} sources fit in ${String(SOURCE_KEY_POOL.length)}: ${String(
        LOG_SOURCES.length <= SOURCE_KEY_POOL.length,
      )}`,
    ).toContain("true");
  });

  it("has no duplicates", () => {
    expect(new Set(SOURCE_KEY_POOL).size).toBe(SOURCE_KEY_POOL.length);
  });
});

describe("assignKeys", () => {
  it("assigns in first-seen order, so a key does not move once shown", () => {
    const first = assignKeys(["poll", "jira"]);
    const grown = assignKeys(["poll", "jira", "solve"]);

    expect(grown.get("poll")).toBe(first.get("poll"));
    expect(grown.get("jira")).toBe(first.get("jira"));
    expect(grown.get("solve")).toBeDefined();
  });

  it("gives distinct keys to distinct sources", () => {
    const keys = assignKeys([...LOG_SOURCES]);

    expect(new Set(keys.values()).size).toBe(keys.size);
  });

  it("leaves a source past the end of the pool without a key rather than reusing one", () => {
    const tooMany = Array.from({ length: SOURCE_KEY_POOL.length + 2 }, (_, i) => `s${String(i)}`);
    const keys = assignKeys(tooMany);

    expect(keys.size).toBe(SOURCE_KEY_POOL.length);
    expect(keys.has(`s${String(SOURCE_KEY_POOL.length)}`)).toBe(false);
  });
});
