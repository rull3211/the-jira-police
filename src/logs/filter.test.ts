import { describe, expect, it } from "vitest";

import { NEWS_MARK, QUIET_MARK } from "../logger.ts";
import { NO_FILTER, isActive, passes, toggle } from "./filter.ts";
import type { Entry } from "./line.ts";

const log = (over: Partial<Extract<Entry, { kind: "log" }>> = {}): Entry => ({
  kind: "log",
  text: "",
  mark: NEWS_MARK,
  level: "info",
  src: "poll",
  message: "poll.done",
  ts: "",
  fields: {},
  ...over,
});

describe("passes", () => {
  it("shows everything when no axis has an opinion", () => {
    expect(passes(NO_FILTER, log())).toBe(true);
  });

  it("ANDs the three axes", () => {
    const filter = {
      marks: new Set([NEWS_MARK]),
      levels: new Set<"info">(["info"]),
      sources: new Set(["poll"]),
    };

    expect(passes(filter, log())).toBe(true);
    expect(passes(filter, log({ src: "jira" }))).toBe(false);
    expect(passes(filter, log({ level: "warn" }))).toBe(false);
    expect(passes(filter, log({ mark: QUIET_MARK }))).toBe(false);
  });

  it("always shows a line it could not parse, on every axis separately", () => {
    // The whole point of keeping raw lines: a stack trace has no source, no level and no mark, so
    // every axis would exclude it by default. One axis per assertion rather than one filter with
    // all three set — a filter that only consulted `sources` would pass that version of the test,
    // and the level axis is the one an operator reaches for first.
    const trace: Entry = { kind: "raw", text: "    at main ()" };

    expect(passes({ ...NO_FILTER, sources: new Set(["solve"]) }, trace)).toBe(true);
    expect(passes({ ...NO_FILTER, levels: new Set<"error">(["error"]) }, trace)).toBe(true);
    expect(passes({ ...NO_FILTER, marks: new Set([QUIET_MARK]) }, trace)).toBe(true);
  });

  it("shows a raw line even when all three axes are narrowed at once", () => {
    const filter = {
      marks: new Set([NEWS_MARK]),
      levels: new Set<"info">(["info"]),
      sources: new Set(["poll"]),
    };

    expect(passes(filter, { kind: "raw", text: "  ↳ SSX-1 sent back, no answer yet" })).toBe(true);
  });
});

describe("isActive", () => {
  it("reads an untouched axis as everything on", () => {
    expect(isActive(new Set(), "poll")).toBe(true);
  });

  it("reads a narrowed axis as only its members", () => {
    expect(isActive(new Set(["poll"]), "poll")).toBe(true);
    expect(isActive(new Set(["poll"]), "jira")).toBe(false);
  });
});

describe("toggle", () => {
  const all = ["a", "b", "c"];

  it("narrows to everything but the one clicked, starting from an untouched axis", () => {
    // The first click on a row where everything is on has to mean "not that one".
    expect([...toggle(new Set<string>(), all, "b")]).toEqual(["a", "c"]);
  });

  it("puts one back", () => {
    expect([...toggle(new Set(["a"]), all, "c")].toSorted()).toEqual(["a", "c"]);
  });

  it("clears the axis rather than leaving it empty", () => {
    // An empty row would be a blank screen with nothing on it explaining why.
    expect(toggle(new Set(["a"]), all, "a").size).toBe(0);
  });

  it("clears the axis when everything ends up selected, so `all` has one representation", () => {
    expect(toggle(new Set(["a", "b"]), all, "c").size).toBe(0);
  });
});
