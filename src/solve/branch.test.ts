import { describe, expect, it } from "vitest";

import { assertWorkBranch, isProtectedRef, isWorkBranch } from "./branch.ts";

describe("isProtectedRef", () => {
  it.each([
    "main",
    "master",
    "develop",
    "production",
    "release",
    "release/2026-09",
    "hotfix/urgent",
  ])("refuses %s", (ref) => {
    expect(isProtectedRef(ref)).toBe(true);
  });

  it.each(["origin/main", "refs/heads/main", "refs/remotes/origin/master", "upstream/develop"])(
    "sees through the qualifier on %s",
    (ref) => {
      expect(isProtectedRef(ref)).toBe(true);
    },
  );

  it.each(["Main", "MASTER", "  main  ", "MaIn"])("is not fooled by %s", (ref) => {
    // This laptop's filesystem is case-insensitive, so these are the same ref.
    expect(isProtectedRef(ref)).toBe(true);
  });

  it.each(["main^{commit}", "main~1", "origin/main@{u}", "main:main"])(
    "reads the ref out of the revision expression %s",
    (ref) => {
      expect(isProtectedRef(ref)).toBe(true);
    },
  );

  it("refuses the empty string rather than treating it as unprotected", () => {
    // Not a ref at all. Whatever produced it is broken, and the safe reading
    // of a value that should never have arrived is refusal.
    expect(isProtectedRef("")).toBe(true);
    expect(isProtectedRef("   ")).toBe(true);
  });

  it.each(["fix/ssx-3822-favicon", "feat/new-quote-form", "origin/fix/ssx-1-x"])(
    "allows the work branch %s",
    (ref) => {
      expect(isProtectedRef(ref)).toBe(false);
    },
  );

  it("does not read a work prefix as a remote name", () => {
    // `feat/origin/thing` is a branch, not remote `feat`. Reading it the other
    // way would drop the prefix and change what the later checks see.
    expect(isProtectedRef("feat/origin/thing")).toBe(false);
  });
});

describe("isWorkBranch", () => {
  it.each([
    "fix/ssx-3822-favicon",
    "feat/quote-form",
    "chore/bump-config",
    "docs/readme",
    "test/add-coverage",
    "refactor/extract-helper",
    "perf/memoise-lookup",
  ])("accepts %s", (branch) => {
    expect(isWorkBranch(branch)).toBe(true);
  });

  it.each(["main", "master", "develop", "release/2026-09"])("refuses %s", (branch) => {
    expect(isWorkBranch(branch)).toBe(false);
  });

  it.each(["ssx-3822-favicon", "wip", "hack/quick"])(
    "refuses %s, which is not on the prefix allowlist",
    (branch) => {
      expect(isWorkBranch(branch)).toBe(false);
    },
  );

  it.each(["chore/main", "feat/release/2026-09", "fix/master"])(
    "refuses %s, which satisfies the allowlist while naming something protected",
    (branch) => {
      // This is the case an allowlist alone misses, and the reason both halves
      // are checked rather than one.
      expect(isWorkBranch(branch)).toBe(false);
    },
  );

  it.each(["fix/", "/main", "ci/pipeline", "build/output"])(
    "refuses the malformed %s",
    (branch) => {
      expect(isWorkBranch(branch)).toBe(false);
    },
  );
});

describe("assertWorkBranch", () => {
  it("says nothing when the branch is fine", () => {
    expect(() => {
      assertWorkBranch("fix/ssx-3822-favicon", "push target");
    }).not.toThrow();
  });

  it("names both the value and its role, because the caller cannot continue", () => {
    expect(() => {
      assertWorkBranch("main", "push target");
    }).toThrow(/push target "main" is not an implementation branch/u);
  });
});
