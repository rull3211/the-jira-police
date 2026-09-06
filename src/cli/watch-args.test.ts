import { describe, expect, it } from "vitest";

import type { WatchDecision } from "../watch/decide.ts";
import { describeDecision, watchKey, watchWrites } from "./watch-args.ts";

describe("watchKey", () => {
  it("reads one issue key", () => {
    expect(watchKey(["SSX-1234"])).toBe("SSX-1234");
  });

  it("reads no key as a sweep of the whole queue", () => {
    expect(watchKey([])).toBeNull();
  });

  it.each(["--write", "-v", "--dry-run"])("does not read %s as an issue key", (flag) => {
    // The one that matters on the day `--write` lands: read as a key, it would
    // look up a ticket called `--write`, find nothing, and report a clean sweep
    // — a typo that produces a plausible-looking success.
    expect(watchKey([flag])).toBeNull();
  });

  it("still finds the key beside a flag", () => {
    expect(watchKey(["--write", "SSX-1234"])).toBe("SSX-1234");
    expect(watchKey(["SSX-1234", "--write"])).toBe("SSX-1234");
  });

  it("refuses two keys rather than picking one", () => {
    // Taking the first and saying nothing would read as having looked at both,
    // which is the whole class of defect this repository is about.
    expect(() => watchKey(["SSX-1", "SSX-2"])).toThrow(/at most one issue key/);
  });
});

describe("watchWrites", () => {
  it("is off unless the flag is typed", () => {
    expect(watchWrites([])).toBe(false);
    expect(watchWrites(["SSX-1234"])).toBe(false);
  });

  it("is on with the flag, in either position", () => {
    expect(watchWrites(["--unsubscribe"])).toBe(true);
    expect(watchWrites(["SSX-1234", "--unsubscribe"])).toBe(true);
    expect(watchWrites(["--unsubscribe", "SSX-1234"])).toBe(true);
  });

  it.each(["--write", "--unsub", "unsubscribe", "--Unsubscribe"])(
    "does not accept %s as the flag",
    (flag) => {
      // A near miss must read as the dry run, not as the write. `--write` in
      // particular is the name the plan uses for the finished flag, so it is
      // the typo an operator is most likely to make, and guessing in the
      // direction of more privilege is the one guess never worth making.
      expect(watchWrites([flag])).toBe(false);
    },
  );
});

describe("describeDecision", () => {
  it("names the trigger and its time on a re-triage", () => {
    const decision: WatchDecision = {
      kind: "retriage",
      trigger: "description was edited",
      at: "2026-09-02T09:00:00.000+0200",
    };

    expect(describeDecision("SSX-1234", decision)).toBe(
      "RETRIAGE  SSX-1234  description was edited at 2026-09-02T09:00:00.000+0200",
    );
  });

  it("carries the reason on a drop, since that is the line a human has to act on", () => {
    const decision: WatchDecision = {
      kind: "unsubscribe",
      reason: "uncountable",
      note: "no comment this service wrote",
    };

    expect(describeDecision("SSX-1234", decision)).toContain("uncountable");
    expect(describeDecision("SSX-1234", decision)).toContain("no comment this service wrote");
  });

  it("keeps a quiet ticket to one scannable line", () => {
    expect(describeDecision("SSX-1234", { kind: "quiet" })).toBe("quiet     SSX-1234");
  });

  it("lines up the three prefixes so a sweep reads as a table", () => {
    const widths = [
      describeDecision("SSX-1", { kind: "retriage", trigger: "t", at: "a" }),
      describeDecision("SSX-1", { kind: "unsubscribe", reason: "closed", note: "n" }),
      describeDecision("SSX-1", { kind: "quiet" }),
    ].map((line) => line.indexOf("SSX-1"));

    expect(new Set(widths).size).toBe(1);
  });
});
