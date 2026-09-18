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

  it("always shows a line it could not parse, whatever the filter says", () => {
    // The whole point of keeping raw lines: narrowing to one source must not hide a stack trace,
    // which has no source to be narrowed to.
    const filter = { ...NO_FILTER, sources: new Set(["solve"]) };

    expect(passes(filter, { kind: "raw", text: "    at main ()" })).toBe(true);
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
