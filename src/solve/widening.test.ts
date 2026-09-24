import { describe, expect, it } from "vitest";

import type { WidenedChange } from "./runner.ts";
import { checkWidening } from "./widening.ts";

const TYPES = "src/api/commerce/types.ts";

const change = (overrides: Partial<WidenedChange> = {}): WidenedChange => ({
  path: TYPES,
  requestedBy: "comment 2",
  what: "dropped the five exports nothing imports",
  ...overrides,
});

const MEMBERS: ReadonlySet<string> = new Set(["comment 2", "PRRT_kwDOE4J7MM6lhZi7"]);
const PULL_REQUEST: ReadonlySet<string> = new Set([TYPES, "src/mappers/FormMappers/utils.ts"]);

describe("checkWidening", () => {
  it("passes nothing declared", () => {
    expect(checkWidening([], new Set(), new Set())).toEqual([]);
  });

  it("passes the #2688 request: a member's comment, a file the pull request already changes", () => {
    expect(checkWidening([change()], MEMBERS, PULL_REQUEST)).toEqual([]);
  });

  it("passes a request made on a thread a member spoke on", () => {
    expect(
      checkWidening([change({ requestedBy: "PRRT_kwDOE4J7MM6lhZi7" })], MEMBERS, PULL_REQUEST),
    ).toEqual([]);
  });

  it.each(["Comment 2", " comment 2 ", "comment  2", "comment 02"])(
    "reads %j as the member's comment",
    (requestedBy) => {
      expect(checkWidening([change({ requestedBy })], MEMBERS, PULL_REQUEST)).toEqual([]);
    },
  );

  it.each(["comment 1", "comment 2 by rull3211", "rull3211", "prrt_kwdoe4j7mm6lhzi7", ""])(
    "refuses a widening on the word of %j",
    (requestedBy) => {
      const reasons = checkWidening([change({ requestedBy })], MEMBERS, PULL_REQUEST);

      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toContain("not a comment or thread a repository member wrote");
    },
  );

  it("refuses a file the pull request had not changed, even at a member's request", () => {
    const reasons = checkWidening(
      [change({ path: "src/api/commerce/client.ts" })],
      MEMBERS,
      PULL_REQUEST,
    );

    expect(reasons).toEqual([expect.stringContaining("src/api/commerce/client.ts")]);
    expect(reasons[0]).toContain("had not changed it before this round");
  });

  it("collects every reason rather than the first", () => {
    const reasons = checkWidening(
      [change({ requestedBy: "comment 1", path: "elsewhere.ts" }), change()],
      MEMBERS,
      PULL_REQUEST,
    );

    expect(reasons).toHaveLength(2);
  });
});
