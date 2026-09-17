/**
 * The read scope, tested for the two ways it could grant more than it says:
 * traversal (a name from `.env` resolving outside the checkout root) and the
 * solved repository sneaking in as a second path to code already being edited.
 */

import { describe, expect, it } from "vitest";

import { describeReadScope, readScope } from "./read-scope.ts";

const ROOT = "/Users/dev/git";

describe("readScope", () => {
  it("resolves names under the checkout root", () => {
    const scope = readScope(ROOT, ["commerce-rest-api", "shared-lib"], null);

    expect(scope).toEqual({
      dirs: ["/Users/dev/git/commerce-rest-api", "/Users/dev/git/shared-lib"],
      rejected: [],
    });
  });

  it("keeps the operator's order", () => {
    const scope = readScope(ROOT, ["z-repo", "a-repo"], null);

    expect(scope.dirs).toEqual(["/Users/dev/git/z-repo", "/Users/dev/git/a-repo"]);
  });

  it.each([
    ["..", "the parent of the checkout root"],
    ["../..", "two levels up"],
    ["/etc", "an absolute path"],
    [".ssh", "a dotfile directory"],
    ["--add-dir", "a name that reads as a flag"],
    ["a/b", "a nested path"],
  ])("refuses %s (%s)", (name) => {
    const scope = readScope(ROOT, [name], null);

    expect(scope.dirs).toEqual([]);
    expect(scope.rejected).toEqual([name]);
  });

  it("keeps the good entries when one is bad, and reports the bad one verbatim", () => {
    const scope = readScope(ROOT, ["commerce-rest-api", "../secrets", "shared-lib"], null);

    expect(scope.dirs).toEqual(["/Users/dev/git/commerce-rest-api", "/Users/dev/git/shared-lib"]);
    expect(scope.rejected).toEqual(["../secrets"]);
  });

  it("excludes the repository this run is solving", () => {
    const scope = readScope(ROOT, ["commerce-rest-api", "advisor-web"], "advisor-web");

    expect(scope.dirs).toEqual(["/Users/dev/git/commerce-rest-api"]);
    expect(scope.rejected).toEqual([]);
  });

  it("deduplicates", () => {
    const scope = readScope(ROOT, ["shared-lib", "shared-lib"], null);

    expect(scope.dirs).toEqual(["/Users/dev/git/shared-lib"]);
  });

  it("is empty when nothing is configured", () => {
    expect(readScope(ROOT, [], null)).toEqual({ dirs: [], rejected: [] });
  });
});

describe("describeReadScope", () => {
  it("says nothing at all when there is nothing to read", () => {
    expect(describeReadScope([])).toBe("");
  });

  it("lists every path and says the access is read-only", () => {
    const text = describeReadScope(["/Users/dev/git/commerce-rest-api"]);

    expect(text).toContain("/Users/dev/git/commerce-rest-api");
    expect(text).toContain("READ-ONLY");
  });

  it("tells the pass that a change written there is an escape", () => {
    expect(describeReadScope(["/Users/dev/git/other"])).toContain("escape");
  });
});
